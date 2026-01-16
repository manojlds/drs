import { describe, expect, it } from 'vitest';
import {
  compressFilesWithDiffs,
  formatCompressionSummary,
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
