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

  it('ignores file headers before the first hunk', () => {
    const info = parseDiffLineInfo(
      [
        'diff --git a/file.ts b/file.ts',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -0,0 +1,3 @@',
        '+one',
        '+two',
        '+three',
      ].join('\n')
    );

    expect([...info.addedLines]).toEqual([1, 2, 3]);
    expect([...info.commentableLines]).toEqual([1, 2, 3]);
  });

  it('does not count file headers in modified files', () => {
    const info = parseDiffLineInfo(
      [
        'diff --git a/file.ts b/file.ts',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,2 +1,2 @@',
        ' unchanged',
        '-old',
        '+new',
      ].join('\n')
    );

    expect([...info.addedLines]).toEqual([2]);
    expect([...info.commentableLines]).toEqual([1, 2]);
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
