/**
 * JSON output formatting for review results
 *
 * Provides structured JSON output for review results when
 * not posting comments or generating code quality reports.
 */

import { writeFile } from 'fs/promises';
import type { ReviewIssue, ReviewSummary } from './comment-formatter.js';
import { resolveWithinWorkingDir } from './path-utils.js';
import type { ReviewUsageSummary } from './review-usage.js';
import type { ReviewResult } from './review-orchestrator.js';

/**
 * JSON output structure for review results
 */
export interface ReviewJsonOutput {
  /** Timestamp of the review */
  timestamp: string;
  /** Review summary statistics */
  summary: ReviewSummary;
  /** All issues found */
  issues: ReviewIssue[];
  /** Token usage and cost breakdown */
  usage?: ReviewUsageSummary;
  mode?: ReviewResult['mode'];
  evaluations?: ReviewResult['evaluations'];
  /** Metadata about the review */
  metadata?: {
    /** Source of the review (PR number, MR iid, or local) */
    source?: string;
    /** Project identifier */
    project?: string;
    /** Branch information */
    branch?: {
      source?: string;
      target?: string;
    };
  };
}

/**
 * Format review results as JSON output
 */
export function formatReviewJson(
  summary: ReviewSummary,
  issues: ReviewIssue[],
  metadata?: ReviewJsonOutput['metadata'],
  usage?: ReviewUsageSummary,
  reviewExtras?: Pick<ReviewJsonOutput, 'mode' | 'evaluations'>
): ReviewJsonOutput {
  return {
    timestamp: new Date().toISOString(),
    summary,
    issues,
    usage,
    ...(reviewExtras?.mode ? { mode: reviewExtras.mode } : {}),
    ...(reviewExtras?.evaluations ? { evaluations: reviewExtras.evaluations } : {}),
    metadata,
  };
}

/**
 * Write review results to a JSON file
 */
export async function writeReviewJson(
  output: ReviewJsonOutput,
  outputPath: string,
  workingDir: string = process.cwd()
): Promise<void> {
  const fullPath = resolveWithinWorkingDir(workingDir, outputPath, 'write');
  const jsonContent = JSON.stringify(output, null, 2);
  await writeFile(fullPath, jsonContent, 'utf-8');
}

/**
 * Print review results as JSON to console
 */
export function printReviewJson(output: ReviewJsonOutput): void {
  console.log(JSON.stringify(output, null, 2));
}
