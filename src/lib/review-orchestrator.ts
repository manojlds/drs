import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import { shouldIgnoreFile } from './config.js';
import { createOpencodeClientInstance, type OpencodeClient } from '../opencode/client.js';
import { parseReviewIssues } from './issue-parser.js';
import { calculateSummary, type ReviewIssue } from '../gitlab/comment-formatter.js';

/**
 * Source information for a review (platform-agnostic)
 */
export interface ReviewSource {
  /** Human-readable name for logging (e.g., "PR #123", "MR !456", "Local diff") */
  name: string;
  /** List of changed file paths */
  files: string[];
  /** Additional context to pass to review agents */
  context: Record<string, any>;
  /** Working directory for the review (defaults to process.cwd()) */
  workingDir?: string;
}

/**
 * Result of a review execution
 */
export interface ReviewResult {
  /** All issues found by review agents */
  issues: ReviewIssue[];
  /** Calculated summary statistics */
  summary: ReturnType<typeof calculateSummary>;
  /** Number of files actually reviewed (after filtering) */
  filesReviewed: number;
}

/**
 * Filter files based on ignore patterns in config
 */
export function filterIgnoredFiles(files: string[], config: DRSConfig): string[] {
  return files.filter((file) => !shouldIgnoreFile(file, config));
}

/**
 * Connect to OpenCode server (or start in-process)
 */
async function connectToOpenCode(config: DRSConfig, workingDir?: string): Promise<OpencodeClient> {
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  try {
    return await createOpencodeClientInstance({
      baseUrl: config.opencode.serverUrl || undefined,
      directory: workingDir || process.cwd(),
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
  const opencode = await connectToOpenCode(config, source.workingDir);

  try {
    // Create review session
    console.log(chalk.gray('Starting code analysis...\n'));

    const agentsList = config.review.agents.join(',');
    const session = await opencode.createSession({
      agent: 'code-reviewer',
      message: `Review ${source.name}. Agents: ${agentsList}. Files: ${filteredFiles.join(', ')}`,
      context: {
        ...source.context,
        files: filteredFiles,
        agents: config.review.agents,
      },
    });

    // Stream messages and collect issues
    const issues: ReviewIssue[] = [];

    for await (const message of opencode.streamMessages(session.id)) {
      if (message.role === 'assistant') {
        // Display agent output in real-time
        console.log(message.content);

        // Parse structured issues from agent responses
        const parsedIssues = parseReviewIssues(message.content);
        if (parsedIssues.length > 0) {
          issues.push(...parsedIssues);
          console.log(chalk.gray(`\n[Parsed ${parsedIssues.length} issue(s) from response]\n`));
        }
      }
    }

    // Calculate summary
    const summary = calculateSummary(filteredFiles.length, issues);

    // Clean up session
    await opencode.closeSession(session.id);

    return {
      issues,
      summary,
      filesReviewed: filteredFiles.length,
    };
  } finally {
    // Always shut down OpenCode client
    await opencode.shutdown();
  }
}

/**
 * Display review summary to terminal (common formatting)
 */
export function displayReviewSummary(result: ReviewResult): void {
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📊 Review Summary'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(`  Files reviewed: ${chalk.cyan(result.summary.filesReviewed)}`);
  console.log(`  Issues found: ${chalk.yellow(result.summary.issuesFound)}`);

  if (result.summary.issuesFound > 0) {
    console.log(`    🔴 Critical: ${chalk.red(result.summary.bySeverity.CRITICAL)}`);
    console.log(`    🟡 High: ${chalk.yellow(result.summary.bySeverity.HIGH)}`);
    console.log(`    🟠 Medium: ${chalk.hex('#FFA500')(result.summary.bySeverity.MEDIUM)}`);
    console.log(`    ⚪ Low: ${chalk.gray(result.summary.bySeverity.LOW)}`);
  }

  console.log('');
}

/**
 * Check if review has blocking issues (CRITICAL or HIGH)
 */
export function hasBlockingIssues(result: ReviewResult): boolean {
  return result.summary.bySeverity.CRITICAL > 0 || result.summary.bySeverity.HIGH > 0;
}
