import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runWorkflowNodeActivity,
  hydrateContextActivity,
  hydrateContext,
  resolveActivityIdempotencyContext,
} from './activities.js';
import type { RunWorkflowNodeActivityInput } from './types.js';
import type { WorkflowTemplateContext } from '../lib/workflow/types.js';
import { isArtifactRef, LocalWorkflowArtifactStore } from '../lib/workflow/artifact-store.js';
import { configureLogger } from '../lib/logger.js';

vi.mock('../cli/workflow.js', () => ({
  runWorkflowNodeLocally: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

import { runWorkflowNodeLocally } from '../cli/workflow.js';

describe('activities artifact offloading', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'drs-activity-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns inline result when offloadArtifacts is false', async () => {
    const nodeResult = { id: 'test', type: 'agent' as const, response: 'small value' };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);

    const input: RunWorkflowNodeActivityInput = {
      workingDir: tempDir,
      nodeId: 'test',
      node: { agent: 'task/test', input: 'test' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      offloadArtifacts: false,
    };

    const result = await runWorkflowNodeActivity(input);
    expect(result.response).toBe('small value');
    expect(isArtifactRef(result.response)).toBe(false);
  });

  it('offloads large string response as artifact ref', async () => {
    const largeValue = 'x'.repeat(100 * 1024);
    const nodeResult = { id: 'test', type: 'agent' as const, response: largeValue };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);

    const input: RunWorkflowNodeActivityInput = {
      workingDir: tempDir,
      nodeId: 'test',
      node: { agent: 'task/test', input: 'test' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      offloadArtifacts: true,
      artifactInlineMaxBytes: 1024,
    };

    const result = await runWorkflowNodeActivity(input);
    expect(isArtifactRef(result.response)).toBe(true);

    // Verify the ref can be hydrated
    const ref = result.response as unknown as { kind: string; uri: string };
    const store = new LocalWorkflowArtifactStore(tempDir, 'test');
    const hydrated = await store.get({ kind: 'artifact-ref', key: 'test-response', uri: ref.uri });
    expect(hydrated).toBe(largeValue);
  });

  it('keeps small output inline even with offloadArtifacts', async () => {
    const nodeResult = { id: 'test', type: 'agent' as const, response: 'small' };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);

    const input: RunWorkflowNodeActivityInput = {
      workingDir: tempDir,
      nodeId: 'test',
      node: { agent: 'task/test', input: 'test' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      offloadArtifacts: true,
      artifactInlineMaxBytes: 1024,
    };

    const result = await runWorkflowNodeActivity(input);
    expect(result.response).toBe('small');
    expect(isArtifactRef(result.response)).toBe(false);
  });

  it('offloads large output field', async () => {
    const largeObject = { data: 'x'.repeat(100 * 1024) };
    const nodeResult = {
      id: 'test',
      type: 'action' as const,
      action: 'review',
      output: largeObject,
    };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);

    const input: RunWorkflowNodeActivityInput = {
      workingDir: tempDir,
      nodeId: 'test',
      node: { agent: 'task/test', input: 'test' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      offloadArtifacts: true,
      artifactInlineMaxBytes: 1024,
    };

    const result = await runWorkflowNodeActivity(input);
    expect(isArtifactRef(result.output)).toBe(true);
  });

  it('offloads large outputs map values individually', async () => {
    const nodeResult = {
      id: 'test',
      type: 'action' as const,
      action: 'review',
      outputs: {
        small: 'ok',
        big: 'y'.repeat(100 * 1024),
      },
    };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);

    const input: RunWorkflowNodeActivityInput = {
      workingDir: tempDir,
      nodeId: 'test',
      node: { agent: 'task/test', input: 'test' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      offloadArtifacts: true,
      artifactInlineMaxBytes: 1024,
    };

    const result = await runWorkflowNodeActivity(input);
    expect(result.outputs).toBeDefined();
    expect(result.outputs!['small']).toBe('ok');
    expect(isArtifactRef(result.outputs!['big'])).toBe(true);
  });
});

describe('resolveActivityIdempotencyContext', () => {
  afterEach(() => {
    configureLogger({ level: 'info', format: 'human', timestamps: false, colors: false });
  });

  it('returns undefined when no scheduled idempotency context is present', () => {
    const input: RunWorkflowNodeActivityInput = {
      workingDir: '/repo',
      nodeId: 'node',
      node: { action: 'git-diff' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
    };

    expect(resolveActivityIdempotencyContext(input)).toBeUndefined();
  });

  it('fills attempt from scheduled context when not running inside Temporal activity context', () => {
    const input: RunWorkflowNodeActivityInput = {
      workingDir: '/repo',
      nodeId: 'node',
      node: { action: 'git-diff' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      idempotencyContext: {
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'node',
        attempt: 3,
        idempotencyKey: 'workflow-1:run-1:node',
      },
    };

    expect(resolveActivityIdempotencyContext(input)).toEqual({
      workflowId: 'workflow-1',
      runId: 'run-1',
      nodeId: 'node',
      attempt: 3,
      idempotencyKey: 'workflow-1:run-1:node',
    });
  });

  it('defaults attempt to 1 for direct calls without Temporal context', () => {
    const input: RunWorkflowNodeActivityInput = {
      workingDir: '/repo',
      nodeId: 'node',
      node: { action: 'git-diff' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      idempotencyContext: {
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'node',
        idempotencyKey: 'workflow-1:run-1:node',
      },
    };

    expect(resolveActivityIdempotencyContext(input)).toMatchObject({ attempt: 1 });
  });

  it('passes resolved idempotency context into local node execution options', async () => {
    const nodeResult = { id: 'test', type: 'action' as const, action: 'git-diff', output: 'diff' };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);
    const input: RunWorkflowNodeActivityInput = {
      workingDir: '/repo',
      nodeId: 'test',
      node: { action: 'git-diff' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      idempotencyContext: {
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'test',
        idempotencyKey: 'workflow-1:run-1:test',
      },
    };

    await runWorkflowNodeActivity(input);

    expect(runWorkflowNodeLocally).toHaveBeenCalledWith(
      expect.anything(),
      'test',
      input.node,
      expect.objectContaining({
        idempotencyContext: {
          workflowId: 'workflow-1',
          runId: 'run-1',
          nodeId: 'test',
          attempt: 1,
          idempotencyKey: 'workflow-1:run-1:test',
        },
      }),
      '/repo',
      input.context
    );
  });

  it('logs Temporal activity context for node execution', async () => {
    configureLogger({ level: 'debug', format: 'json', timestamps: true, colors: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const nodeResult = { id: 'test', type: 'action' as const, action: 'git-diff', output: 'diff' };
    vi.mocked(runWorkflowNodeLocally).mockResolvedValue(nodeResult);
    const input: RunWorkflowNodeActivityInput = {
      workingDir: '/repo',
      nodeId: 'test',
      node: { action: 'git-diff' },
      context: { inputs: {}, nodes: {}, artifacts: {}, loop: {} },
      idempotencyContext: {
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'test',
        attempt: 2,
        idempotencyKey: 'workflow-1:run-1:test',
      },
    };

    try {
      await runWorkflowNodeActivity(input);

      const entries = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(entries).toEqual([
        expect.objectContaining({
          level: 'debug',
          message: 'Temporal activity started',
          context: expect.objectContaining({
            component: 'temporal-activity',
            workflowId: 'workflow-1',
            runId: 'run-1',
            nodeId: 'test',
            attempt: 2,
            action: 'git-diff',
          }),
        }),
        expect.objectContaining({
          level: 'debug',
          message: 'Temporal activity completed',
          context: expect.objectContaining({
            component: 'temporal-activity',
            workflowId: 'workflow-1',
            runId: 'run-1',
            nodeId: 'test',
            attempt: 2,
            action: 'git-diff',
          }),
          data: expect.objectContaining({ status: 'success' }),
        }),
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('hydrateContextActivity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'drs-hydrate-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns hydrated artifact refs without mutating input', async () => {
    const store = new LocalWorkflowArtifactStore(tempDir, 'temporal');
    const originalValue = 'large content';
    const ref = await store.put('node-output', originalValue);

    const context: WorkflowTemplateContext = {
      inputs: {},
      nodes: {},
      artifacts: { review: ref },
      loop: {},
    };

    const hydrated = await hydrateContextActivity({ workingDir: tempDir, context });
    expect(hydrated.artifacts['review']).toBe(originalValue);
    expect(context.artifacts['review']).toBe(ref);
  });

  it('leaves non-ref artifacts unchanged', async () => {
    const context: WorkflowTemplateContext = {
      inputs: {},
      nodes: {},
      artifacts: { count: 42, name: 'test' },
      loop: {},
    };

    const hydrated = await hydrateContextActivity({ workingDir: tempDir, context });
    expect(hydrated.artifacts['count']).toBe(42);
    expect(hydrated.artifacts['name']).toBe('test');
  });
});

describe('hydrateContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'drs-hydrate-ctx-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('hydrates artifact refs in-place', async () => {
    const store = new LocalWorkflowArtifactStore(tempDir, 'temporal');
    const originalValue = 'hydrated value';
    const ref = await store.put('artifact', originalValue);

    const context: Record<string, unknown> = { artifact: ref };
    await hydrateContext(context, store);
    expect(context['artifact']).toBe(originalValue);
  });

  it('leaves non-ref values unchanged', async () => {
    const store = new LocalWorkflowArtifactStore(tempDir, 'temporal');
    const context: Record<string, unknown> = { count: 7, text: 'hello' };
    await hydrateContext(context, store);
    expect(context['count']).toBe(7);
    expect(context['text']).toBe('hello');
  });
});
