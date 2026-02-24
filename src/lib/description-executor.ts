/**
 * PR/MR description generation executor
 *
 * This module handles generating descriptions for pull requests and merge requests
 * using the describe agent.
 */

import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import type { FileWithDiff } from './review-core.js';
import { buildDescribeInstructions } from './describe-core.js';
import {
  prepareDiffsForAgent,
  formatCompressionSummary,
  resolveCompressionBudget,
} from './context-compression.js';
import { filterIgnoredFiles } from './review-orchestrator.js';
import { loadGlobalContext } from './context-loader.js';
import type { PlatformClient, PullRequest } from './platform-client.js';
import {
  displayDescription,
  normalizeDescription,
  postDescription,
  type Description,
  type Platform,
} from './description-formatter.js';
import { parseDescribeOutput } from './describe-parser.js';
import { aggregateAgentUsage, applyUsageMessage, createAgentUsageSummary } from './review-usage.js';
import type { RuntimeClient } from '../runtime/client.js';
import { getDescriberModelOverride } from './config.js';

/**
 * Pre-compressed diff data that can be passed to skip redundant compression.
 */
export interface PreCompressedDiffs {
  files: FileWithDiff[];
  compressionSummary: string;
}

/**
 * Detect platform type from PR/MR platform data
 */
export function detectPlatform(pr: PullRequest): Platform {
  const platformData = pr.platformData as Record<string, unknown> | undefined;
  if (platformData && ('iid' in platformData || 'diff_refs' in platformData)) {
    return 'MR';
  }
  return 'PR';
}

/**
 * Run the describe agent and return a normalized Description.
 * Platform-independent — handles compression, context loading, agent execution, and parsing.
 */
export interface DescribeAgentResult {
  description: Description;
  usage: ReturnType<typeof createAgentUsageSummary>;
}

export async function runDescribeAgent(
  runtimeClient: RuntimeClient,
  config: DRSConfig,
  label: string,
  files: FileWithDiff[],
  workingDir: string,
  debug?: boolean,
  preCompressed?: PreCompressedDiffs
): Promise<DescribeAgentResult> {
  let compressedFiles: FileWithDiff[];
  let compressionSummary: string;

  if (preCompressed) {
    // Use pre-compressed data from orchestrator (avoids duplicate compression)
    compressedFiles = preCompressed.files;
    compressionSummary = preCompressed.compressionSummary;
  } else {
    // Standalone describe — compress here
    const filteredFileNames = new Set(
      filterIgnoredFiles(
        files.map((f) => f.filename),
        config
      )
    );
    const filteredFiles = files.filter((f) => filteredFileNames.has(f.filename));
    const describeModelIds = [...new Set(Object.values(getDescriberModelOverride(config)))].filter(
      (id): id is string => !!id
    );
    const contextWindow = runtimeClient.getMinContextWindow(describeModelIds);
    const compressionOptions = resolveCompressionBudget(contextWindow, config.contextCompression);

    const compression = prepareDiffsForAgent(filteredFiles, compressionOptions);
    compressedFiles = compression.files;
    compressionSummary = formatCompressionSummary(compression);
  }

  if (compressionSummary) {
    console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
  }

  const includeProjectContext = config.describe?.includeProjectContext ?? true;
  const projectContext = includeProjectContext ? loadGlobalContext(workingDir) : null;
  const instructions = buildDescribeInstructions(
    label,
    compressedFiles,
    compressionSummary,
    projectContext ?? undefined
  );

  if (debug) {
    console.log(chalk.yellow('\n=== Describe Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  const agentType = 'describe/pr-describer';
  const session = await runtimeClient.createSession({
    agent: agentType,
    message: instructions,
  });

  let usageByAgent = createAgentUsageSummary(agentType);
  let fullResponse = '';
  for await (const message of runtimeClient.streamMessages(session.id)) {
    if (message.role === 'assistant') {
      usageByAgent = applyUsageMessage(usageByAgent, message);
      fullResponse += message.content;
    }
  }

  let descriptionPayload: Description;
  try {
    descriptionPayload = (await parseDescribeOutput(
      workingDir,
      debug,
      fullResponse
    )) as Description;
  } catch (parseError) {
    console.error(chalk.red('Failed to parse agent output as JSON'));
    console.log(chalk.dim('Agent output:'), fullResponse);
    const reason = parseError instanceof Error ? `: ${parseError.message}` : '';
    throw new Error(`Describe agent did not return valid JSON output${reason}`);
  }

  return { description: normalizeDescription(descriptionPayload), usage: usageByAgent };
}

/**
 * Generate and optionally post a PR/MR description
 *
 * @returns The generated description, or null if description generation is disabled
 */
export async function runDescribeIfEnabled(
  runtimeClient: RuntimeClient,
  config: DRSConfig,
  platformClient: PlatformClient,
  projectId: string,
  pr: PullRequest,
  files: FileWithDiff[],
  shouldPostDescription: boolean,
  workingDir: string,
  debug?: boolean
): Promise<Description | null> {
  console.log(chalk.bold.blue('\n🔍 Generating PR/MR Description\n'));

  const label = `${detectPlatform(pr)} #${pr.number}`;
  const { description, usage } = await runDescribeAgent(
    runtimeClient,
    config,
    label,
    files,
    workingDir,
    debug
  );

  const platform = detectPlatform(pr);
  const usageSummary = aggregateAgentUsage([{ ...usage, success: true }]);

  if (shouldPostDescription) {
    console.log(
      chalk.gray('Description generated (suppressed in logs because posting is enabled).')
    );
  } else {
    displayDescription(description, platform, usageSummary);
  }

  if (shouldPostDescription) {
    await postDescription(
      platformClient,
      projectId,
      pr.number,
      description,
      platform,
      usageSummary
    );
  }

  return description;
}
