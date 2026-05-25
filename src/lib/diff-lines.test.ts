import { describe, expect, it } from 'vitest';
import { parseValidLinesFromDiff, parseValidLinesFromPatch } from './diff-lines.js';

describe('diff-lines', () => {
  it('returns added and context lines from unified patches', () => {
    const lines = parseValidLinesFromPatch(
      ['@@ -1,3 +10,4 @@', ' context', '-old', '+new'].join('\n')
    );

    expect([...lines]).toEqual([10, 11]);
  });

  it('uses the same parser for GitLab diffs', () => {
    const lines = parseValidLinesFromDiff(['@@ -0,0 +1,2 @@', '+first', '+second'].join('\n'));

    expect([...lines]).toEqual([1, 2]);
  });
});
