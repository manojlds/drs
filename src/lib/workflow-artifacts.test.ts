import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertSafeArtifactId,
  createWorkflowArtifactId,
  loadWorkflowArtifact,
  saveWorkflowArtifact,
  updateWorkflowArtifact,
  workflowArtifactExists,
  type WorkflowArtifactEnvelope,
} from './workflow-artifacts.js';

const REVIEW_SCOPE = {
  platform: 'github',
  projectId: 'owner/repo',
  changeKind: 'pr',
  changeNumber: 1,
} as const;

describe('assertSafeArtifactId', () => {
  it.each([
    'art_20240101120000999_a1b2c3',
    'rev_20240101120000999_x9y8z7',
    `art_${'20240101120000999'.padStart(14, '0')}_abcdef0`,
    `rev_${'20240101120000999'.padStart(14, '0')}_000000`,
  ])('accepts canonical id %s', (id) => {
    expect(() => assertSafeArtifactId(id)).not.toThrow();
    expect(() => assertSafeArtifactId(id, 'write')).not.toThrow();
  });

  it.each([
    '../../../etc/passwd',
    '../../etc/passwd',
    '../etc/passwd',
    '../../foo.json',
    '/etc/passwd',
    '/absolute/path',
    'foo',
    'art_123',
    'art_abc_def',
    '',
    'latest',
    'aRt_20240101120000999_a1b2c3.json',
    'art/20240101120000999/a1b2c3',
  ])('rejects id %s', (id) => {
    expect(() => assertSafeArtifactId(id)).toThrow(/invalid id/);
  });

  it('rejects non-string inputs at runtime', () => {
    expect(() => assertSafeArtifactId(undefined)).toThrow(/invalid id/);
    expect(() => assertSafeArtifactId(null)).toThrow(/invalid id/);
    expect(() => assertSafeArtifactId(123)).toThrow(/invalid id/);
  });
});

describe('workflow artifact fs operations enforce canonical id', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), 'drs-workflow-artifacts-'));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it('save auto-generates a canonical id and round-trips via latest', async () => {
    const saved = await saveWorkflowArtifact<{ hello: string }>(workingDir, {
      kind: 'review',
      scope: REVIEW_SCOPE,
      payload: { hello: 'world' },
    });
    expect(saved.artifact.id).toMatch(/^art_[0-9]+_[a-z0-9]+$/);
    expect(saved.artifact.kind).toBe('review');

    const loaded = await loadWorkflowArtifact<{ hello: string }>(
      workingDir,
      'review',
      saved.artifact.scope
    );
    expect(loaded.artifact.id).toBe(saved.artifact.id);
    expect(loaded.artifact.payload).toEqual({ hello: 'world' });
  });

  it('save accepts an explicit canonical id and round-trips by id', async () => {
    const id = createWorkflowArtifactId();
    await saveWorkflowArtifact(workingDir, {
      kind: 'annotation',
      scope: REVIEW_SCOPE,
      payload: { marker: 'A' },
      id,
    });

    const loaded = await loadWorkflowArtifact(workingDir, 'annotation', REVIEW_SCOPE, id);
    expect(loaded.artifact.id).toBe(id);
    expect(loaded.artifact.payload).toEqual({ marker: 'A' });
  });

  it('save rejects explicit non-canonical id', async () => {
    await expect(
      saveWorkflowArtifact(workingDir, {
        kind: 'annotation',
        scope: REVIEW_SCOPE,
        payload: { marker: 'A' },
        id: '../../../tmp/evil.json',
      })
    ).rejects.toThrow(/invalid id/);
  });

  it('load rejects traversal-style ids', async () => {
    await saveWorkflowArtifact(workingDir, {
      kind: 'review',
      scope: REVIEW_SCOPE,
      payload: { hello: 'world' },
    });
    await expect(
      loadWorkflowArtifact(workingDir, 'review', REVIEW_SCOPE, '../../../tmp/evil.json')
    ).rejects.toThrow(/invalid id/);
  });

  it('load rejects absolute ids', async () => {
    await expect(
      loadWorkflowArtifact(workingDir, 'review', REVIEW_SCOPE, '/etc/passwd')
    ).rejects.toThrow(/invalid id/);
  });

  it('load rejects a tampered id in latest.json', async () => {
    const saved = await saveWorkflowArtifact(workingDir, {
      kind: 'review',
      scope: REVIEW_SCOPE,
      payload: { hello: 'world' },
    });
    await writeFile(
      saved.latestPath,
      JSON.stringify({ ...saved.artifact, id: '../../../tmp/evil.json' }),
      'utf-8'
    );

    await expect(loadWorkflowArtifact(workingDir, 'review', REVIEW_SCOPE)).rejects.toThrow(
      /invalid id/
    );
  });

  it('load rejects a scope mismatch in latest.json', async () => {
    const saved = await saveWorkflowArtifact(workingDir, {
      kind: 'review',
      scope: REVIEW_SCOPE,
      payload: { hello: 'world' },
    });
    await writeFile(
      saved.latestPath,
      JSON.stringify({
        ...saved.artifact,
        scope: { ...saved.artifact.scope, changeNumber: 2 },
      }),
      'utf-8'
    );

    await expect(loadWorkflowArtifact(workingDir, 'review', REVIEW_SCOPE)).rejects.toThrow(
      /scope does not match/
    );
  });

  it('update accepts envelopes with canonical rev_* ids', async () => {
    const envelope: WorkflowArtifactEnvelope = {
      schemaVersion: 1,
      kind: 'review',
      id: 'rev_20240101120000999_a1b2c3',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      scope: REVIEW_SCOPE,
      payload: { schemaVersion: 1, reviewId: 'rev_orig' },
    };
    const updated = await updateWorkflowArtifact(workingDir, {
      artifact: envelope,
      payload: { schemaVersion: 1, reviewId: 'rev_new' },
    });
    expect(updated.artifact.id).toBe(envelope.id);
    expect((updated.artifact.payload as { reviewId: string }).reviewId).toBe('rev_new');
  });

  it('update rejects envelopes with non-canonical ids', async () => {
    const envelope = {
      schemaVersion: 1,
      kind: 'review',
      id: '../../../etc/passwd',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      scope: REVIEW_SCOPE,
      payload: {},
    };
    await expect(
      updateWorkflowArtifact(workingDir, {
        artifact: envelope as WorkflowArtifactEnvelope,
        payload: {},
      })
    ).rejects.toThrow(/invalid id/);
  });

  it('workflowArtifactExists returns true for existing canonical id', async () => {
    const saved = await saveWorkflowArtifact(workingDir, {
      kind: 'review',
      scope: REVIEW_SCOPE,
      payload: { hello: 'world' },
    });
    await expect(
      workflowArtifactExists(workingDir, 'review', saved.artifact.scope, saved.artifact.id)
    ).resolves.toBe(true);
  });

  it('workflowArtifactExists returns false for missing canonical id', async () => {
    await expect(
      workflowArtifactExists(workingDir, 'review', REVIEW_SCOPE, createWorkflowArtifactId())
    ).resolves.toBe(false);
  });

  it('workflowArtifactExists throws on non-canonical id rather than silently returning false', async () => {
    await expect(
      workflowArtifactExists(workingDir, 'review', REVIEW_SCOPE, '../../../tmp/evil.json')
    ).rejects.toThrow(/invalid id/);
  });
});
