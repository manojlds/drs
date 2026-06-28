import { describe, expect, it } from 'vitest';
import { LocalWorkflowExecutor } from './workflow.js';
import { TemporalWorkflowExecutor } from '../temporal/executor.js';
import { createWorkflowExecutor } from './workflow-executor-selection.js';

describe('createWorkflowExecutor', () => {
  it('defaults to the local executor', () => {
    expect(createWorkflowExecutor()).toBeInstanceOf(LocalWorkflowExecutor);
  });

  it('creates a Temporal executor', () => {
    expect(createWorkflowExecutor('temporal')).toBeInstanceOf(TemporalWorkflowExecutor);
  });

  it('rejects unknown executors', () => {
    expect(() => createWorkflowExecutor('unknown')).toThrow(
      'Unsupported workflow executor "unknown".'
    );
  });

  it('rejects --no-wait for local execution', () => {
    expect(() => createWorkflowExecutor('local', false)).toThrow(
      '--no-wait is only supported with --executor temporal.'
    );
  });
});
