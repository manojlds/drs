/**
 * Review orchestrator for local diff reviews
 *
 * This module handles local git diff reviews (pre-push analysis).
 * It uses the shared core logic from review-core.ts.
 */

import chalk from 'chalk';
import { readFile, writeFile } from 'fs/promises';
import type { DRSConfig } from './config.js';
import { shouldIgnoreFile, getModelOverrides } from './config.js';
import { createOpencodeClientInstance, type OpencodeClient } from '../opencode/client.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import {
  buildBaseInstructions,
  runReviewAgents,
  analyzeDiffContext,
  displayReviewSummary as displaySummary,
  hasBlockingIssues as checkBlockingIssues,
  buildDiffAnalyzerContext,
  normalizeDiffAnalysis,
  type FileWithDiff,
  type DiffAnalysis,
} from './review-core.js';

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
  context: Record<string, any>;
  /** Working directory for the review (defaults to process.cwd()) */
  workingDir?: string;
  /** Debug mode - print OpenCode configuration */
  debug?: boolean;
  /** Whether this is a staged diff (affects git diff command) */
  staged?: boolean;
  /** Run only diff analyzer and skip review agents */
  contextOnly?: boolean;
  /** Write diff analysis JSON to this path (if produced or loaded) */
  contextOutputPath?: string;
  /** Read diff analysis JSON from this path instead of running analyzer */
  contextReadPath?: string;
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
    const modelOverrides = getModelOverrides(config);

    return await createOpencodeClientInstance({
      baseUrl: config.opencode.serverUrl || undefined,
      directory: workingDir || process.cwd(),
      modelOverrides,
      provider: config.opencode.provider,
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
    const diffCommand = source.staged ? 'git diff --cached -- <file>' : 'git diff HEAD~1 -- <file>';

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

    const baseInstructions = buildBaseInstructions(source.name, filesForInstructions, diffCommand);
    const diffAnalyzerContext = buildDiffAnalyzerContext(
      source.name,
      filesForInstructions,
      diffCommand
    );

    // Obtain diff analysis: from file, or by running analyzer
    let diffAnalysis: DiffAnalysis | null = null;

    if (source.contextReadPath) {
      try {
        const raw = await readFile(source.contextReadPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const normalized = normalizeDiffAnalysis(parsed);
        if (normalized.analysis) {
          diffAnalysis = normalized.analysis;
          if (normalized.warnings.length > 0) {
            console.log(
              chalk.yellow(`⚠️  Diff context normalized output: ${normalized.warnings.join('; ')}`)
            );
          }
          console.log(chalk.green(`✓ Loaded diff context from ${source.contextReadPath}`));
        } else {
          console.log(
            chalk.yellow(
              `⚠️  Invalid diff context in ${source.contextReadPath}: ${normalized.errors.join('; ')}`
            )
          );
        }
      } catch (err) {
        console.log(
          chalk.yellow(
            `⚠️  Failed to read context from ${source.contextReadPath}: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    } else if (config.review.enableDiffAnalyzer && filesForInstructions.some((f) => f.patch)) {
      diffAnalysis = await analyzeDiffContext(
        opencode,
        config,
        diffAnalyzerContext,
        source.name,
        filteredFiles,
        source.workingDir || process.cwd(),
        source.context,
        source.debug || false
      );
    }

    // Optionally write diff context
    if (source.contextOutputPath && diffAnalysis) {
      try {
        await writeFile(source.contextOutputPath, JSON.stringify(diffAnalysis, null, 2), 'utf-8');
        console.log(chalk.green(`✓ Diff context written to ${source.contextOutputPath}\n`));
      } catch (err) {
        console.log(
          chalk.yellow(
            `⚠️  Failed to write diff context to ${source.contextOutputPath}: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    }

    if (source.contextOnly) {
      console.log(chalk.gray('Context-only mode: skipping review agents and comments.\n'));
      return {
        issues: [],
        summary: calculateSummary(filteredFiles.length, []),
        changeSummary: diffAnalysis?.changeSummary,
        filesReviewed: filteredFiles.length,
      };
    }

    // Run agents using shared core logic
    const result = await runReviewAgents(
      opencode,
      config,
      baseInstructions,
      source.name,
      filteredFiles,
      source.context,
      diffAnalysis,
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
