/**
 * Review orchestrator for local diff reviews
 *
 * This module handles local git diff reviews (pre-push analysis).
 * It uses the shared core logic from review-core.ts.
 */

import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import type { ChangeSummary } from './change-summary.js';
import {
  shouldIgnoreFile,
  getModelOverrides,
  getDefaultModel,
  getDescriberModelOverride,
  getRuntimeConfig,
  getUnifiedModelOverride,
  type ModelOverrides,
} from './config.js';
import { createRuntimeClientInstance, type RuntimeClient } from '../opencode/client.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import {
  buildBaseInstructions,
  runReviewPipeline,
  displayReviewSummary as displaySummary,
  hasBlockingIssues as checkBlockingIssues,
  type FileWithDiff,
} from './review-core.js';
import {
  prepareDiffsForAgent,
  formatCompressionSummary,
  resolveCompressionBudget,
} from './context-compression.js';
import { createEmptyReviewUsageSummary, type ReviewUsageSummary } from './review-usage.js';
import { runDescribeAgent } from './description-executor.js';
import { formatDescribeSummary } from './description-formatter.js';

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
  /** Debug mode - print Pi runtime configuration */
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
  changeSummary?: ChangeSummary;
  /** Number of files actually reviewed (after filtering) */
  filesReviewed: number;
  /** Token usage and cost details for the review run */
  usage?: ReviewUsageSummary;
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
 * Connect to Pi runtime (in-process by default)
 */
export async function connectToRuntime(
  config: DRSConfig,
  workingDir?: string,
  options?: ConnectOptions
): Promise<RuntimeClient> {
  console.log(chalk.gray('Connecting to Pi runtime...\n'));

  try {
    // Get model overrides from DRS config
    const modelOverrides = options?.modelOverrides ?? {
      ...getModelOverrides(config),
      ...getUnifiedModelOverride(config),
    };

    const runtimeConfig = getRuntimeConfig(config);
    const configuredRuntimeEndpoint =
      runtimeConfig.serverUrl ?? process.env.PI_SERVER ?? process.env.OPENCODE_SERVER ?? undefined;

    if (configuredRuntimeEndpoint) {
      console.log(
        chalk.yellow(
          `⚠ Ignoring configured runtime endpoint (${configuredRuntimeEndpoint}). DRS uses Pi SDK in-process only.\n`
        )
      );
    }

    return await createRuntimeClientInstance({
      directory: workingDir ?? process.cwd(),
      modelOverrides,
      provider: runtimeConfig.provider,
      config,
      debug: options?.debug,
    });
  } catch (error) {
    console.error(chalk.red('✗ Failed to connect to Pi runtime'));
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
    console.log(
      chalk.yellow('Please check your Pi runtime configuration and model credentials.\n')
    );
    throw error;
  }
}

/**
 * Execute a code review using Pi runtime agents.
 *
 * This is the core review orchestrator that handles:
 * - File filtering (ignore patterns)
 * - Pi runtime connection
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
      usage: createEmptyReviewUsageSummary(),
    };
  }

  console.log(chalk.gray(`Reviewing ${filteredFiles.length} file(s)\n`));

  // Include describer model overrides if describe is enabled
  const describeEnabled = config.review.describe?.enabled ?? false;
  const describeOverrides = describeEnabled ? getDescriberModelOverride(config) : {};
  const reviewOverrides = {
    ...getModelOverrides(config),
    ...getUnifiedModelOverride(config),
    ...describeOverrides,
  };

  // Connect to Pi runtime
  const runtimeClient = await connectToRuntime(config, source.workingDir, {
    debug: source.debug,
    modelOverrides: reviewOverrides,
  });

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

    // Run describe pass if enabled — gives review agents change context
    let describeSummary: string | undefined;
    if (describeEnabled && filesForInstructions.some((f) => f.patch)) {
      try {
        console.log(chalk.bold.blue('🔍 Running describe pass for change context\n'));
        const { description } = await runDescribeAgent(
          runtimeClient,
          config,
          source.name,
          filesForInstructions,
          source.workingDir ?? process.cwd(),
          source.debug
        );
        describeSummary = formatDescribeSummary(description);
      } catch (describeError) {
        console.warn(
          chalk.yellow(
            `⚠ Describe pass failed, continuing review without change context: ${describeError instanceof Error ? describeError.message : String(describeError)}\n`
          )
        );
      }
    }

    const modelIds = [
      ...new Set([
        ...Object.values(getModelOverrides(config)),
        ...Object.values(getUnifiedModelOverride(config)),
        getDefaultModel(config),
      ]),
    ].filter((id): id is string => !!id);
    const contextWindow = runtimeClient.getMinContextWindow(modelIds);
    const compressionOptions = resolveCompressionBudget(contextWindow, config.contextCompression);

    const compression = prepareDiffsForAgent(filesForInstructions, compressionOptions);
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
      runtimeClient,
      config,
      baseInstructions,
      source.name,
      filteredFiles,
      { ...source.context, describeSummary },
      source.workingDir ?? process.cwd(),
      source.debug ?? false
    );

    return {
      issues: result.issues,
      summary: result.summary,
      changeSummary: result.changeSummary,
      filesReviewed: result.filesReviewed,
      usage: result.usage ?? createEmptyReviewUsageSummary(),
    };
  } catch (error) {
    // Handle "all agents failed" error
    if (error instanceof Error && error.message === 'All review agents failed') {
      await runtimeClient.shutdown();
      process.exit(1);
    }
    throw error;
  } finally {
    // Always shut down Pi runtime client
    await runtimeClient.shutdown();
  }
}

/**
 * @deprecated Use connectToRuntime.
 */
export const connectToOpenCode = connectToRuntime;

// Re-export display functions from core for backward compatibility
export const displayReviewSummary = displaySummary;
export const hasBlockingIssues = checkBlockingIssues;
