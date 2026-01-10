import simpleGit from 'simple-git';
import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { parseDiff, getChangedFiles } from '../gitlab/diff-parser.js';
import { formatTerminalIssue } from '../gitlab/comment-formatter.js';
import {
  executeReview,
  displayReviewSummary,
  hasBlockingIssues,
  type ReviewSource,
} from '../lib/review-orchestrator.js';

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

  // Get diff (platform-specific: local git)
  console.log(chalk.gray(`Getting ${options.staged ? 'staged' : 'unstaged'} changes...\n`));

  const diffText = options.staged ? await git.diff(['--cached']) : await git.diff();

  if (!diffText || diffText.trim().length === 0) {
    console.log(chalk.yellow('✓ No changes to review\n'));
    return;
  }

  // Parse diff to get changed files
  const diffs = parseDiff(diffText);
  const changedFiles = getChangedFiles(diffs);

  if (changedFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review\n'));
    return;
  }

  // Execute review using common orchestrator
  const source: ReviewSource = {
    name: `Local ${options.staged ? 'staged' : 'unstaged'} diff`,
    files: changedFiles,
    context: {
      staged: options.staged,
    },
    workingDir: cwd,
  };

  const result = await executeReview(config, source);

  // Display results (platform-specific: terminal output)
  if (result.issues.length > 0) {
    displayReviewSummary(result);

    // Display issues in terminal
    for (const issue of result.issues) {
      console.log(formatTerminalIssue(issue));
    }

    // Recommendation
    if (hasBlockingIssues(result)) {
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
}
