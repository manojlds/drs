/**
 * Comment posting utilities for PR/MR reviews
 *
 * This module handles posting review comments to GitHub and GitLab platforms,
 * including summary comments and inline code comments.
 */

import chalk from 'chalk';
import type { calculateSummary } from './comment-formatter.js';
import {
  formatSummaryComment,
  formatIssueComment,
  type ReviewIssue,
  type ReviewMetadata,
} from './comment-formatter.js';
import type { ChangeSummary } from './change-summary.js';
import type { CursorFixLinkOptions } from './cursor-fix-link.js';
import {
  BOT_COMMENT_ID,
  createIssueFingerprint,
  extractIssueFingerprints,
  findExistingSummaryComment,
  prepareIssuesForPosting,
  type PlatformComment,
} from './comment-manager.js';
import type { PlatformClient, LineValidator, InlineCommentPosition } from './platform-client.js';
import type { ReviewUsageSummary } from './review-usage.js';

const MAX_PLATFORM_COMMENT_LENGTH = 60_000;
const MAX_INLINE_COMMENTS_PER_REVIEW = 100;

function assertPostBodyWithinLimit(body: string, subject: string): void {
  if (body.length > MAX_PLATFORM_COMMENT_LENGTH) {
    throw new Error(`${subject} exceeds the safe platform comment length.`);
  }
}

/**
 * Post review comments to a PR/MR
 *
 * This function:
 * 1. Fetches existing comments to prevent duplicates
 * 2. Posts or updates a summary comment, optionally with Cursor fix links
 * 3. Posts inline comments for CRITICAL/HIGH severity issues
 * 4. Adds an "ai-reviewed" label
 * @param cursorFixLinks Optional Cursor link settings for summary and inline issue comments.
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
  createInlinePosition?: (issue: ReviewIssue, platformData: unknown) => InlineCommentPosition,
  cursorFixLinks?: CursorFixLinkOptions,
  reviewMetadata?: ReviewMetadata,
  assertCurrentHead?: () => Promise<void>,
  beforeLabel?: () => Promise<void>
): Promise<void> {
  const summaryComment = formatSummaryComment(
    summary,
    issues,
    BOT_COMMENT_ID,
    changeSummary,
    reviewUsage,
    cursorFixLinks,
    reviewMetadata
  );
  assertPostBodyWithinLimit(summaryComment, 'Review summary');
  for (const issue of issues) {
    if (issue.severity === 'CRITICAL' || issue.severity === 'HIGH') {
      assertPostBodyWithinLimit(
        formatIssueComment(issue, createIssueFingerprint(issue), cursorFixLinks),
        'Inline review comment'
      );
    }
  }

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

  const inlineComments = createInlinePosition
    ? prepared.inlineIssues.map((issue) => ({
        body: formatIssueComment(issue, createIssueFingerprint(issue), cursorFixLinks),
        position: createInlinePosition(issue, platformData),
      }))
    : [];
  if (inlineComments.length > MAX_INLINE_COMMENTS_PER_REVIEW) {
    throw new Error('Review has too many inline comments for one platform request.');
  }

  await assertCurrentHead?.();
  console.log(chalk.gray('Posting review summary...\n'));
  if (existingSummary) {
    await platformClient.updateComment(projectId, prNumber, existingSummary.id, summaryComment);
    console.log(chalk.green('✓ Updated existing review summary'));
  } else {
    await platformClient.createComment(projectId, prNumber, summaryComment);
    console.log(chalk.green('✓ Posted new review summary'));
  }

  await assertCurrentHead?.();
  await removeStaleInlineIssueComments(
    platformClient,
    projectId,
    prNumber,
    existingInlineComments.map((c) => ({ id: c.id, body: c.body })),
    issues
  );

  if (inlineComments.length > 0) {
    await assertCurrentHead?.();
    await platformClient.createBulkInlineComments(projectId, prNumber, inlineComments);
  }

  // Add ai-reviewed label
  await beforeLabel?.();
  await assertCurrentHead?.();
  await platformClient.addLabels(projectId, prNumber, ['ai-reviewed']);

  console.log(chalk.green('✓ Review posted\n'));
}

async function removeStaleInlineIssueComments(
  platformClient: PlatformClient,
  projectId: string,
  prNumber: number,
  existingInlineComments: PlatformComment[],
  issues: ReviewIssue[]
): Promise<void> {
  const currentFingerprints = new Set(
    issues
      .filter((issue) => issue.severity === 'CRITICAL' || issue.severity === 'HIGH')
      .map((issue) => createIssueFingerprint(issue))
  );

  let removed = 0;
  for (const comment of existingInlineComments) {
    const fingerprints = extractIssueFingerprints(comment.body);
    if (fingerprints.size === 0) {
      continue;
    }

    const stillCurrent = [...fingerprints].some((fingerprint) =>
      currentFingerprints.has(fingerprint)
    );
    if (stillCurrent) {
      continue;
    }

    try {
      await platformClient.deleteComment(projectId, prNumber, comment.id);
      removed += 1;
    } catch (error) {
      console.warn(
        chalk.yellow(
          `Could not remove stale DRS inline comment ${comment.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
  }

  if (removed > 0) {
    console.log(chalk.gray(`Removed ${removed} stale DRS inline comment(s)\n`));
  }
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
