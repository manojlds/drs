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
import { filterIgnoredFiles } from '../lib/review-orchestrator.js';
import {
  BOT_COMMENT_ID,
  createIssueFingerprint,
  findExistingSummaryComment,
  prepareIssuesForPosting,
  type PlatformComment,
} from '../lib/comment-manager.js';

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
  const allChangedFiles = getChangedFiles(diffs);

  // Filter files based on ignore patterns
  const changedFiles = filterIgnoredFiles(allChangedFiles, config);
  const ignoredCount = allChangedFiles.length - changedFiles.length;

  if (ignoredCount > 0) {
    console.log(
      chalk.gray(
        `Ignoring ${ignoredCount} file(s) based on patterns (${config.review.ignorePatterns.join(', ')})\n`
      )
    );
  }

  if (changedFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return;
  }

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
      console.log(chalk.gray('Fetching existing comments from MR...\n'));

      // Fetch existing comments to prevent duplicates
      const [existingNotes, existingDiscussions] = await Promise.all([
        gitlab.getMRNotes(options.projectId, options.mrIid),
        gitlab.getMRDiscussions(options.projectId, options.mrIid),
      ]);

      // Convert to platform-agnostic format
      const allExistingComments: PlatformComment[] = [
        ...existingNotes.map((n) => ({ id: n.id, body: n.body })),
        ...existingDiscussions.flatMap((d) =>
          (d.notes || []).map((n) => ({ id: n.id, body: n.body }))
        ),
      ];

      // Find existing summary comment
      const existingSummary = findExistingSummaryComment(allExistingComments);

      // Post or update summary comment
      console.log(chalk.gray('Posting review summary to GitLab...\n'));
      const summaryComment = formatSummaryComment(summary, issues, BOT_COMMENT_ID);

      if (existingSummary) {
        await gitlab.updateMRNote(
          options.projectId,
          options.mrIid,
          Number(existingSummary.id),
          summaryComment
        );
        console.log(chalk.green('✓ Updated existing review summary'));
      } else {
        await gitlab.createMRComment(options.projectId, options.mrIid, summaryComment);
        console.log(chalk.green('✓ Posted new review summary to MR'));
      }

      // Prepare issues for posting: filter to CRITICAL/HIGH, deduplicate
      const diffRefs: any = mr.diff_refs;
      const prepared = prepareIssuesForPosting(issues, allExistingComments, (issue) => {
        // For GitLab, we can post on any line with valid diff_refs
        return (
          issue.line !== undefined && diffRefs?.base_sha && diffRefs.head_sha && diffRefs.start_sha
        );
      });

      if (prepared.deduplicatedCount > 0) {
        console.log(
          chalk.gray(`Skipped ${prepared.deduplicatedCount} duplicate issue(s) already commented\n`)
        );
      }

      // Post inline comments for new CRITICAL/HIGH issues
      if (
        prepared.inlineIssues.length > 0 &&
        diffRefs?.base_sha &&
        diffRefs.head_sha &&
        diffRefs.start_sha
      ) {
        console.log(
          chalk.gray(
            `\nPosting ${prepared.inlineIssues.length} new inline comment(s) as discussion threads...\n`
          )
        );

        for (const issue of prepared.inlineIssues) {
          try {
            await gitlab.createMRDiscussionThread(
              options.projectId,
              options.mrIid,
              formatIssueComment(issue, createIssueFingerprint(issue)),
              {
                baseSha: diffRefs.base_sha,
                headSha: diffRefs.head_sha,
                startSha: diffRefs.start_sha,
                newPath: issue.file,
                newLine: issue.line!,
              }
            );
            console.log(chalk.gray(`  ✓ Posted inline comment for ${issue.file}:${issue.line}`));
          } catch (error) {
            // If line-specific comment fails, post as general comment
            console.warn(
              chalk.yellow(`  ⚠ Could not post line comment for ${issue.file}:${issue.line}`)
            );
            await gitlab.createMRComment(
              options.projectId,
              options.mrIid,
              formatIssueComment(issue, createIssueFingerprint(issue))
            );
          }
        }

        console.log(chalk.green(`✓ Posted ${prepared.inlineIssues.length} inline comment(s)`));
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
