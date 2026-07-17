import type { WorkflowNodeConfig } from '../lib/config.js';
import type { RetryPolicy } from '@temporalio/common';

export type TemporalNodeRetryMode = 'retryable' | 'no-retry';

export const TEMPORAL_NO_RETRY_ACTIONS = new Set<NonNullable<WorkflowNodeConfig['action']>>([
  'write',
  'sync-okf-indexes',
  'record-wiki-state',
  'git-add',
  'git-branch',
  'git-commit',
  'git-push',
  'save-artifact',
  'review-artifact-add-finding',
  'review-artifact-update-findings',
  'review-artifact-promote-finding',
  'review-artifact-resolve-finding',
  'create-change-request',
  'create-pr',
  'create-mr',
  'post-comment',
  'post-review-comments',
  'post-fix-status',
]);

/**
 * Retry policy for retryable DRS workflow activities (read-only actions and
 * non-writing agent nodes).
 *
 * Temporal's default activity retry is effectively unlimited
 * (`maximumAttempts: Infinity`) with exponential backoff. Without an explicit
 * cap, a transiently failing activity (model 5xx, rate limit, network blip)
 * can retry for a very long time. This policy bounds retries so a persistently
 * failing activity fails the workflow in minutes rather than hours or days.
 *
 * - `maximumAttempts: 5` — enough to ride out transient failures, bounded.
 * - `initialInterval: 1s` with `backoffCoefficient: 2` — standard exponential
 *   backoff (1s, 2s, 4s, 8s between attempts).
 * - `maximumInterval: 1 minute` — caps backoff growth so later retries don't
 *   stall for too long.
 * - `nonRetryableErrorTypes: ['NonRetryableProviderFailure']` —
 *   defense-in-depth: provider quota/auth failures are already converted to
 *   `ApplicationFailure.nonRetryable` in the activity, but listing the type
 *   here ensures Temporal never retries them even if the non-retryable flag
 *   is lost in serialization.
 */
export const TEMPORAL_RETRYABLE_ACTIVITY_POLICY: RetryPolicy = {
  maximumAttempts: 5,
  initialInterval: '1 second',
  backoffCoefficient: 2,
  maximumInterval: '1 minute',
  nonRetryableErrorTypes: ['NonRetryableProviderFailure'],
};

export function getTemporalNodeRetryMode(node: WorkflowNodeConfig): TemporalNodeRetryMode {
  if (node.action && TEMPORAL_NO_RETRY_ACTIONS.has(node.action)) {
    return 'no-retry';
  }

  if ((node.agent || node.agentsFrom) && node.writes) {
    return 'no-retry';
  }

  return 'retryable';
}
