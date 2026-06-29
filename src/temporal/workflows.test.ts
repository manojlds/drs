import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemporalWorkflowInput } from './types.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from '../lib/workflow/types.js';

const temporalMocks = vi.hoisted(() => {
  const runWorkflowNodeActivity = vi.fn();
  const runWorkflowNodeNoRetryActivity = vi.fn();
  const hydrateContextActivity = vi.fn(
    async (input: { context: WorkflowTemplateContext }) => input.context
  );
  const queryHandlers = new Map<unknown, () => unknown>();
  return {
    runWorkflowNodeActivity,
    runWorkflowNodeNoRetryActivity,
    hydrateContextActivity,
    queryHandlers,
  };
});

vi.mock('@temporalio/workflow', () => ({
  defineQuery: (name: string) => name,
  isCancellation: (error: unknown) => error instanceof Error && error.name === 'CancelledFailure',
  proxyActivities: (options: { retry?: { maximumAttempts?: number } } = {}) => ({
    runWorkflowNodeActivity:
      options.retry?.maximumAttempts === 1
        ? temporalMocks.runWorkflowNodeNoRetryActivity
        : temporalMocks.runWorkflowNodeActivity,
    hydrateContextActivity: temporalMocks.hydrateContextActivity,
  }),
  setHandler: (query: unknown, handler: () => unknown) => {
    temporalMocks.queryHandlers.set(query, handler);
  },
  workflowInfo: () => ({
    workflowId: 'workflow-1',
    runId: 'run-1',
    startTime: new Date('2026-06-29T00:00:00.000Z'),
  }),
}));

import {
  drsWorkflow,
  workflowArtifactsQuery,
  workflowLoopStateQuery,
  workflowStatusQuery,
} from './workflows.js';
import type {
  TemporalWorkflowArtifactsQueryResult,
  TemporalWorkflowStatusQueryResult,
} from './types.js';

function actionResult(id: string, output: unknown): WorkflowNodeResult {
  return {
    id,
    type: 'action',
    status: 'success',
    action: 'write',
    output,
  };
}

describe('drsWorkflow control-flow execution', () => {
  beforeEach(() => {
    temporalMocks.runWorkflowNodeActivity.mockReset();
    temporalMocks.runWorkflowNodeNoRetryActivity.mockReset();
    temporalMocks.hydrateContextActivity.mockClear();
    temporalMocks.queryHandlers.clear();
    temporalMocks.hydrateContextActivity.mockImplementation(
      async (input: { context: WorkflowTemplateContext }) => input.context
    );
  });

  it('routes switch branches and records inactive DAG nodes as skipped', async () => {
    temporalMocks.runWorkflowNodeNoRetryActivity.mockImplementation(
      async ({ nodeId }: { nodeId: string }) => {
        if (nodeId === 'start') return actionResult(nodeId, 'yes');
        if (nodeId === 'yesNode') return actionResult(nodeId, 'selected');
        if (nodeId === 'noNode') return actionResult(nodeId, 'not-selected');
        throw new Error(`Unexpected node ${nodeId}`);
      }
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'switchFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'result',
        inputs: {},
        nodes: {
          start: { action: 'write', output: 'choice' },
          route: {
            control: 'switch',
            needs: ['start'],
            value: '{{artifacts.choice}}',
            cases: { yes: 'yesNode' },
            default: 'noNode',
          },
          yesNode: { action: 'write', needs: ['route'], output: 'result' },
          noNode: { action: 'write', needs: ['route'], output: 'result' },
        },
        executionOrder: ['start', 'route', 'yesNode', 'noNode'],
        waves: [],
        segments: [
          { type: 'dag', nodeIds: ['start'] },
          { type: 'control', nodeId: 'route' },
          { type: 'dag', nodeIds: ['yesNode', 'noNode'] },
        ],
        hasControlNodes: true,
        lastNodeId: 'noNode',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.output).toBe('selected');
    expect(result.nodes['route']).toMatchObject({ decision: 'yes', target: 'yesNode' });
    expect(result.nodes['yesNode']).toMatchObject({ status: 'success' });
    expect(result.nodes['noNode']).toMatchObject({ status: 'skipped' });
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).toHaveBeenCalledTimes(2);
    expect(temporalMocks.runWorkflowNodeActivity).not.toHaveBeenCalled();
  });

  it('executes bounded loops and returns loop state', async () => {
    let count = 0;
    temporalMocks.runWorkflowNodeNoRetryActivity.mockImplementation(
      async ({ nodeId }: { nodeId: string }) => {
        if (nodeId === 'bump') {
          count += 1;
          return actionResult(nodeId, count);
        }
        if (nodeId === 'done') return actionResult(nodeId, `done:${count}`);
        throw new Error(`Unexpected node ${nodeId}`);
      }
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'loopFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'final',
        inputs: {},
        nodes: {
          bump: { action: 'write', output: 'count' },
          again: {
            control: 'loop',
            needs: ['bump'],
            if: '{{artifacts.count}} < 2',
            target: 'bump',
            exit: 'done',
            maxIterations: 3,
          },
          done: { action: 'write', output: 'final' },
        },
        executionOrder: ['bump', 'again', 'done'],
        waves: [],
        segments: [
          { type: 'dag', nodeIds: ['bump'] },
          { type: 'control', nodeId: 'again' },
          { type: 'dag', nodeIds: ['done'] },
        ],
        hasControlNodes: true,
        lastNodeId: 'done',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.output).toBe('done:2');
    expect(result.loop['again']).toEqual({ iteration: 2, maxIterations: 3, lastDecision: 'loop' });
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).toHaveBeenCalledTimes(3);
    expect(temporalMocks.runWorkflowNodeActivity).not.toHaveBeenCalled();
  });

  it('exits loops when onMaxIterations is exit', async () => {
    let count = 0;
    temporalMocks.runWorkflowNodeNoRetryActivity.mockImplementation(
      async ({ nodeId }: { nodeId: string }) => {
        if (nodeId === 'bump') {
          count += 1;
          return actionResult(nodeId, count);
        }
        if (nodeId === 'done') return actionResult(nodeId, `max:${count}`);
        throw new Error(`Unexpected node ${nodeId}`);
      }
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'loopMaxFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'final',
        inputs: {},
        nodes: {
          bump: { action: 'write', output: 'count' },
          again: {
            control: 'loop',
            needs: ['bump'],
            if: 'true',
            target: 'bump',
            exit: 'done',
            maxIterations: 2,
            onMaxIterations: 'exit',
          },
          done: { action: 'write', output: 'final' },
        },
        executionOrder: ['bump', 'again', 'done'],
        waves: [],
        segments: [
          { type: 'dag', nodeIds: ['bump'] },
          { type: 'control', nodeId: 'again' },
          { type: 'dag', nodeIds: ['done'] },
        ],
        hasControlNodes: true,
        lastNodeId: 'done',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.output).toBe('max:2');
    expect(result.loop['again']).toEqual({ iteration: 2, maxIterations: 2, lastDecision: 'exit' });
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).toHaveBeenCalledTimes(3);
    expect(temporalMocks.runWorkflowNodeActivity).not.toHaveBeenCalled();
  });

  it('routes passThrough controls to their target segment', async () => {
    temporalMocks.runWorkflowNodeNoRetryActivity.mockImplementation(
      async ({ nodeId }: { nodeId: string }) => {
        if (nodeId === 'first') return actionResult(nodeId, 'first-output');
        if (nodeId === 'target') return actionResult(nodeId, 'target-output');
        throw new Error(`Unexpected node ${nodeId}`);
      }
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'passFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'result',
        inputs: {},
        nodes: {
          first: { action: 'write', output: 'first' },
          pass: { control: 'passThrough', needs: ['first'], target: 'target' },
          skipped: { action: 'write', needs: ['pass'], output: 'result' },
          target: { action: 'write', needs: ['pass'], output: 'result' },
        },
        executionOrder: ['first', 'pass', 'skipped', 'target'],
        waves: [],
        segments: [
          { type: 'dag', nodeIds: ['first'] },
          { type: 'control', nodeId: 'pass' },
          { type: 'dag', nodeIds: ['skipped', 'target'] },
        ],
        hasControlNodes: true,
        lastNodeId: 'target',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.output).toBe('target-output');
    expect(result.nodes['pass']).toMatchObject({ decision: 'pass', target: 'target' });
    expect(result.nodes['skipped']).toMatchObject({ status: 'skipped' });
    expect(result.nodes['target']).toMatchObject({ status: 'success' });
  });

  it('terminates when an end control node runs', async () => {
    temporalMocks.runWorkflowNodeNoRetryActivity.mockResolvedValue(
      actionResult('first', 'before-end')
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'endFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'after',
        inputs: {},
        nodes: {
          first: { action: 'write', output: 'before' },
          stop: { control: 'end', needs: ['first'] },
          after: { action: 'write', needs: ['stop'], output: 'after' },
        },
        executionOrder: ['first', 'stop', 'after'],
        waves: [],
        segments: [
          { type: 'dag', nodeIds: ['first'] },
          { type: 'control', nodeId: 'stop' },
          { type: 'dag', nodeIds: ['after'] },
        ],
        hasControlNodes: true,
        lastNodeId: 'after',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.nodes['stop']).toMatchObject({ decision: 'end' });
    expect(result.nodes['after']).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).toHaveBeenCalledTimes(1);
    expect(temporalMocks.runWorkflowNodeActivity).not.toHaveBeenCalled();
  });

  it('uses the retryable activity proxy for read-only actions', async () => {
    temporalMocks.runWorkflowNodeActivity.mockResolvedValue(actionResult('diff', 'diff-output'));

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'retryableFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'diff',
        inputs: {},
        nodes: {
          diff: { action: 'git-diff', output: 'diff' },
        },
        executionOrder: ['diff'],
        waves: [['diff']],
        segments: [],
        hasControlNodes: false,
        lastNodeId: 'diff',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.output).toBe('diff-output');
    expect(temporalMocks.runWorkflowNodeActivity).toHaveBeenCalledTimes(1);
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).not.toHaveBeenCalled();
    expect(temporalMocks.runWorkflowNodeActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyContext: {
          workflowId: 'workflow-1',
          runId: 'run-1',
          nodeId: 'diff',
          idempotencyKey: 'workflow-1:run-1:diff',
        },
      })
    );
  });

  it.each([
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
    'post-comment',
    'post-review-comments',
    'post-fix-status',
    'create-change-request',
    'create-pr',
    'create-mr',
  ] as const)('uses the no-retry activity proxy for side-effecting action %s', async (action) => {
    temporalMocks.runWorkflowNodeNoRetryActivity.mockResolvedValue(
      actionResult('sideEffect', 'side-effect-output')
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'sideEffectFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'result',
        inputs: {},
        nodes: {
          sideEffect: { action, output: 'result' },
        },
        executionOrder: ['sideEffect'],
        waves: [['sideEffect']],
        segments: [],
        hasControlNodes: false,
        lastNodeId: 'sideEffect',
      },
    };

    const result = await drsWorkflow(input);

    expect(result.output).toBe('side-effect-output');
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).toHaveBeenCalledTimes(1);
    expect(temporalMocks.runWorkflowNodeActivity).not.toHaveBeenCalled();
    expect(temporalMocks.runWorkflowNodeNoRetryActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyContext: {
          workflowId: 'workflow-1',
          runId: 'run-1',
          nodeId: 'sideEffect',
          idempotencyKey: 'workflow-1:run-1:sideEffect',
        },
      })
    );
  });

  it('exposes workflow node status while an activity is running', async () => {
    let releaseActivity: (() => void) | undefined;
    let activityStarted: (() => void) | undefined;
    const activityStartedPromise = new Promise<void>((resolve) => {
      activityStarted = resolve;
    });
    temporalMocks.runWorkflowNodeActivity.mockImplementation(
      async ({ nodeId }: { nodeId: string }) => {
        activityStarted?.();
        await new Promise<void>((resolve) => {
          releaseActivity = resolve;
        });
        return actionResult(nodeId, 'diff-output');
      }
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'statusFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'diff',
        inputs: {},
        nodes: {
          diff: { action: 'git-diff', output: 'diff' },
        },
        executionOrder: ['diff'],
        waves: [['diff']],
        segments: [],
        hasControlNodes: false,
        lastNodeId: 'diff',
      },
    };

    const workflowPromise = drsWorkflow(input);
    await activityStartedPromise;

    const query = temporalMocks.queryHandlers.get(workflowStatusQuery);
    expect(query).toBeDefined();
    expect(query?.()).toMatchObject({
      workflow: 'statusFlow',
      workflowId: 'workflow-1',
      runId: 'run-1',
      cancelled: false,
      runningNodeIds: ['diff'],
      completedNodeIds: [],
      nodes: {
        diff: { id: 'diff', status: 'running', action: 'git-diff' },
      },
    } satisfies Partial<TemporalWorkflowStatusQueryResult>);

    releaseActivity?.();
    const result = await workflowPromise;

    expect(result.output).toBe('diff-output');
    expect(query?.()).toMatchObject({
      runningNodeIds: [],
      completedNodeIds: ['diff'],
      cancelled: false,
      nodes: {
        diff: { id: 'diff', status: 'success' },
      },
    } satisfies Partial<TemporalWorkflowStatusQueryResult>);
  });

  it('marks workflow status as cancelled and clears running nodes when activity cancellation propagates', async () => {
    let rejectActivity: ((error: Error) => void) | undefined;
    let activityStarted: (() => void) | undefined;
    const activityStartedPromise = new Promise<void>((resolve) => {
      activityStarted = resolve;
    });
    temporalMocks.runWorkflowNodeActivity.mockImplementation(async () => {
      activityStarted?.();
      await new Promise<void>((_resolve, reject) => {
        rejectActivity = reject;
      });
    });

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'cancelFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'diff',
        inputs: {},
        nodes: {
          diff: { action: 'git-diff', output: 'diff' },
        },
        executionOrder: ['diff'],
        waves: [['diff']],
        segments: [],
        hasControlNodes: false,
        lastNodeId: 'diff',
      },
    };

    const workflowPromise = drsWorkflow(input);
    await activityStartedPromise;

    const query = temporalMocks.queryHandlers.get(workflowStatusQuery);
    expect(query?.()).toMatchObject({
      cancelled: false,
      runningNodeIds: ['diff'],
      nodes: {
        diff: { id: 'diff', status: 'running' },
      },
    } satisfies Partial<TemporalWorkflowStatusQueryResult>);

    const cancellation = new Error('cancelled');
    cancellation.name = 'CancelledFailure';
    rejectActivity?.(cancellation);

    await expect(workflowPromise).rejects.toThrow('cancelled');
    expect(query?.()).toMatchObject({
      cancelled: true,
      runningNodeIds: [],
      completedNodeIds: [],
      nodes: {
        diff: { id: 'diff', status: 'pending' },
      },
    } satisfies Partial<TemporalWorkflowStatusQueryResult>);
  });

  it('exposes loop state and artifact refs through workflow queries', async () => {
    const artifactRef = {
      kind: 'artifact-ref' as const,
      key: 'done-output',
      uri: 'file:///repo/.drs/artifacts/temporal/done-output.json',
      sha256: 'abc123',
    };
    let count = 0;
    temporalMocks.runWorkflowNodeNoRetryActivity.mockImplementation(
      async ({ nodeId }: { nodeId: string }) => {
        if (nodeId === 'bump') {
          count += 1;
          return actionResult(nodeId, count);
        }
        if (nodeId === 'done') return actionResult(nodeId, artifactRef);
        throw new Error(`Unexpected node ${nodeId}`);
      }
    );

    const input: TemporalWorkflowInput = {
      workingDir: '/repo',
      inputs: {},
      plan: {
        schemaVersion: 1,
        workflowName: 'queryLoopFlow',
        source: 'project',
        overridesPackaged: false,
        output: 'final',
        inputs: {},
        nodes: {
          bump: { action: 'write', output: 'count' },
          again: {
            control: 'loop',
            needs: ['bump'],
            if: '{{artifacts.count}} < 2',
            target: 'bump',
            exit: 'done',
            maxIterations: 3,
          },
          done: { action: 'write', output: 'final' },
        },
        executionOrder: ['bump', 'again', 'done'],
        waves: [],
        segments: [
          { type: 'dag', nodeIds: ['bump'] },
          { type: 'control', nodeId: 'again' },
          { type: 'dag', nodeIds: ['done'] },
        ],
        hasControlNodes: true,
        lastNodeId: 'done',
      },
    };

    const result = await drsWorkflow(input);
    const loopQuery = temporalMocks.queryHandlers.get(workflowLoopStateQuery);
    const artifactsQuery = temporalMocks.queryHandlers.get(workflowArtifactsQuery);

    expect(result.output).toEqual(artifactRef);
    expect(loopQuery?.()).toEqual({
      again: { iteration: 2, maxIterations: 3, lastDecision: 'loop' },
    });
    expect(artifactsQuery?.()).toEqual({
      artifactKeys: ['bump', 'count', 'again', 'done', 'final'],
      artifactRefs: {
        done: artifactRef,
        final: artifactRef,
      },
    } satisfies TemporalWorkflowArtifactsQueryResult);
  });
});
