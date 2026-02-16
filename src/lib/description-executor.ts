/**
 * PR/MR description generation executor
 *
 * This module handles generating descriptions for pull requests and merge requests
 * using the describe agent.
 */

import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import type { FileWithDiff } from './review-core.js';
import {
  buildDescribeInstructions,
  buildDescribeInstructionsFromSummaries,
} from './describe-core.js';
import { compressFilesWithDiffs } from './context-compression.js';
import { getCanonicalDiffCommand } from './repository-validator.js';
import type { PlatformClient, PullRequest } from './platform-client.js';
import {
  displayDescription,
  normalizeDescription,
  postDescription,
  type Description,
  type Platform,
} from './description-formatter.js';
import { parseDescribeOutput } from './describe-parser.js';
import type { PiClient } from '../pi/client.js';
import { collectFileChanges } from '../pi/subagent-adapter.js';

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
  opencode: PiClient,
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

  const instructions = await buildDescribeInstructionsWithSubagents(
    opencode,
    label,
    files,
    pr,
    workingDir,
    debug,
    config.describe?.concurrency
  );

  if (debug) {
    console.log(chalk.yellow('\n=== Describe Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  // Run describe agent
  const session = await opencode.createSession({
    agent: 'describe/pr-describer',
    message: instructions,
  });

  let fullResponse = '';
  for await (const message of opencode.streamMessages(session.id)) {
    if (message.role === 'assistant') {
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
  displayDescription(description, platform);

  if (shouldPostDescription) {
    await postDescription(platformClient, projectId, pr.number, description, platform);
  }

  return description;
}

/**
 * Build describe instructions using subagent-based file analysis.
 *
 * Spawns file-analyzer subagents in parallel to collect per-file change
 * summaries, then builds instructions from those summaries instead of
 * embedding raw diffs. This avoids context compression / token budget
 * trimming and provides full coverage of all changed files.
 */
async function buildDescribeInstructionsWithSubagents(
  opencode: PiClient,
  label: string,
  files: FileWithDiff[],
  pr: PullRequest,
  workingDir: string,
  debug?: boolean,
  concurrency?: number
): Promise<string> {
  const filenames = files.map((f) => f.filename);

  // Use the same diff command logic as the review pipeline, which handles
  // GitHub Actions (GITHUB_BASE_REF/GITHUB_HEAD_REF), GitLab CI, and
  // direct PR data with origin/ prefixes.
  const canonicalCommand = getCanonicalDiffCommand(pr, {});
  // Strip "git diff " prefix and " -- <file>" suffix to get just the ref args
  const diffCommand = canonicalCommand.replace(/^git diff\s+/, '').replace(/\s+--\s+<file>$/, '');

  const result = await collectFileChanges(opencode, filenames, diffCommand, workingDir, {
    concurrency,
    debug,
  });

  if (result.filesAnalyzed === 0) {
    console.log(
      chalk.yellow(
        '⚠ No files were successfully analyzed by subagents, falling back to direct mode.\n'
      )
    );
    const compression = compressFilesWithDiffs(files, {});
    return buildDescribeInstructions(label, compression.files);
  }

  return buildDescribeInstructionsFromSummaries(label, result.combinedMarkdown);
}
