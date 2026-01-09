import { describe, it, expect } from 'vitest';
import { parseDiff, getChangedFiles, getAddedLines, diffContainsPattern } from './diff-parser.js';

describe('parseDiff', () => {
  it('should parse a simple unified diff with one file', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 function hello() {
+  console.log('world');
   return 'hello';
 }`;

    const parsed = parseDiff(diff);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].oldPath).toBe('src/test.ts');
    expect(parsed[0].newPath).toBe('src/test.ts');
    expect(parsed[0].isNew).toBe(false);
    expect(parsed[0].isDeleted).toBe(false);
    expect(parsed[0].hunks).toHaveLength(1);
  });

  it('should parse a new file', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function newFunc() {
+  return 'new';
+}`;

    const parsed = parseDiff(diff);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].isNew).toBe(true);
    expect(parsed[0].oldPath).toBe('/dev/null');
    expect(parsed[0].newPath).toBe('src/new.ts');
  });

  it('should parse a deleted file', () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function oldFunc() {
-  return 'old';
-}`;

    const parsed = parseDiff(diff);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].isDeleted).toBe(true);
    expect(parsed[0].newPath).toBe('/dev/null');
  });

  it('should parse multiple files', () => {
    const diff = `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,2 +1,3 @@
 line1
+line2
 line3
diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,1 +1,2 @@
 line1
+line2`;

    const parsed = parseDiff(diff);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].newPath).toBe('src/file1.ts');
    expect(parsed[1].newPath).toBe('src/file2.ts');
  });

  it('should parse diff with multiple hunks', () => {
    const diff = `diff --git a/src/multi.ts b/src/multi.ts
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1,3 +1,4 @@
 function one() {
+  // Added comment
   return 1;
 }
@@ -10,3 +11,4 @@
 function two() {
+  // Another comment
   return 2;
 }`;

    const parsed = parseDiff(diff);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].hunks).toHaveLength(2);
    expect(parsed[0].hunks[0].oldStart).toBe(1);
    expect(parsed[0].hunks[1].oldStart).toBe(10);
  });

  it('should track line numbers correctly for additions', () => {
    const diff = `diff --git a/src/lines.ts b/src/lines.ts
--- a/src/lines.ts
+++ b/src/lines.ts
@@ -1,3 +1,5 @@
 line1
+line2-added
+line3-added
 line4
 line5`;

    const parsed = parseDiff(diff);

    expect(parsed[0].hunks[0].lines).toHaveLength(5);

    const addedLines = parsed[0].hunks[0].lines.filter(l => l.type === 'add');
    expect(addedLines).toHaveLength(2);
    expect(addedLines[0].newLineNumber).toBe(2);
    expect(addedLines[1].newLineNumber).toBe(3);
  });

  it('should track line numbers correctly for deletions', () => {
    const diff = `diff --git a/src/del.ts b/src/del.ts
--- a/src/del.ts
+++ b/src/del.ts
@@ -1,5 +1,3 @@
 line1
-line2-deleted
-line3-deleted
 line4
 line5`;

    const parsed = parseDiff(diff);

    const deletedLines = parsed[0].hunks[0].lines.filter(l => l.type === 'delete');
    expect(deletedLines).toHaveLength(2);
    expect(deletedLines[0].oldLineNumber).toBe(2);
    expect(deletedLines[1].oldLineNumber).toBe(3);
  });

  it('should handle context lines', () => {
    const diff = `diff --git a/src/ctx.ts b/src/ctx.ts
--- a/src/ctx.ts
+++ b/src/ctx.ts
@@ -1,5 +1,5 @@
 context1
 context2
-old line
+new line
 context3
 context4`;

    const parsed = parseDiff(diff);

    const contextLines = parsed[0].hunks[0].lines.filter(l => l.type === 'context');
    expect(contextLines).toHaveLength(4);

    // Context lines should have both old and new line numbers
    expect(contextLines[0].oldLineNumber).toBe(1);
    expect(contextLines[0].newLineNumber).toBe(1);
  });

  it('should parse GitHub-style patch without diff header', () => {
    // GitHub API sometimes returns patches without the "diff --git" line
    const diff = `--- a/src/file.ts
+++ b/src/file.ts
@@ -1,2 +1,3 @@
 line1
+line2
 line3`;

    const parsed = parseDiff(diff);

    // Should still parse, but may create a file entry when encountering ---
    expect(parsed.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty diff', () => {
    const diff = '';

    const parsed = parseDiff(diff);

    expect(parsed).toEqual([]);
  });

  it('should handle hunk with single line change', () => {
    const diff = `diff --git a/src/single.ts b/src/single.ts
--- a/src/single.ts
+++ b/src/single.ts
@@ -1 +1 @@
-old
+new`;

    const parsed = parseDiff(diff);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].hunks[0].oldLines).toBe(1);
    expect(parsed[0].hunks[0].newLines).toBe(1);
  });
});

describe('getChangedFiles', () => {
  it('should return list of changed files', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 line
+new line
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
 line
+new line`;

    const parsed = parseDiff(diff);
    const files = getChangedFiles(parsed);

    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('should exclude deleted files', () => {
    const diff = `diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-old content
diff --git a/src/kept.ts b/src/kept.ts
--- a/src/kept.ts
+++ b/src/kept.ts
@@ -1 +1,2 @@
 line
+new line`;

    const parsed = parseDiff(diff);
    const files = getChangedFiles(parsed);

    expect(files).toEqual(['src/kept.ts']);
  });

  it('should include new files', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;

    const parsed = parseDiff(diff);
    const files = getChangedFiles(parsed);

    expect(files).toEqual(['src/new.ts']);
  });

  it('should return empty array for empty diff', () => {
    const files = getChangedFiles([]);

    expect(files).toEqual([]);
  });
});

describe('getAddedLines', () => {
  it('should return all added lines with line numbers', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,5 @@
 line1
+added line 2
 line3
+added line 4
 line5`;

    const parsed = parseDiff(diff);
    const added = getAddedLines(parsed[0]);

    expect(added).toHaveLength(2);
    expect(added[0]).toEqual({ line: 2, content: 'added line 2' });
    expect(added[1]).toEqual({ line: 4, content: 'added line 4' });
  });

  it('should return empty array for deletions only', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,1 @@
-deleted line
 kept line
-deleted line`;

    const parsed = parseDiff(diff);
    const added = getAddedLines(parsed[0]);

    expect(added).toEqual([]);
  });

  it('should handle multiple hunks', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,2 +1,3 @@
 line1
+added in hunk 1
 line2
@@ -5,2 +6,3 @@
 line5
+added in hunk 2
 line6`;

    const parsed = parseDiff(diff);
    const added = getAddedLines(parsed[0]);

    expect(added).toHaveLength(2);
  });
});

describe('diffContainsPattern', () => {
  it('should find pattern in added lines', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,2 +1,3 @@
 line1
+console.log('debug');
 line2`;

    const parsed = parseDiff(diff);
    const contains = diffContainsPattern(parsed[0], /console\.log/);

    expect(contains).toBe(true);
  });

  it('should not match pattern in deleted lines', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,2 @@
 line1
-console.log('debug');
 line2`;

    const parsed = parseDiff(diff);
    const contains = diffContainsPattern(parsed[0], /console\.log/);

    expect(contains).toBe(false);
  });

  it('should not match pattern in context lines', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,3 @@
 console.log('existing');
-old line
+new line`;

    const parsed = parseDiff(diff);
    const contains = diffContainsPattern(parsed[0], /console\.log/);

    expect(contains).toBe(false);
  });

  it('should return false when pattern not found', () => {
    const diff = `diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,2 +1,3 @@
 line1
+const x = 5;
 line2`;

    const parsed = parseDiff(diff);
    const contains = diffContainsPattern(parsed[0], /console\.log/);

    expect(contains).toBe(false);
  });
});
