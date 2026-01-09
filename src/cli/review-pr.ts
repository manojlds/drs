import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { parseDiff, getChangedFiles } from '../gitlab/diff-parser.js';
import {
  formatSummaryComment,
  formatIssueComment,
  calculateSummary,
  type ReviewIssue,
} from '../gitlab/comment-formatter.js';
import { parseReviewIssues } from '../lib/issue-parser.js';

export interface ReviewPROptions {
  owner: string;
  repo: string;
  prNumber: number;
  postComments: boolean;
}

/**
 * Review a GitHub pull request
 */
export async function reviewPR(config: DRSConfig, options: ReviewPROptions): Promise<void> {
  console.log(chalk.bold.cyan('\n🔍 DRS GitHub PR Review\n'));

  // Initialize GitHub client
  const github = createGitHubClient();

  // Fetch PR details
  console.log(chalk.gray(`Fetching PR #${options.prNumber} from ${options.owner}/${options.repo}...\n`));

  const pr = await github.getPullRequest(options.owner, options.repo, options.prNumber);
  const files = await github.getPRFiles(options.owner, options.repo, options.prNumber);

  console.log(chalk.bold(`PR: ${pr.title}`));
  console.log(chalk.gray(`Author: ${pr.user?.login || 'Unknown'}`));
  console.log(chalk.gray(`Branch: ${pr.head.ref} → ${pr.base.ref}`));
  console.log(chalk.gray(`Files changed: ${files.length}\n`));

  if (files.length === 0) {
    console.log(chalk.yellow('✓ No changes to review\n'));
    return;
  }

  // Parse diffs
  const diffs = files
    .filter(file => file.patch) // Only files with diffs
    .map(file => parseDiff(file.patch || ''))
    .flat();

  const changedFiles = getChangedFiles(diffs);

  // Connect to OpenCode (or start in-process if serverUrl is empty)
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  const opencode = await createOpencodeClientInstance({
    baseUrl: config.opencode.serverUrl || undefined,
  });

  // Create review session
  console.log(chalk.gray('Starting AI review...\n'));

  const agentsList = config.review.agents.join(',');
  const session = await opencode.createSession({
    agent: 'github-reviewer',
    message: `Review PR #${options.prNumber} in ${options.owner}/${options.repo}. Agents: ${agentsList}. Files: ${changedFiles.join(', ')}`,
    context: {
      owner: options.owner,
      repo: options.repo,
      prNumber: options.prNumber,
      files: changedFiles,
      agents: config.review.agents,
      pr: {
        title: pr.title,
        description: pr.body,
        author: pr.user?.login,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
      },
    },
  });

  // Stream and collect results
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

    // Display and post summary
    const summary = calculateSummary(changedFiles.length, issues);

    console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('📊 Review Summary'));
    console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    console.log(`  Files reviewed: ${chalk.cyan(summary.filesReviewed)}`);
    console.log(`  Issues found: ${chalk.yellow(summary.issuesFound)}`);

    if (summary.issuesFound > 0) {
      console.log(`    🔴 Critical: ${chalk.red(summary.bySeverity.CRITICAL)}`);
      console.log(`    🟡 High: ${chalk.yellow(summary.bySeverity.HIGH)}`);
      console.log(`    🟠 Medium: ${chalk.hex('#FFA500')(summary.bySeverity.MEDIUM)}`);
      console.log(`    ⚪ Low: ${chalk.gray(summary.bySeverity.LOW)}`);
    }

    console.log('');

    // Post comments to GitHub if requested
    if (options.postComments) {
      console.log(chalk.gray('Posting review comments to GitHub...\n'));

      // Post summary comment
      const summaryComment = formatSummaryComment(summary, issues);
      await github.createPRComment(options.owner, options.repo, options.prNumber, summaryComment);

      // Post individual issue comments as review comments
      for (const issue of issues) {
        if (issue.line && pr.head.sha) {
          try {
            await github.createPRReviewComment(
              options.owner,
              options.repo,
              options.prNumber,
              formatIssueComment(issue),
              pr.head.sha,
              issue.file,
              issue.line
            );
          } catch (error) {
            // If line-specific comment fails, post as general comment
            console.warn(chalk.yellow(`Warning: Could not post line comment for ${issue.file}:${issue.line}`));
            await github.createPRComment(
              options.owner,
              options.repo,
              options.prNumber,
              formatIssueComment(issue)
            );
          }
        } else {
          // Post as general comment if no line number
          await github.createPRComment(
            options.owner,
            options.repo,
            options.prNumber,
            formatIssueComment(issue)
          );
        }
      }

      // Add ai-reviewed label
      await github.addLabels(options.owner, options.repo, options.prNumber, ['ai-reviewed']);

      console.log(chalk.green('✓ Review posted to GitHub PR\n'));
    }

    // Exit with error code if critical issues found
    if (summary.bySeverity.CRITICAL > 0) {
      console.log(chalk.red.bold('⚠️  Critical issues found!\n'));
      process.exit(1);
    } else if (summary.issuesFound === 0) {
      console.log(chalk.green('✓ No issues found! PR looks good.\n'));
    }
  } finally {
    // Clean up session and shutdown in-process server if applicable
    await opencode.closeSession(session.id);
    await opencode.shutdown();
  }
}
