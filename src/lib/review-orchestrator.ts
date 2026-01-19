/**
 * Review orchestrator for local diff reviews
 *
 * This module handles local git diff reviews (pre-push analysis).
 * It uses the shared core logic from review-core.ts.
 */

import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import {
  shouldIgnoreFile,
  getModelOverrides,
  getUnifiedModelOverride,
  type ModelOverrides,
} from './config.js';
import { createOpencodeClientInstance, type OpencodeClient } from '../opencode/client.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import {
  buildBaseInstructions,
  runReviewPipeline,
  displayReviewSummary as displaySummary,
  hasBlockingIssues as checkBlockingIssues,
  type FileWithDiff,
} from './review-core.js';
import { compressFilesWithDiffs, formatCompressionSummary } from './context-compression.js';

/**
 * Source information for a review (platform-agnostic)
 */
export interface ReviewSource {
  /** Human-readable name for logging (e.g., "PR #123", "MR !456", "Local diff") */
  name: string;
  /** List of changed file paths */
  files: string[];
  /** Optional: files with their diff patches (if available, passed directly to agents) */
  filesWithDiffs?: Array<{ filename: string; patch: string }>;
  /** Additional context to pass to review agents */
  context: Record<string, unknown>;
  /** Working directory for the review (defaults to process.cwd()) */
  workingDir?: string;
  /** Debug mode - print OpenCode configuration */
  debug?: boolean;
  /** Whether this is a staged diff (affects git diff command) */
  staged?: boolean;
}

/**
 * Result of a review execution
 */
export interface ReviewResult {
  /** All issues found by review agents */
  issues: ReviewIssue[];
  /** Calculated summary statistics */
  summary: ReturnType<typeof calculateSummary>;
  /** Diff-based change summary when available */
  changeSummary?: import('./change-summary.js').ChangeSummary;
  /** Number of files actually reviewed (after filtering) */
  filesReviewed: number;
}

/**
 * Filter files based on ignore patterns in config
 */
export function filterIgnoredFiles(files: string[], config: DRSConfig): string[] {
  return files.filter((file) => !shouldIgnoreFile(file, config));
}

export interface ConnectOptions {
  debug?: boolean;
  modelOverrides?: ModelOverrides;
}

/**
 * Connect to OpenCode server (or start in-process)
 */
export async function connectToOpenCode(
  config: DRSConfig,
  workingDir?: string,
  options?: ConnectOptions
): Promise<OpencodeClient> {
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  try {
    // Get model overrides from DRS config
    const modelOverrides = options?.modelOverrides ?? {
      ...getModelOverrides(config),
      ...getUnifiedModelOverride(config),
    };

    return await createOpencodeClientInstance({
      baseUrl: config.opencode.serverUrl || undefined,
      directory: workingDir || process.cwd(),
      modelOverrides,
      provider: config.opencode.provider,
      config,
      debug: options?.debug,
    });
  } catch (error) {
    console.error(chalk.red('✗ Failed to connect to OpenCode server'));
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
    console.log(
      chalk.yellow('Please ensure OpenCode server is running or check your configuration.\n')
    );
    throw error;
  }
}

/**
 * Execute a code review using OpenCode agents
 *
 * This is the core review orchestrator that handles:
 * - File filtering (ignore patterns)
 * - OpenCode connection
 * - Agent execution and streaming
 * - Issue parsing and collection
 * - Summary calculation
 *
 * Platform-specific logic (GitHub/GitLab/local) should:
 * 1. Fetch changed files from their source
 * 2. Call this function with a ReviewSource
 * 3. Handle posting results to their platform
 */
export async function executeReview(
  config: DRSConfig,
  source: ReviewSource
): Promise<ReviewResult> {
  console.log(chalk.gray(`Found ${source.files.length} changed file(s)\n`));

  // Filter files based on ignore patterns
  const filteredFiles = filterIgnoredFiles(source.files, config);
  const ignoredCount = source.files.length - filteredFiles.length;

  if (ignoredCount > 0) {
    console.log(chalk.gray(`Ignoring ${ignoredCount} file(s) based on patterns\n`));
  }

  if (filteredFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return {
      issues: [],
      summary: calculateSummary(0, []),
      filesReviewed: 0,
    };
  }

  console.log(chalk.gray(`Reviewing ${filteredFiles.length} file(s)\n`));

  // Connect to OpenCode
  const opencode = await connectToOpenCode(config, source.workingDir, { debug: source.debug });

  try {
    // Build instructions - use provided diffs if available, otherwise fall back to git command
    const diffCommand = source.staged ? 'git diff --cached -- <file>' : 'git diff -- <file>';

    // Use provided diffs if available (filtered to match filteredFiles)
    let filesForInstructions: FileWithDiff[];
    if (source.filesWithDiffs && source.filesWithDiffs.length > 0) {
      // Filter to only include files that passed ignore patterns
      filesForInstructions = source.filesWithDiffs.filter((f) =>
        filteredFiles.includes(f.filename)
      );
    } else {
      // No diffs provided - agents will need to run git diff
      filesForInstructions = filteredFiles.map((f) => ({ filename: f }));
    }

    const compression = compressFilesWithDiffs(filesForInstructions, config.contextCompression);
    const compressionSummary = formatCompressionSummary(compression);

    if (compressionSummary) {
      console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
    }

    const baseInstructions = buildBaseInstructions(
      source.name,
      compression.files,
      diffCommand,
      compressionSummary
    );

    // Run agents using shared core logic
    const result = await runReviewPipeline(
      opencode,
      config,
      baseInstructions,
      source.name,
      filteredFiles,
      source.context,
      source.workingDir || process.cwd(),
      source.debug || false
    );

    return {
      issues: result.issues,
      summary: result.summary,
      changeSummary: result.changeSummary,
      filesReviewed: result.filesReviewed,
    };
  } catch (error) {
    // Handle "all agents failed" error
    if (error instanceof Error && error.message === 'All review agents failed') {
      await opencode.shutdown();
      process.exit(1);
    }
    throw error;
  } finally {
    // Always shut down OpenCode client
    await opencode.shutdown();
  }
}

// Re-export display functions from core for backward compatibility
export const displayReviewSummary = displaySummary;
export const hasBlockingIssues = checkBlockingIssues;
