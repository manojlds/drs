import simpleGit from 'simple-git';
import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { parseDiff, getChangedFiles } from '../gitlab/diff-parser.js';
import {
  formatTerminalIssue,
  calculateSummary,
  type ReviewIssue,
} from '../gitlab/comment-formatter.js';
import { parseReviewIssues } from '../lib/issue-parser.js';

export interface ReviewLocalOptions {
  staged: boolean;
}

/**
 * Review local git diff before pushing
 */
export async function reviewLocal(config: DRSConfig, options: ReviewLocalOptions): Promise<void> {
  console.log(chalk.bold.cyan('\n📋 DRS | Local Diff Analysis\n'));

  const git = simpleGit();
  const cwd = process.cwd();

  // Check if we're in a git repository
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not a git repository. Run this command from within a git repository.');
  }

  // Get diff
  console.log(chalk.gray(`Getting ${options.staged ? 'staged' : 'unstaged'} changes...\n`));

  const diffText = options.staged ? await git.diff(['--cached']) : await git.diff();

  if (!diffText || diffText.trim().length === 0) {
    console.log(chalk.yellow('✓ No changes to review\n'));
    return;
  }

  // Parse diff
  const diffs = parseDiff(diffText);
  const changedFiles = getChangedFiles(diffs);

  if (changedFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review\n'));
    return;
  }

  console.log(chalk.gray(`Found ${changedFiles.length} changed file(s)\n`));

  // Connect to OpenCode (or start in-process if serverUrl is empty)
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  const opencode = await createOpencodeClientInstance({
    baseUrl: config.opencode.serverUrl || undefined,
    directory: cwd,
  });

  // Create review session
  console.log(chalk.gray('Starting code analysis...\n'));

  const agentsList = config.review.agents.join(',');
  const session = await opencode.createSession({
    agent: 'local-reviewer',
    message: `Review local diff with agents: ${agentsList}. Files: ${changedFiles.join(', ')}`,
    context: {
      files: changedFiles,
      agents: config.review.agents,
      staged: options.staged,
    },
  });

  // Stream and display results
  const issues: ReviewIssue[] = [];

  try {
    for await (const message of opencode.streamMessages(session.id)) {
      if (message.role === 'assistant') {
        // Display message content
        console.log(message.content);

        // Parse structured issues from agent responses
        const parsedIssues = parseReviewIssues(message.content);
        if (parsedIssues.length > 0) {
          issues.push(...parsedIssues);
          console.log(chalk.gray(`\n[Parsed ${parsedIssues.length} issue(s) from response]\n`));
        }
      }
    }

    // Display summary
    if (issues.length > 0) {
      console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.bold('📊 Review Summary'));
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

      const summary = calculateSummary(changedFiles.length, issues);

      console.log(`  Files reviewed: ${chalk.cyan(summary.filesReviewed)}`);
      console.log(`  Issues found: ${chalk.yellow(summary.issuesFound)}`);

      if (summary.issuesFound > 0) {
        console.log(`    🔴 Critical: ${chalk.red(summary.bySeverity.CRITICAL)}`);
        console.log(`    🟡 High: ${chalk.yellow(summary.bySeverity.HIGH)}`);
        console.log(`    🟠 Medium: ${chalk.hex('#FFA500')(summary.bySeverity.MEDIUM)}`);
        console.log(`    ⚪ Low: ${chalk.gray(summary.bySeverity.LOW)}`);
      }

      console.log('');

      // Display issues
      for (const issue of issues) {
        console.log(formatTerminalIssue(issue));
      }

      // Recommendation
      const hasCritical = summary.bySeverity.CRITICAL > 0;
      const hasHigh = summary.bySeverity.HIGH > 0;

      if (hasCritical || hasHigh) {
        console.log(
          chalk.red.bold('\n⚠️  Recommendation: Fix critical/high issues before pushing\n')
        );
        process.exit(1);
      } else {
        console.log(chalk.green('\n✓ No critical issues found. Safe to push.\n'));
      }
    } else {
      console.log(chalk.green('\n✓ No issues found! Code looks good.\n'));
    }
  } finally {
    // Clean up session and shutdown in-process server if applicable
    await opencode.closeSession(session.id);
    await opencode.shutdown();
  }
}
