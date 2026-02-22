import type { ReviewIssue } from './comment-formatter.js';

/**
 * Platform-agnostic comment management for deduplication and updates
 */

// Bot identifier for tracking our comments
export const BOT_COMMENT_ID = 'drs-review-summary';

// Error comment identifier for tracking error notifications
export const ERROR_COMMENT_ID = 'drs-error';

/**
 * Create a unique fingerprint for an issue to detect duplicates
 */
export function createIssueFingerprint(issue: ReviewIssue): string {
  const line = issue.line && issue.line > 0 ? issue.line : 'general';
  return `${issue.file}:${line}:${issue.category}:${issue.title}`;
}

/**
 * Extract bot comment ID from comment body
 */
export function extractCommentId(body: string): string | null {
  const match = body.match(/<!-- drs-comment-id: (.*?) -->/);
  return match ? match[1] : null;
}

/**
 * Extract issue fingerprints from comment body
 */
export function extractIssueFingerprints(body: string): Set<string> {
  const fingerprints = new Set<string>();
  const regex = /<!-- issue-fp: (.*?) -->/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    fingerprints.add(match[1]);
  }
  return fingerprints;
}

/**
 * Filter issues to only include CRITICAL and HIGH severity
 * (for inline comments - reduces noise and API calls)
 */
export function filterCriticalAndHigh(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
}

/**
 * Filter out duplicate issues based on existing fingerprints
 */
export function filterDuplicateIssues(
  issues: ReviewIssue[],
  existingFingerprints: Set<string>
): ReviewIssue[] {
  return issues.filter((issue) => {
    const fingerprint = createIssueFingerprint(issue);
    return !existingFingerprints.has(fingerprint);
  });
}

/**
 * Represents a comment from any platform
 */
export interface PlatformComment {
  id: number | string;
  body: string;
}

/**
 * Find existing summary comment using bot marker
 */
export function findExistingSummaryComment(comments: PlatformComment[]): PlatformComment | null {
  return comments.find((c) => extractCommentId(c.body) === BOT_COMMENT_ID) ?? null;
}

/**
 * Find existing error comment using error marker
 */
export function findExistingErrorComment(comments: PlatformComment[]): PlatformComment | null {
  return comments.find((c) => extractCommentId(c.body) === ERROR_COMMENT_ID) ?? null;
}

/**
 * Collect all existing issue fingerprints from comments
 */
export function collectExistingFingerprints(comments: PlatformComment[]): Set<string> {
  const allFingerprints = new Set<string>();
  for (const comment of comments) {
    const fingerprints = extractIssueFingerprints(comment.body);
    fingerprints.forEach((fp) => allFingerprints.add(fp));
  }
  return allFingerprints;
}

/**
 * Result of preparing issues for posting
 */
export interface PreparedIssues {
  /** Issues to post as inline comments (CRITICAL/HIGH, new, with valid lines) */
  inlineIssues: ReviewIssue[];
  /** Number of issues that were deduplicated */
  deduplicatedCount: number;
  /** Number of medium/low severity issues (not posted inline) */
  nonInlineCount: number;
}

/**
 * Prepare issues for posting, applying all filters:
 * 1. Filter to CRITICAL/HIGH severity only
 * 2. Filter out duplicates based on existing comments
 * 3. Filter to only issues with line numbers
 * 4. Optionally filter to valid line numbers (platform-specific)
 */
export function prepareIssuesForPosting(
  allIssues: ReviewIssue[],
  existingComments: PlatformComment[],
  validLinesChecker?: (issue: ReviewIssue) => boolean
): PreparedIssues {
  // Step 1: Filter to CRITICAL/HIGH only
  const criticalAndHigh = filterCriticalAndHigh(allIssues);
  const nonInlineCount = allIssues.length - criticalAndHigh.length;

  // Step 2: Filter out duplicates
  const existingFingerprints = collectExistingFingerprints(existingComments);
  const newIssues = filterDuplicateIssues(criticalAndHigh, existingFingerprints);
  const deduplicatedCount = criticalAndHigh.length - newIssues.length;

  // Step 3: Filter to only issues with line numbers
  let inlineIssues = newIssues.filter((issue) => issue.line !== undefined && issue.line !== null);

  // Step 4: Optionally filter based on valid lines (platform-specific)
  if (validLinesChecker) {
    inlineIssues = inlineIssues.filter(validLinesChecker);
  }

  return {
    inlineIssues,
    deduplicatedCount,
    nonInlineCount,
  };
}
