import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import { parseDiff, getChangedFiles } from '../gitlab/diff-parser.js';
import {
  formatSummaryComment,
  formatIssueComment,
  calculateSummary,
  type ReviewIssue,
} from '../gitlab/comment-formatter.js';
import { parseReviewIssues } from '../lib/issue-parser.js';

export interface ReviewMROptions {
  projectId: string;
  mrIid: number;
  postComments: boolean;
}

/**
 * Review a GitLab merge request
 */
export async function reviewMR(config: DRSConfig, options: ReviewMROptions): Promise<void> {
  console.log(chalk.bold.cyan('\n📋 DRS | GitLab MR Analysis\n'));

  // Initialize GitLab client
  const gitlab = createGitLabClient();

  // Fetch MR details
  console.log(chalk.gray(`Fetching MR !${options.mrIid} from project ${options.projectId}...\n`));

  const mr = await gitlab.getMergeRequest(options.projectId, options.mrIid);
  const changes = await gitlab.getMRChanges(options.projectId, options.mrIid);

  console.log(chalk.bold(`MR: ${mr.title}`));
  console.log(chalk.gray(`Author: ${mr.author?.name || 'Unknown'}`));
  console.log(chalk.gray(`Branch: ${mr.source_branch} → ${mr.target_branch}`));
  console.log(chalk.gray(`Files changed: ${changes.length}\n`));

  if (changes.length === 0) {
    console.log(chalk.yellow('✓ No changes to review\n'));
    return;
  }

  // Parse diffs
  const diffs = changes.map((change) => parseDiff(change.diff)).flat();
  const changedFiles = getChangedFiles(diffs);

  // Connect to OpenCode (or start in-process if serverUrl is empty)
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  const opencode = await createOpencodeClientInstance({
    baseUrl: config.opencode.serverUrl || undefined,
  });

  // Create review session
  console.log(chalk.gray('Starting code analysis...\n'));

  const agentsList = config.review.agents.join(',');
  const session = await opencode.createSession({
    agent: 'gitlab-reviewer',
    message: `Review MR !${options.mrIid} in project ${options.projectId}. Agents: ${agentsList}. Files: ${changedFiles.join(', ')}`,
    context: {
      projectId: options.projectId,
      mrIid: options.mrIid,
      files: changedFiles,
      agents: config.review.agents,
      mr: {
        title: mr.title,
        description: mr.description,
        author: mr.author?.name,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
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

    // Post comments to GitLab if requested
    if (options.postComments) {
      console.log(chalk.gray('Posting review comments to GitLab...\n'));

      // Post summary comment
      const summaryComment = formatSummaryComment(summary, issues);
      await gitlab.createMRComment(options.projectId, options.mrIid, summaryComment);

      // Post individual issue comments as discussion threads
      for (const issue of issues) {
        const diffRefs: any = mr.diff_refs;
        if (issue.line && diffRefs?.base_sha && diffRefs.head_sha && diffRefs.start_sha) {
          try {
            await gitlab.createMRDiscussionThread(
              options.projectId,
              options.mrIid,
              formatIssueComment(issue),
              {
                baseSha: diffRefs.base_sha,
                headSha: diffRefs.head_sha,
                startSha: diffRefs.start_sha,
                newPath: issue.file,
                newLine: issue.line,
              }
            );
          } catch (error) {
            // If line-specific comment fails, post as general comment
            console.warn(
              chalk.yellow(`Warning: Could not post line comment for ${issue.file}:${issue.line}`)
            );
            await gitlab.createMRComment(
              options.projectId,
              options.mrIid,
              formatIssueComment(issue)
            );
          }
        } else {
          // Post as general comment if no line number
          await gitlab.createMRComment(options.projectId, options.mrIid, formatIssueComment(issue));
        }
      }

      // Add ai-reviewed label
      await gitlab.addLabel(options.projectId, options.mrIid, ['ai-reviewed']);

      console.log(chalk.green('✓ Review posted to GitLab MR\n'));
    }

    // Exit with error code if critical issues found
    if (summary.bySeverity.CRITICAL > 0) {
      console.log(chalk.red.bold('⚠️  Critical issues found!\n'));
      process.exit(1);
    } else if (summary.issuesFound === 0) {
      console.log(chalk.green('✓ No issues found! MR looks good.\n'));
    }
  } finally {
    // Clean up session and shutdown in-process server if applicable
    await opencode.closeSession(session.id);
    await opencode.shutdown();
  }
}
