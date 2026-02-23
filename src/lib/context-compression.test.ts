import { describe, expect, it } from 'vitest';
import {
  compressFilesWithDiffs,
  filterGeneratedFiles,
  formatCompressionSummary,
  prepareDiffsForAgent,
  resolveCompressionBudget,
  stripDeletionOnlyHunks,
} from './context-compression.js';

describe('context compression', () => {
  it('removes deletion-only hunks', () => {
    const patch = ['@@ -1,3 +1,0 @@', '-const remove = true;', '-const gone = false;'].join('\n');
    expect(stripDeletionOnlyHunks(patch)).toBe('');
  });

  it('keeps hunks with additions', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' const keep = true;',
      '+const added = true;',
      '-const removed = false;',
    ].join('\n');
    expect(stripDeletionOnlyHunks(patch)).toContain('+const added = true;');
  });

  it('omits patches that exceed token budget', () => {
    const files = [
      { filename: 'src/large.ts', patch: '@@ -1,1 +1,3 @@\n+foo\n+bar\n+baz' },
      { filename: 'src/small.ts', patch: '@@ -1,1 +1,2 @@\n+ok' },
    ];

    const result = compressFilesWithDiffs(files, {
      maxTokens: 10,
      softBufferTokens: 2,
      hardBufferTokens: 1,
      tokenEstimateDivisor: 1,
    });

    const summary = formatCompressionSummary(result);
    expect(summary).toContain('Omitted due to token budget');
    expect(result.files.find((file) => file.filename === 'src/large.ts')?.patch).toBeUndefined();
  });
});

describe('filterGeneratedFiles', () => {
  it('excludes files with @generated marker', () => {
    const files = [
      { filename: 'src/api.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;' },
      { filename: 'src/gen.ts', patch: '@@ -1,1 +1,2 @@\n+// @generated\n+const y = 2;' },
    ];
    const { kept, generated } = filterGeneratedFiles(files);
    expect(kept).toHaveLength(1);
    expect(kept[0].filename).toBe('src/api.ts');
    expect(generated).toEqual(['src/gen.ts']);
  });

  it('excludes files with DO NOT EDIT marker', () => {
    const files = [
      { filename: 'proto/api.pb.go', patch: '@@ -1,1 +1,2 @@\n+// DO NOT EDIT\n+package api' },
    ];
    const { kept, generated } = filterGeneratedFiles(files);
    expect(kept).toHaveLength(0);
    expect(generated).toEqual(['proto/api.pb.go']);
  });

  it('keeps files without generated markers', () => {
    const files = [
      { filename: 'src/index.ts', patch: '@@ -1,1 +1,2 @@\n+export {}' },
      { filename: 'src/utils.ts', patch: '@@ -1,1 +1,2 @@\n+const a = 1;' },
    ];
    const { kept, generated } = filterGeneratedFiles(files);
    expect(kept).toHaveLength(2);
    expect(generated).toHaveLength(0);
  });

  it('keeps files without patches', () => {
    const files = [{ filename: 'src/no-patch.ts' }];
    const { kept, generated } = filterGeneratedFiles(files);
    expect(kept).toHaveLength(1);
    expect(generated).toHaveLength(0);
  });
});

describe('resolveCompressionBudget', () => {
  it('computes maxTokens from thresholdPercent and contextWindow', () => {
    const result = resolveCompressionBudget(200000, { thresholdPercent: 0.15, maxTokens: 32000 });
    expect(result.maxTokens).toBe(30000);
  });

  it('falls back to static maxTokens when contextWindow is undefined', () => {
    const result = resolveCompressionBudget(undefined, {
      thresholdPercent: 0.15,
      maxTokens: 32000,
    });
    expect(result.maxTokens).toBe(32000);
  });

  it('falls back to static maxTokens when thresholdPercent is zero', () => {
    const result = resolveCompressionBudget(200000, { thresholdPercent: 0, maxTokens: 32000 });
    expect(result.maxTokens).toBe(32000);
  });

  it('falls back to static maxTokens when thresholdPercent is not set', () => {
    const result = resolveCompressionBudget(200000, { maxTokens: 32000 });
    expect(result.maxTokens).toBe(32000);
  });

  it('returns empty options when options is undefined', () => {
    const result = resolveCompressionBudget(200000);
    expect(result).toEqual({});
  });

  it('scales with different context window sizes', () => {
    const small = resolveCompressionBudget(8000, { thresholdPercent: 0.2, maxTokens: 32000 });
    const large = resolveCompressionBudget(1000000, { thresholdPercent: 0.2, maxTokens: 32000 });
    expect(small.maxTokens).toBe(1600);
    expect(large.maxTokens).toBe(200000);
  });

  it('scales buffers when computed maxTokens is smaller than configured maxTokens', () => {
    const result = resolveCompressionBudget(100000, {
      thresholdPercent: 0.1,
      maxTokens: 32000,
      softBufferTokens: 1500,
      hardBufferTokens: 1000,
      tokenEstimateDivisor: 4,
    });
    expect(result.maxTokens).toBe(10000);
    expect(result.softBufferTokens).toBe(468);
    expect(result.hardBufferTokens).toBe(312);
    expect(result.tokenEstimateDivisor).toBe(4);
  });

  it('keeps configured buffers when computed maxTokens is larger than configured maxTokens', () => {
    const result = resolveCompressionBudget(1000000, {
      thresholdPercent: 0.2,
      maxTokens: 32000,
      softBufferTokens: 1500,
      hardBufferTokens: 1000,
      tokenEstimateDivisor: 4,
    });
    expect(result.maxTokens).toBe(200000);
    expect(result.softBufferTokens).toBe(1500);
    expect(result.hardBufferTokens).toBe(1000);
    expect(result.tokenEstimateDivisor).toBe(4);
  });
});

describe('prepareDiffsForAgent', () => {
  it('filters generated files then compresses', () => {
    const files = [
      { filename: 'src/real.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;' },
      { filename: 'src/gen.ts', patch: '@@ -1,1 +1,2 @@\n+// @generated\n+const y = 2;' },
    ];
    const result = prepareDiffsForAgent(files);
    expect(result.omitted.generated).toEqual(['src/gen.ts']);
    expect(result.files.find((f) => f.filename === 'src/gen.ts')).toBeUndefined();
    expect(result.files.find((f) => f.filename === 'src/real.ts')).toBeDefined();
  });

  it('includes generated files in compression summary', () => {
    const files = [{ filename: 'src/gen.ts', patch: '@@ -1,1 +1,2 @@\n+// @generated' }];
    const result = prepareDiffsForAgent(files);
    const summary = formatCompressionSummary(result);
    expect(summary).toContain('Auto-excluded generated files');
    expect(summary).toContain('src/gen.ts');
  });

  it('combines generated filtering with budget compression', () => {
    const files = [
      { filename: 'src/gen.ts', patch: '@@ -1,1 +1,2 @@\n+// @generated' },
      { filename: 'src/large.ts', patch: '@@ -1,1 +1,3 @@\n+foo\n+bar\n+baz' },
      { filename: 'src/small.ts', patch: '@@ -1,1 +1,2 @@\n+ok' },
    ];
    const result = prepareDiffsForAgent(files, {
      maxTokens: 10,
      softBufferTokens: 2,
      hardBufferTokens: 1,
      tokenEstimateDivisor: 1,
    });
    expect(result.omitted.generated).toEqual(['src/gen.ts']);
    expect(result.omitted.dueToBudget.length).toBeGreaterThan(0);
  });

  it('retains small diffs when dynamic maxTokens is lower than static buffers', () => {
    const files = [{ filename: 'src/small.ts', patch: '@@ -1,0 +1,1 @@\n+ok' }];

    const options = resolveCompressionBudget(8000, {
      enabled: true,
      maxTokens: 32000,
      thresholdPercent: 0.15,
      softBufferTokens: 1500,
      hardBufferTokens: 1000,
      tokenEstimateDivisor: 4,
    });

    const result = prepareDiffsForAgent(files, options);

    expect(result.files[0].patch).toContain('+ok');
    expect(result.omitted.dueToBudget).toEqual([]);
  });
});
