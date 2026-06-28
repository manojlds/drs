import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkflowNodeActivity, hydrateContextActivity } from './activities.js';
import type { RunWorkflowNodeActivityInput } from './types.js';
import type { WorkflowTemplateContext } from '../lib/workflow/types.js';
import { isArtifactRef, LocalWorkflowArtifactStore } from '../lib/workflow/artifact-store.js';

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

describe('hydrateContextActivity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'drs-hydrate-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('hydrates artifact refs in context artifacts in-place', async () => {
    const store = new LocalWorkflowArtifactStore(tempDir, 'temporal');
    const originalValue = 'large content';
    const ref = await store.put('node-output', originalValue);

    const context: WorkflowTemplateContext = {
      inputs: {},
      nodes: {},
      artifacts: { review: ref },
      loop: {},
    };

    await hydrateContextActivity({ workingDir: tempDir, context });
    expect(context.artifacts['review']).toBe(originalValue);
  });

  it('leaves non-ref artifacts unchanged', async () => {
    const context: WorkflowTemplateContext = {
      inputs: {},
      nodes: {},
      artifacts: { count: 42, name: 'test' },
      loop: {},
    };

    await hydrateContextActivity({ workingDir: tempDir, context });
    expect(context.artifacts['count']).toBe(42);
    expect(context.artifacts['name']).toBe('test');
  });
});
