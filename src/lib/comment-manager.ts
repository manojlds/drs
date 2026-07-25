import { createHash } from 'node:crypto';
import type { ReviewIssue } from './comment-formatter.js';

/**
 * Platform-agnostic comment management for deduplication and updates
 */

// Bot identifier for tracking our comments
export const BOT_COMMENT_ID = 'drs-review-summary';

// Error comment identifier for tracking error notifications
export const ERROR_COMMENT_ID = 'drs-error';

/**
 * Identity for one exact issue instance and its cross-run continuity key.
 */
export interface IssueIdentity {
  fingerprint: string;
  stableSignature: string;
  legacyFingerprint: string;
}

function normalizeIssuePath(file: string): string {
  return file.trim().replace(/\\/g, '/');
}

function normalizeIssueText(value: string | undefined): string {
  let normalized = (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const marker of ['**', '~~', '*', '`']) {
    if (normalized.startsWith(marker) && normalized.endsWith(marker)) {
      normalized = normalized.slice(marker.length, -marker.length).trim();
    }
  }
  return normalized;
}

function hashIssueIdentity(kind: 'fingerprint' | 'signature', parts: string[]): string {
  const digest = createHash('sha256')
    .update(`drs-issue-${kind}\0`)
    .update(JSON.stringify(parts))
    .digest('hex');
  return `${kind === 'fingerprint' ? 'v2' : 'sig1'}:${digest}`;
}

/**
 * Create the pre-v2 fingerprint for compatibility with existing comments and artifacts.
 */
export function createLegacyIssueFingerprint(issue: ReviewIssue): string {
  const line = issue.line && issue.line > 0 ? issue.line : 'general';
  return `${issue.file}:${line}:${issue.category}:${issue.title}`;
}

/**
 * Create an exact, line-sensitive fingerprint for artifact integrity and issue instances.
 */
export function createIssueFingerprint(issue: ReviewIssue): string {
  const line = issue.line && issue.line > 0 ? String(issue.line) : 'general';
  return hashIssueIdentity('fingerprint', [
    normalizeIssuePath(issue.file),
    line,
    issue.category,
    normalizeIssueText(issue.title),
    normalizeIssueText(issue.problem),
  ]);
}

/**
 * Create a line-insensitive signature for conservative cross-run continuity matching.
 */
export function createIssueStableSignature(issue: ReviewIssue): string {
  return hashIssueIdentity('signature', [
    normalizeIssuePath(issue.file),
    issue.category,
    normalizeIssueText(issue.title),
    normalizeIssueText(issue.problem),
  ]);
}

export function createIssueIdentity(issue: ReviewIssue): IssueIdentity {
  return {
    fingerprint: createIssueFingerprint(issue),
    stableSignature: createIssueStableSignature(issue),
    legacyFingerprint: createLegacyIssueFingerprint(issue),
  };
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
 * Extract stable issue signatures from a comment body.
 */
export function extractIssueSignatures(body: string): Set<string> {
  const signatures = new Set<string>();
  const regex = /<!-- issue-sig: (.*?) -->/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    signatures.add(match[1]);
  }
  return signatures;
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
    const identity = createIssueIdentity(issue);
    return (
      !existingFingerprints.has(identity.fingerprint) &&
      !existingFingerprints.has(identity.legacyFingerprint)
    );
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
  return findExistingCommentById(comments, BOT_COMMENT_ID);
}

/**
 * Find an existing comment by DRS marker id (for example drs-review-summary).
 */
export function findExistingCommentById<T extends PlatformComment>(
  comments: T[],
  commentId: string
): T | null {
  return comments.find((c) => extractCommentId(c.body) === commentId) ?? null;
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

function countIssueSignatures(issues: ReviewIssue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const signature = createIssueStableSignature(issue);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function countCommentSignatures(comments: PlatformComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    if (extractIssueFingerprints(comment.body).size === 0) {
      continue;
    }
    for (const signature of extractIssueSignatures(comment.body)) {
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Filter duplicates using exact v2/legacy fingerprints first, then an unambiguous stable signature.
 */
export function filterDuplicateIssuesAgainstComments(
  issues: ReviewIssue[],
  existingComments: PlatformComment[]
): ReviewIssue[] {
  const existingFingerprints = collectExistingFingerprints(existingComments);
  const currentSignatureCounts = countIssueSignatures(issues);
  const existingSignatureCounts = countCommentSignatures(existingComments);

  return issues.filter((issue) => {
    const identity = createIssueIdentity(issue);
    if (
      existingFingerprints.has(identity.fingerprint) ||
      existingFingerprints.has(identity.legacyFingerprint)
    ) {
      return false;
    }
    return !(
      currentSignatureCounts.get(identity.stableSignature) === 1 &&
      existingSignatureCounts.get(identity.stableSignature) === 1
    );
  });
}

/**
 * Return DRS inline comments whose exact identity and stable signature are no longer current.
 * Ambiguous current signatures are retained rather than risking removal of a valid comment.
 */
export function findStaleIssueComments(
  currentIssues: ReviewIssue[],
  existingComments: PlatformComment[]
): PlatformComment[] {
  const currentFingerprints = new Set<string>();
  for (const issue of currentIssues) {
    const identity = createIssueIdentity(issue);
    currentFingerprints.add(identity.fingerprint);
    currentFingerprints.add(identity.legacyFingerprint);
  }
  const currentSignatureCounts = countIssueSignatures(currentIssues);
  const existingSignatureCounts = countCommentSignatures(existingComments);

  return existingComments.filter((comment) => {
    const fingerprints = extractIssueFingerprints(comment.body);
    const signatures = extractIssueSignatures(comment.body);
    if (fingerprints.size === 0) {
      return false;
    }
    if ([...fingerprints].some((fingerprint) => currentFingerprints.has(fingerprint))) {
      return false;
    }
    if (
      [...signatures].some(
        (signature) =>
          currentSignatureCounts.get(signature) === 1 &&
          existingSignatureCounts.get(signature) === 1
      )
    ) {
      return false;
    }
    return true;
  });
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
  const newIssues = filterDuplicateIssuesAgainstComments(criticalAndHigh, existingComments);
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
