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
import { prepareDiffsForAgent, formatCompressionSummary } from './context-compression.js';
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
import type { RuntimeClient } from '../opencode/client.js';

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
  const filteredFileNames = new Set(
    filterIgnoredFiles(
      files.map((f) => f.filename),
      config
    )
  );
  const filteredFiles = files.filter((f) => filteredFileNames.has(f.filename));
  const compression = prepareDiffsForAgent(filteredFiles, config.contextCompression);
  const compressionSummary = formatCompressionSummary(compression);

  if (compressionSummary) {
    console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
  }

  const includeProjectContext = config.describe?.includeProjectContext ?? true;
  const projectContext = includeProjectContext ? loadGlobalContext(workingDir) : null;
  const instructions = buildDescribeInstructions(
    label,
    compression.files,
    compressionSummary,
    projectContext ?? undefined
  );

  if (debug) {
    console.log(chalk.yellow('\n=== Describe Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  // Run describe agent
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

  // Parse agent output
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

  // Display and optionally post description
  const description = normalizeDescription(descriptionPayload);
  const platform = detectPlatform(pr);
  const usageSummary = aggregateAgentUsage([
    {
      ...usageByAgent,
      success: true,
    },
  ]);

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
