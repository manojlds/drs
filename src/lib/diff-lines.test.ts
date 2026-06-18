import { describe, expect, it } from 'vitest';
import {
  parseAddedLinesFromDiff,
  parseAddedLinesFromPatch,
  parseDiffLineInfo,
  parseValidLinesFromDiff,
  parseValidLinesFromPatch,
} from './diff-lines.js';

describe('diff-lines', () => {
  it('returns added and context lines from unified patches', () => {
    const lines = parseValidLinesFromPatch(
      ['@@ -1,3 +10,4 @@', ' context', '-old', '+new'].join('\n')
    );

    expect([...lines]).toEqual([10, 11]);
  });

  it('returns only added lines for strict changed-line validation', () => {
    const lines = parseAddedLinesFromPatch(
      ['@@ -1,3 +10,4 @@', ' context', '-old', '+new'].join('\n')
    );

    expect([...lines]).toEqual([11]);
  });

  it('returns both strict and commentable line sets', () => {
    const info = parseDiffLineInfo(['@@ -1,3 +10,4 @@', ' context', '-old', '+new'].join('\n'));

    expect([...info.addedLines]).toEqual([11]);
    expect([...info.commentableLines]).toEqual([10, 11]);
  });

  it('uses the same parser for GitLab diffs', () => {
    const lines = parseValidLinesFromDiff(['@@ -0,0 +1,2 @@', '+first', '+second'].join('\n'));

    expect([...lines]).toEqual([1, 2]);
  });

  it('uses the added-line parser for GitLab diffs', () => {
    const lines = parseAddedLinesFromDiff(
      ['@@ -1,2 +1,3 @@', ' context', '+first', '+second'].join('\n')
    );

    expect([...lines]).toEqual([2, 3]);
  });
});
