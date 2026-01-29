/**
 * Error comment posting utilities for PR/MR reviews
 *
 * This module handles posting and removing error comments when DRS
 * encounters failures during review execution.
 */

import chalk from 'chalk';
import { formatErrorComment } from './comment-formatter.js';
import { ERROR_COMMENT_ID, findExistingErrorComment, type PlatformComment } from './comment-manager.js';
import type { PlatformClient } from './platform-client.js';

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

  // Fetch existing comments to check for existing error comment
  const existingComments = await platformClient.getComments(projectId, prNumber);
  const mappedComments: PlatformComment[] = existingComments.map((c) => ({
    id: c.id,
    body: c.body,
  }));

  const existingError = findExistingErrorComment(mappedComments);
  const errorComment = formatErrorComment(errorMessage, ERROR_COMMENT_ID);

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
