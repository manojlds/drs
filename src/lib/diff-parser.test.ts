import { describe, it, expect } from 'vitest';
import {
  parseDiff,
  getChangedFiles,
  getAddedLines,
  diffContainsPattern,
  diffToPatch,
  getFilesWithDiffs,
} from './diff-parser.js';

// ── Fixtures ──────────────────────────────────────────────────────

const SIMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import express from 'express';
 
 const app = express();
+app.use(express.json());
 
 export default app;
`;

const MULTI_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import express from 'express';
+import cors from 'cors';
 
 const app = express();
diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -5,7 +5,7 @@
 export function add(a: number, b: number): number {
-  return a + b + 0;
+  return a + b;
 }
`;

const NEW_FILE_DIFF = `diff --git a/src/new-file.ts b/src/new-file.ts
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export const greeting = 'hello';
+
+export default greeting;
`;

const DELETED_FILE_DIFF = `diff --git a/src/old-file.ts b/src/old-file.ts
--- a/src/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const legacy = true;
-
-export default legacy;
`;

const RENAMED_FILE_DIFF = `diff --git a/src/old-name.ts b/src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
-export const name = 'old';
+export const name = 'new';
 
 export default name;
`;

const MULTI_HUNK_DIFF = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,4 +1,5 @@
 // header
+import { log } from './log';
 
 function first() {
   return 1;
@@ -20,4 +21,5 @@
 function second() {
   return 2;
 }
+// end of file
`;

// ── parseDiff ──────────────────────────────────────────────────────

describe('parseDiff', () => {
  it('parses a simple single-file diff', () => {
    const result = parseDiff(SIMPLE_DIFF);

    expect(result).toHaveLength(1);
    expect(result[0].oldPath).toBe('src/app.ts');
    expect(result[0].newPath).toBe('src/app.ts');
    expect(result[0].isNew).toBe(false);
    expect(result[0].isDeleted).toBe(false);
    expect(result[0].isRenamed).toBe(false);
    expect(result[0].hunks).toHaveLength(1);
  });

  it('extracts correct line numbers and types', () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    const hunk = file.hunks[0];

    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(5);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(6);

    const added = hunk.lines.filter((l) => l.type === 'add');
    expect(added).toHaveLength(1);
    expect(added[0].content).toBe('app.use(express.json());');
    expect(added[0].newLineNumber).toBeDefined();

    const context = hunk.lines.filter((l) => l.type === 'context');
    expect(context.length).toBeGreaterThan(0);
    expect(context[0].oldLineNumber).toBeDefined();
    expect(context[0].newLineNumber).toBeDefined();
  });

  it('parses multi-file diffs', () => {
    const result = parseDiff(MULTI_FILE_DIFF);

    expect(result).toHaveLength(2);
    expect(result[0].newPath).toBe('src/app.ts');
    expect(result[1].newPath).toBe('src/utils.ts');

    // First file: one addition
    const firstAdded = result[0].hunks[0].lines.filter((l) => l.type === 'add');
    expect(firstAdded).toHaveLength(1);
    expect(firstAdded[0].content).toBe("import cors from 'cors';");

    // Second file: one delete, one add
    const secondHunk = result[1].hunks[0];
    const deleted = secondHunk.lines.filter((l) => l.type === 'delete');
    const added = secondHunk.lines.filter((l) => l.type === 'add');
    expect(deleted).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(deleted[0].content).toBe('  return a + b + 0;');
    expect(added[0].content).toBe('  return a + b;');
  });

  it('detects new files', () => {
    const [file] = parseDiff(NEW_FILE_DIFF);

    expect(file.isNew).toBe(true);
    expect(file.isDeleted).toBe(false);
    expect(file.oldPath).toBe('/dev/null');
    expect(file.newPath).toBe('src/new-file.ts');

    const added = file.hunks[0].lines.filter((l) => l.type === 'add');
    expect(added).toHaveLength(3);
  });

  it('detects deleted files', () => {
    const [file] = parseDiff(DELETED_FILE_DIFF);

    expect(file.isDeleted).toBe(true);
    expect(file.isNew).toBe(false);
    expect(file.oldPath).toBe('src/old-file.ts');
    expect(file.newPath).toBe('/dev/null');

    const deleted = file.hunks[0].lines.filter((l) => l.type === 'delete');
    expect(deleted).toHaveLength(3);
  });

  it('parses renamed files with changes', () => {
    const [file] = parseDiff(RENAMED_FILE_DIFF);

    expect(file.oldPath).toBe('src/old-name.ts');
    expect(file.newPath).toBe('src/new-name.ts');
  });

  it('handles multiple hunks in a single file', () => {
    const [file] = parseDiff(MULTI_HUNK_DIFF);

    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0].oldStart).toBe(1);
    expect(file.hunks[0].newStart).toBe(1);
    expect(file.hunks[1].oldStart).toBe(20);
    expect(file.hunks[1].newStart).toBe(21);
  });

  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('returns empty array for non-diff text', () => {
    expect(parseDiff('just some random text\nwith multiple lines\n')).toEqual([]);
  });

  it('handles hunk header without line count (single-line hunks)', () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new
`;
    const [file] = parseDiff(diff);
    const hunk = file.hunks[0];
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newLines).toBe(1);
  });

  it('tracks line numbers correctly across adds and deletes', () => {
    const diff = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -10,5 +10,6 @@
 context line
-deleted line
+added line 1
+added line 2
 another context
 final line
`;
    const [file] = parseDiff(diff);
    const lines = file.hunks[0].lines;

    // context at old:10, new:10
    expect(lines[0]).toMatchObject({ type: 'context', oldLineNumber: 10, newLineNumber: 10 });
    // delete at old:11
    expect(lines[1]).toMatchObject({ type: 'delete', oldLineNumber: 11 });
    // adds at new:11, new:12
    expect(lines[2]).toMatchObject({ type: 'add', newLineNumber: 11 });
    expect(lines[3]).toMatchObject({ type: 'add', newLineNumber: 12 });
    // context resumes at old:12, new:13
    expect(lines[4]).toMatchObject({ type: 'context', oldLineNumber: 12, newLineNumber: 13 });
    expect(lines[5]).toMatchObject({ type: 'context', oldLineNumber: 13, newLineNumber: 14 });
  });
});

// ── getChangedFiles ──────────────────────────────────────────────

describe('getChangedFiles', () => {
  it('returns new-side paths for modified files', () => {
    const diffs = parseDiff(MULTI_FILE_DIFF);
    expect(getChangedFiles(diffs)).toEqual(['src/app.ts', 'src/utils.ts']);
  });

  it('excludes deleted files', () => {
    const diffs = parseDiff(DELETED_FILE_DIFF);
    expect(getChangedFiles(diffs)).toEqual([]);
  });

  it('includes new files', () => {
    const diffs = parseDiff(NEW_FILE_DIFF);
    expect(getChangedFiles(diffs)).toEqual(['src/new-file.ts']);
  });

  it('handles mixed new/modified/deleted', () => {
    const diffs = parseDiff(NEW_FILE_DIFF + SIMPLE_DIFF + DELETED_FILE_DIFF);
    const changed = getChangedFiles(diffs);
    expect(changed).toContain('src/new-file.ts');
    expect(changed).toContain('src/app.ts');
    expect(changed).not.toContain('/dev/null');
    // deleted file should be excluded
    expect(changed).not.toContain('src/old-file.ts');
  });

  it('returns empty for empty input', () => {
    expect(getChangedFiles([])).toEqual([]);
  });
});

// ── getAddedLines ────────────────────────────────────────────────

describe('getAddedLines', () => {
  it('returns added lines with line numbers', () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    const added = getAddedLines(file);

    expect(added).toHaveLength(1);
    expect(added[0].content).toBe('app.use(express.json());');
    expect(added[0].line).toBeGreaterThan(0);
  });

  it('returns all added lines for a new file', () => {
    const [file] = parseDiff(NEW_FILE_DIFF);
    const added = getAddedLines(file);

    // 3 lines added (blank line between them is also an add with content '')
    expect(added).toHaveLength(3);
    expect(added[0].content).toBe("export const greeting = 'hello';");
    expect(added[1].content).toBe('');
    expect(added[2].content).toBe('export default greeting;');
  });

  it('returns added lines across multiple hunks', () => {
    const [file] = parseDiff(MULTI_HUNK_DIFF);
    const added = getAddedLines(file);

    expect(added).toHaveLength(2);
    expect(added[0].content).toBe("import { log } from './log';");
    expect(added[1].content).toBe('// end of file');
  });

  it('returns empty for a deleted file', () => {
    const [file] = parseDiff(DELETED_FILE_DIFF);
    const added = getAddedLines(file);
    expect(added).toEqual([]);
  });
});

// ── diffContainsPattern ──────────────────────────────────────────

describe('diffContainsPattern', () => {
  it('matches pattern in added lines', () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    expect(diffContainsPattern(file, /express\.json/)).toBe(true);
  });

  it('does not match pattern in context lines', () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    // 'import express' is a context line, not an add
    expect(diffContainsPattern(file, /^import express/)).toBe(false);
  });

  it('does not match pattern in deleted lines', () => {
    const [, file] = parseDiff(MULTI_FILE_DIFF);
    // 'a + b + 0' is in a deleted line
    expect(diffContainsPattern(file, /a \+ b \+ 0/)).toBe(false);
  });

  it('returns false when no match', () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    expect(diffContainsPattern(file, /nonexistent_pattern/)).toBe(false);
  });

  it('returns false for file with no hunks', () => {
    expect(
      diffContainsPattern(
        { oldPath: '', newPath: '', hunks: [], isNew: false, isDeleted: false, isRenamed: false },
        /anything/
      )
    ).toBe(false);
  });
});

// ── diffToPatch ──────────────────────────────────────────────────

describe('diffToPatch', () => {
  it('reconstructs hunk header and lines', () => {
    const [file] = parseDiff(SIMPLE_DIFF);
    const patch = diffToPatch(file);

    expect(patch).toContain('@@ -1,5 +1,6 @@');
    expect(patch).toContain('+app.use(express.json());');
    expect(patch).toContain(" import express from 'express';");
  });

  it('preserves delete and add lines', () => {
    const [, file] = parseDiff(MULTI_FILE_DIFF);
    const patch = diffToPatch(file);

    expect(patch).toContain('-  return a + b + 0;');
    expect(patch).toContain('+  return a + b;');
  });

  it('handles multiple hunks', () => {
    const [file] = parseDiff(MULTI_HUNK_DIFF);
    const patch = diffToPatch(file);

    // Both hunk headers
    expect(patch).toContain('@@ -1,4 +1,5 @@');
    expect(patch).toContain('@@ -20,4 +21,5 @@');
  });

  it('returns empty string for file with no hunks', () => {
    expect(
      diffToPatch({
        oldPath: '',
        newPath: '',
        hunks: [],
        isNew: false,
        isDeleted: false,
        isRenamed: false,
      })
    ).toBe('');
  });
});

// ── getFilesWithDiffs ────────────────────────────────────────────

describe('getFilesWithDiffs', () => {
  it('returns filename and patch for modified files', () => {
    const diffs = parseDiff(MULTI_FILE_DIFF);
    const files = getFilesWithDiffs(diffs);

    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe('src/app.ts');
    expect(files[0].patch).toContain('+import cors');
    expect(files[1].filename).toBe('src/utils.ts');
  });

  it('excludes deleted files', () => {
    const diffs = parseDiff(DELETED_FILE_DIFF);
    const files = getFilesWithDiffs(diffs);
    expect(files).toEqual([]);
  });

  it('includes new files', () => {
    const diffs = parseDiff(NEW_FILE_DIFF);
    const files = getFilesWithDiffs(diffs);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('src/new-file.ts');
    expect(files[0].patch).toContain("+export const greeting = 'hello';");
  });

  it('returns empty for empty input', () => {
    expect(getFilesWithDiffs([])).toEqual([]);
  });
});
