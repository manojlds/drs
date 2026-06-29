import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { loadWorkflowArtifact } from '../lib/workflow-artifacts.js';
import { TemporalWorkflowExecutor } from './executor.js';

const temporalMocks = vi.hoisted(() => {
  const close = vi.fn();
  const connect = vi.fn();
  const start = vi.fn();
  return { close, connect, start };
});

vi.mock('@temporalio/client', () => {
  return {
    Connection: {
      connect: temporalMocks.connect,
    },
    Client: vi.fn(function Client() {
      return {
        workflow: {
          start: temporalMocks.start,
        },
      };
    }),
  };
});

const config = {
  temporal: {
    address: 'temporal.test:7233',
    namespace: 'test',
    taskQueue: 'test-queue',
    workflowIdPrefix: 'test-drs',
  },
  workflows: {
    sample: {
      inputs: {
        mode: { type: 'enum', values: ['quick', 'full'], default: 'quick' },
      },
      output: 'done',
      nodes: {
        first: {
          action: 'write',
          input: '{{inputs.mode}}',
          writes: 'out.txt',
          output: 'done',
        },
      },
    },
  },
} as unknown as DRSConfig;

describe('TemporalWorkflowExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    temporalMocks.close.mockResolvedValue(undefined);
    temporalMocks.connect.mockResolvedValue({ close: temporalMocks.close });
    temporalMocks.start.mockResolvedValue({
      workflowId: 'wf-id',
      firstExecutionRunId: 'run-id',
      result: vi.fn().mockResolvedValue({
        timestamp: '2026-06-28T00:00:00.000Z',
        workflow: 'sample',
        inputs: { mode: 'quick' },
        nodes: {},
        artifacts: {},
        loop: {},
        output: 'ok',
      }),
    });
  });

  it('starts a Temporal workflow and closes the connection after waiting', async () => {
    const result = await new TemporalWorkflowExecutor().run(config, 'sample', {
      workingDir: process.cwd(),
      jsonOutput: true,
    });

    expect(temporalMocks.connect).toHaveBeenCalledWith({ address: 'temporal.test:7233' });
    expect(temporalMocks.start).toHaveBeenCalledWith(
      'drsWorkflow',
      expect.objectContaining({
        taskQueue: 'test-queue',
        workflowId: expect.stringMatching(/^test-drs-sample-/),
      })
    );
    expect(result.output).toBe('ok');
    expect(temporalMocks.close).toHaveBeenCalledTimes(1);
  });

  it('supports --no-wait and still closes the connection', async () => {
    const result = await new TemporalWorkflowExecutor().run(config, 'sample', {
      workingDir: process.cwd(),
      wait: false,
      jsonOutput: true,
    });

    expect(result.output).toEqual({ workflowId: 'wf-id', runId: 'run-id' });
    expect(temporalMocks.close).toHaveBeenCalledTimes(1);
  });

  it('saves a Temporal workflow trace artifact when tracing is enabled', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'drs-temporal-trace-'));
    try {
      const result = await new TemporalWorkflowExecutor().run(config, 'sample', {
        workingDir,
        jsonOutput: true,
        trace: true,
      });

      const { artifact } = await loadWorkflowArtifact<Record<string, unknown>>(
        workingDir,
        'trace',
        {
          platform: 'temporal',
          projectId: 'sample',
          subject: 'trace',
        }
      );

      expect(result.output).toBe('ok');
      expect(artifact.payload).toMatchObject({
        schemaVersion: 1,
        executor: 'temporal',
        workflowName: 'sample',
        temporal: {
          workflowId: 'wf-id',
          runId: 'run-id',
          namespace: 'test',
          taskQueue: 'test-queue',
        },
        completedAt: '2026-06-28T00:00:00.000Z',
        inputs: { mode: 'quick' },
        nodes: {},
        artifacts: {},
        loop: {},
        output: 'ok',
      });
      expect(artifact.scope).toEqual({
        platform: 'temporal',
        projectId: 'sample',
        subject: 'trace',
      });
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('validates compiled-plan inputs before dispatching', async () => {
    await expect(
      new TemporalWorkflowExecutor().run(config, 'sample', {
        workingDir: process.cwd(),
        inputs: { mode: 'slow' },
      })
    ).rejects.toThrow('Workflow input "mode" must be one of: quick, full.');
    expect(temporalMocks.connect).not.toHaveBeenCalled();
  });
});
