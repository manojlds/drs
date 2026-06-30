import { describe, expect, it } from 'vitest';
import {
  getTemporalNodeRetryMode,
  TEMPORAL_NO_RETRY_ACTIONS,
  TEMPORAL_RETRYABLE_ACTIVITY_POLICY,
} from './retry-policy.js';
import type { WorkflowAction, WorkflowNodeConfig } from '../lib/config.js';

describe('getTemporalNodeRetryMode', () => {
  it('marks side-effecting actions as no-retry', () => {
    const sideEffectingActions: WorkflowAction[] = [
      'write',
      'git-add',
      'git-branch',
      'git-commit',
      'git-push',
      'save-artifact',
      'post-comment',
      'post-review-comments',
      'post-fix-status',
      'create-change-request',
      'create-pr',
      'create-mr',
    ];

    for (const action of sideEffectingActions) {
      expect(TEMPORAL_NO_RETRY_ACTIONS.has(action)).toBe(true);
      expect(getTemporalNodeRetryMode({ action })).toBe('no-retry');
    }
  });

  it('keeps read-only actions retryable', () => {
    const retryableActions: WorkflowAction[] = [
      'git-diff',
      'has-diff',
      'stack-guard',
      'review-threshold',
      'load-artifact',
      'artifact-exists',
      'create-review-artifact',
      'review-artifact-status',
      'change-source',
      'review',
      'review-context',
      'describe',
      'code-quality-report',
      'verify-fix',
    ];

    for (const action of retryableActions) {
      expect(getTemporalNodeRetryMode({ action })).toBe('retryable');
    }
  });

  it('marks agent nodes with file writes as no-retry', () => {
    const node: WorkflowNodeConfig = {
      agent: 'task/docs',
      input: 'update docs',
      writes: 'README.md',
    };

    expect(getTemporalNodeRetryMode(node)).toBe('no-retry');
  });

  it('keeps non-writing agent nodes retryable', () => {
    expect(getTemporalNodeRetryMode({ agent: 'task/review', input: 'review' })).toBe('retryable');
    expect(getTemporalNodeRetryMode({ agentsFrom: 'review.agents', input: 'review' })).toBe(
      'retryable'
    );
  });
});

describe('TEMPORAL_RETRYABLE_ACTIVITY_POLICY', () => {
  it('bounds maximum attempts to a finite number', () => {
    expect(TEMPORAL_RETRYABLE_ACTIVITY_POLICY.maximumAttempts).toBe(5);
    expect(TEMPORAL_RETRYABLE_ACTIVITY_POLICY.maximumAttempts).toBeLessThan(Infinity);
  });

  it('uses exponential backoff', () => {
    expect(TEMPORAL_RETRYABLE_ACTIVITY_POLICY.backoffCoefficient).toBe(2);
    expect(TEMPORAL_RETRYABLE_ACTIVITY_POLICY.initialInterval).toBe('1 second');
  });

  it('caps the maximum retry interval', () => {
    expect(TEMPORAL_RETRYABLE_ACTIVITY_POLICY.maximumInterval).toBe('1 minute');
  });

  it('lists NonRetryableProviderFailure as non-retryable', () => {
    expect(TEMPORAL_RETRYABLE_ACTIVITY_POLICY.nonRetryableErrorTypes).toContain(
      'NonRetryableProviderFailure'
    );
  });
});
