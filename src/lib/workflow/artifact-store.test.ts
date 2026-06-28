import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'fs/promises';
import {
  type ArtifactInliningPolicy,
  DEFAULT_ARTIFACT_POLICY,
  isArtifactRef,
  LocalWorkflowArtifactStore,
  shouldInline,
  type TemporalArtifactRef,
} from './artifact-store.js';

describe('artifact store', () => {
  describe('isArtifactRef', () => {
    it('identifies a well-formed ref', () => {
      const ref: TemporalArtifactRef = {
        kind: 'artifact-ref',
        key: 'diff',
        uri: '.drs/artifacts/temporal/default/diff.json',
        sizeBytes: 100,
        sha256: 'abc',
      };
      expect(isArtifactRef(ref)).toBe(true);
    });

    it('rejects non-ref values', () => {
      expect(isArtifactRef(null)).toBe(false);
      expect(isArtifactRef(undefined)).toBe(false);
      expect(isArtifactRef('hello')).toBe(false);
      expect(isArtifactRef({ kind: 'other', key: 'x', uri: 'y' })).toBe(false);
    });
  });

  describe('shouldInline', () => {
    it('inlines everything in inline-only mode', () => {
      const policy: ArtifactInliningPolicy = { mode: 'inline-only', inlineMaxBytes: 0 };
      expect(shouldInline(999999, policy)).toBe(true);
    });

    it('offloads everything in ref-all-values mode', () => {
      const policy: ArtifactInliningPolicy = { mode: 'ref-all-values', inlineMaxBytes: 999999 };
      expect(shouldInline(1, policy)).toBe(false);
    });

    it('respects inlineMaxBytes in ref-large-values mode', () => {
      const policy: ArtifactInliningPolicy = { mode: 'ref-large-values', inlineMaxBytes: 100 };
      expect(shouldInline(50, policy)).toBe(true);
      expect(shouldInline(101, policy)).toBe(false);
    });
  });

  describe('LocalWorkflowArtifactStore', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'drs-artifact-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    describe('string values', () => {
      it('persists a string and hydrates it back unchanged', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'test');
        const ref = await store.put('diff', '--- diff content ---');

        expect(ref.kind).toBe('artifact-ref');
        expect(ref.key).toBe('diff');
        expect(ref.uri).toContain('.drs/artifacts/temporal/test/');
        expect(ref.contentType).toBe('text/plain');
        expect(ref.sizeBytes).toBe(20);
        expect(ref.sha256).toHaveLength(64);

        const value = await store.get(ref);
        expect(value).toBe('--- diff content ---');
      });

      it('reports existence', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'test');
        const ref = await store.put('x', 'hello');
        expect(await store.exists(ref)).toBe(true);
      });

      it('returns false for missing artifact', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'test');
        expect(
          await store.exists({
            kind: 'artifact-ref',
            key: 'missing',
            uri: '.drs/artifacts/temporal/test/missing.json',
          })
        ).toBe(false);
      });
    });

    describe('object values', () => {
      it('persists a JSON object and hydrates it back unchanged', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'owi');
        const payload = {
          files: ['src/app.ts', 'src/lib.ts'],
          issues: [
            { severity: 'HIGH', title: 'Bug', line: 10 },
            { severity: 'LOW', title: 'Style', line: 20 },
          ],
        };
        const ref = await store.put('review', payload);

        expect(ref.contentType).toBe('application/json');
        expect(ref.sizeBytes).toBeGreaterThan(0);

        const value = await store.get(ref);
        expect(value).toEqual(payload);
      });
    });

    describe('fingerprint integrity', () => {
      it('produces a sha256 matching the file content', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'int');
        const content = 'checksum me';
        const ref = await store.put('data', content);

        const fileContents = await readFile(join(tempDir, ref.uri), 'utf-8');
        // Re-create a ref with only the data needed for get
        const expectedHash = ref.sha256;
        expect(fileContents).toBe(content);
        // sha256 of the exact string content
        const { createHash } = await import('crypto');
        const actualHash = createHash('sha256').update(fileContents).digest('hex');
        expect(actualHash).toBe(expectedHash);
      });
    });

    describe('special characters', () => {
      it('sanitizes keys with unsafe characters', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'safe');
        const ref = await store.put('my/weird key!!', 'value');
        expect(ref.uri).not.toContain('!!');
        expect(ref.uri).not.toContain(' ');
        expect(await store.get(ref)).toBe('value');
      });
    });

    describe('path traversal protection', () => {
      it('rejects keys with .. segments', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'test');
        await expect(store.put('../../etc/passwd', 'evil')).rejects.toThrow(/unsafe key/);
      });

      it('rejects keys with . segments', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'test');
        await expect(store.put('./foo', 'evil')).rejects.toThrow(/unsafe key/);
      });

      it('sanitizes unsafe namespace characters', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, '../../etc');
        const ref = await store.put('safe', 'value');
        const segments = ref.uri.split('/');
        expect(segments.some((s) => s === '..' || s === '.')).toBe(false);
        expect(await store.get(ref)).toBe('value');
      });

      it('still allows slash-separated keys without .. or .', async () => {
        const store = new LocalWorkflowArtifactStore(tempDir, 'test');
        const ref = await store.put('my/nested/key', 'value');
        expect(ref.uri).toContain('my/nested/key');
        expect(await store.get(ref)).toBe('value');
      });
    });
  });

  describe('DEFAULT_ARTIFACT_POLICY', () => {
    it('defaults to ref-large-values with a 64KB threshold', () => {
      expect(DEFAULT_ARTIFACT_POLICY.mode).toBe('ref-large-values');
      expect(DEFAULT_ARTIFACT_POLICY.inlineMaxBytes).toBe(65536);
    });
  });
});
