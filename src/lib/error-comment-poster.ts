/**
 * Error comment posting utilities for PR/MR reviews
 *
 * This module handles posting and removing error comments when DRS
 * encounters failures during review execution.
 */

import chalk from 'chalk';
import { formatErrorComment } from './comment-formatter.js';
import {
  ERROR_COMMENT_ID,
  findExistingErrorComment,
  type PlatformComment,
} from './comment-manager.js';
import type { PlatformClient } from './platform-client.js';

/**
 * Sanitize error messages to prevent exposure of sensitive information
 * in public comments. Removes/masks:
 * - API keys and tokens
 * - Absolute file paths
 * - Environment variable values
 * - Stack traces (keeps only first meaningful line)
 */
export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;

  // Remove potential API keys and tokens (various formats)
  // Matches: token=xxx, key=xxx, api_key=xxx, Bearer xxx, etc.
  sanitized = sanitized.replace(
    /(?:token|key|api_key|apikey|secret|password|auth|bearer)\s*[=:]\s*['"]?[a-zA-Z0-9_\-./+]{8,}['"]?/gi,
    '[REDACTED]'
  );

  // Remove Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_\-./+]+/gi, 'Bearer [REDACTED]');

  // Remove GitHub/GitLab tokens (ghp_, glpat-, etc.)
  sanitized = sanitized.replace(/(?:ghp_|gho_|ghu_|ghs_|ghr_|glpat-)[a-zA-Z0-9_]+/g, '[REDACTED]');

  // Mask absolute file paths (Unix and Windows)
  // Keep only the filename, not the full path
  sanitized = sanitized.replace(/(?:\/[\w.-]+)+\/([^\/\s:]+)/g, '.../$1');
  sanitized = sanitized.replace(/[A-Za-z]:\\(?:[\w.-]+\\)+([^\\\s:]+)/g, '...\\$1');

  // Remove home directory paths
  sanitized = sanitized.replace(/\/home\/[^\/\s]+/g, '/home/[user]');
  sanitized = sanitized.replace(/\/Users\/[^\/\s]+/g, '/Users/[user]');
  sanitized = sanitized.replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[user]');

  // Truncate stack traces - keep only first line of stack
  const stackTraceStart = sanitized.search(/\n\s+at\s+/);
  if (stackTraceStart !== -1) {
    // Find the first "at" line and keep just one
    const firstAtMatch = sanitized.match(/\n(\s+at\s+[^\n]+)/);
    if (firstAtMatch) {
      sanitized = sanitized.substring(0, stackTraceStart) + '\n[Stack trace truncated]';
    }
  }

  // Remove environment variable patterns
  sanitized = sanitized.replace(/\$\{?[A-Z_][A-Z0-9_]*\}?=[^\s]+/g, '[ENV_VAR]');

  // Limit message length to prevent overly verbose error exposure
  const maxLength = 500;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + '... [truncated]';
  }

  return sanitized.trim();
}

/**
 * Post or update an error comment on a PR/MR
 */
export async function postErrorComment(
  platformClient: PlatformClient,
  projectId: string,
  prNumber: number,
  errorMessage: string
): Promise<void> {
  console.log(chalk.gray('Posting error comment...\n'));

  // Sanitize the error message to prevent sensitive data exposure
  const sanitizedMessage = sanitizeErrorMessage(errorMessage);

  // Fetch existing comments to check for existing error comment
  const existingComments = await platformClient.getComments(projectId, prNumber);
  const mappedComments: PlatformComment[] = existingComments.map((c) => ({
    id: c.id,
    body: c.body,
  }));

  const existingError = findExistingErrorComment(mappedComments);
  const errorComment = formatErrorComment(sanitizedMessage, ERROR_COMMENT_ID);

  if (existingError) {
    await platformClient.updateComment(projectId, prNumber, existingError.id, errorComment);
    console.log(chalk.yellow('Updated existing error comment'));
  } else {
    await platformClient.createComment(projectId, prNumber, errorComment);
    console.log(chalk.yellow('Posted new error comment'));
  }
}

/**
 * Remove any existing error comment from a PR/MR
 * Called when a review succeeds after a previous failure
 */
export async function removeErrorComment(
  platformClient: PlatformClient,
  projectId: string,
  prNumber: number
): Promise<void> {
  try {
    const existingComments = await platformClient.getComments(projectId, prNumber);
    const mappedComments: PlatformComment[] = existingComments.map((c) => ({
      id: c.id,
      body: c.body,
    }));

    const existingError = findExistingErrorComment(mappedComments);

    if (existingError) {
      await platformClient.deleteComment(projectId, prNumber, existingError.id);
      console.log(chalk.green('Removed previous error comment'));
    }
  } catch (error) {
    // Non-fatal: just log a warning if we can't remove the error comment
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(chalk.yellow(`Could not remove previous error comment: ${errorMessage}`));
  }
}
