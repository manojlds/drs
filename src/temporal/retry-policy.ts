import type { WorkflowNodeConfig } from '../lib/config.js';

export type TemporalNodeRetryMode = 'retryable' | 'no-retry';

export const TEMPORAL_NO_RETRY_ACTIONS = new Set<NonNullable<WorkflowNodeConfig['action']>>([
  'write',
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

export function getTemporalNodeRetryMode(node: WorkflowNodeConfig): TemporalNodeRetryMode {
  if (node.action && TEMPORAL_NO_RETRY_ACTIONS.has(node.action)) {
    return 'no-retry';
  }

  if ((node.agent || node.agentsFrom) && node.writes) {
    return 'no-retry';
  }

  return 'retryable';
}
