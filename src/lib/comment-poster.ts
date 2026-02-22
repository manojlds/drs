/**
 * Comment posting utilities for PR/MR reviews
 *
 * This module handles posting review comments to GitHub and GitLab platforms,
 * including summary comments and inline code comments.
 */

import chalk from 'chalk';
import type { calculateSummary } from './comment-formatter.js';
import { formatSummaryComment, formatIssueComment, type ReviewIssue } from './comment-formatter.js';
import type { ChangeSummary } from './change-summary.js';
import {
  BOT_COMMENT_ID,
  createIssueFingerprint,
  findExistingSummaryComment,
  prepareIssuesForPosting,
  type PlatformComment,
} from './comment-manager.js';
import type { PlatformClient, LineValidator, InlineCommentPosition } from './platform-client.js';
import type { ReviewUsageSummary } from './review-usage.js';

/**
 * Post review comments to a PR/MR
 *
 * This function:
 * 1. Fetches existing comments to prevent duplicates
 * 2. Posts or updates a summary comment
 * 3. Posts inline comments for CRITICAL/HIGH severity issues
 * 4. Adds an "ai-reviewed" label
 */
export async function postReviewComments(
  platformClient: PlatformClient,
  projectId: string,
  prNumber: number,
  summary: ReturnType<typeof calculateSummary>,
  issues: ReviewIssue[],
  changeSummary: ChangeSummary | undefined,
  reviewUsage: ReviewUsageSummary | undefined,
  platformData: unknown,
  lineValidator?: LineValidator,
  createInlinePosition?: (issue: ReviewIssue, platformData: unknown) => InlineCommentPosition
): Promise<void> {
  console.log(chalk.gray('Fetching existing comments...\n'));

  // Fetch existing comments to prevent duplicates
  const [existingComments, existingInlineComments] = await Promise.all([
    platformClient.getComments(projectId, prNumber),
    platformClient.getInlineComments(projectId, prNumber),
  ]);

  // Find our existing summary comment
  const allComments: PlatformComment[] = [
    ...existingComments.map((c) => ({ id: c.id, body: c.body })),
    ...existingInlineComments.map((c) => ({ id: c.id, body: c.body })),
  ];

  const existingSummary = findExistingSummaryComment(
    existingComments.map((c) => ({ id: c.id, body: c.body }))
  );

  // Post or update summary comment
  console.log(chalk.gray('Posting review summary...\n'));
  const summaryComment = formatSummaryComment(
    summary,
    issues,
    BOT_COMMENT_ID,
    changeSummary,
    reviewUsage
  );

  if (existingSummary) {
    await platformClient.updateComment(projectId, prNumber, existingSummary.id, summaryComment);
    console.log(chalk.green('✓ Updated existing review summary'));
  } else {
    await platformClient.createComment(projectId, prNumber, summaryComment);
    console.log(chalk.green('✓ Posted new review summary'));
  }

  // Prepare issues for posting: filter to CRITICAL/HIGH, deduplicate, validate lines
  const criticalHighCount = issues.filter(
    (i) => i.severity === 'CRITICAL' || i.severity === 'HIGH'
  ).length;

  const prepared = prepareIssuesForPosting(issues, allComments, (issue) => {
    if (!issue.line || !lineValidator) return false;
    return lineValidator.isValidLine(issue.file, issue.line);
  });

  // Log diagnostic info about inline comment filtering
  logInlineCommentDiagnostics(
    criticalHighCount,
    prepared.deduplicatedCount,
    prepared.inlineIssues.length,
    issues
  );

  // Post inline comments for new CRITICAL/HIGH issues
  if (!createInlinePosition) {
    console.log(chalk.yellow(`⚠ Inline comments disabled (no position builder configured)\n`));
  }

  if (prepared.inlineIssues.length > 0 && createInlinePosition) {
    const inlineComments = prepared.inlineIssues.map((issue) => ({
      body: formatIssueComment(issue, createIssueFingerprint(issue)),
      position: createInlinePosition(issue, platformData),
    }));

    await platformClient.createBulkInlineComments(projectId, prNumber, inlineComments);
  }

  // Add ai-reviewed label
  await platformClient.addLabels(projectId, prNumber, ['ai-reviewed']);

  console.log(chalk.green('✓ Review posted\n'));
}

/**
 * Log diagnostic information about inline comment filtering
 */
function logInlineCommentDiagnostics(
  criticalHighCount: number,
  deduplicatedCount: number,
  inlineIssuesCount: number,
  allIssues: ReviewIssue[]
): void {
  if (criticalHighCount > 0) {
    console.log(chalk.gray(`Inline comments: ${criticalHighCount} CRITICAL/HIGH issue(s) found\n`));

    if (deduplicatedCount > 0) {
      console.log(chalk.gray(`  - ${deduplicatedCount} already commented (skipped)\n`));
    }

    const issuesWithoutLines = allIssues.filter(
      (i) =>
        (i.severity === 'CRITICAL' || i.severity === 'HIGH') &&
        (i.line === undefined || i.line === null)
    ).length;
    if (issuesWithoutLines > 0) {
      console.log(chalk.gray(`  - ${issuesWithoutLines} without line numbers (skipped)\n`));
    }

    const filteredByValidator =
      criticalHighCount - deduplicatedCount - issuesWithoutLines - inlineIssuesCount;
    if (filteredByValidator > 0) {
      console.log(chalk.gray(`  - ${filteredByValidator} on lines not in diff (skipped)\n`));
    }

    if (inlineIssuesCount > 0) {
      console.log(chalk.gray(`  → ${inlineIssuesCount} will be posted as inline comments\n`));
    } else {
      console.log(chalk.yellow(`  → No inline comments to post (all filtered)\n`));
    }
  } else {
    console.log(
      chalk.gray(`No CRITICAL/HIGH issues - skipping inline comments (only summary posted)\n`)
    );
  }
}
