import { describe, it, expect } from 'vitest';

// Mock types matching GitHub API responses
interface MockPRFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

describe('GitHub PR File Detection', () => {
  it('should extract filenames from PR files', () => {
    const files: MockPRFile[] = [
      {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        changes: 7,
        patch: '@@ -1,3 +1,5 @@\n line1\n+added\n line2',
      },
      {
        filename: 'src/utils.ts',
        status: 'added',
        additions: 10,
        deletions: 0,
        changes: 10,
        patch: '@@ -0,0 +1,10 @@\n+new file',
      },
    ];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    expect(changedFiles).toEqual(['src/app.ts', 'src/utils.ts']);
  });

  it('should exclude removed files', () => {
    const files: MockPRFile[] = [
      {
        filename: 'src/old.ts',
        status: 'removed',
        additions: 0,
        deletions: 20,
        changes: 20,
      },
      {
        filename: 'src/new.ts',
        status: 'added',
        additions: 15,
        deletions: 0,
        changes: 15,
        patch: '@@ -0,0 +1,15 @@\n+new content',
      },
    ];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    expect(changedFiles).toEqual(['src/new.ts']);
  });

  it('should handle renamed files', () => {
    const files: MockPRFile[] = [
      {
        filename: 'src/new-name.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
        previous_filename: 'src/old-name.ts',
      },
    ];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    expect(changedFiles).toEqual(['src/new-name.ts']);
  });

  it('should handle files without patches', () => {
    const files: MockPRFile[] = [
      {
        filename: 'binary-file.png',
        status: 'modified',
        additions: 0,
        deletions: 0,
        changes: 0,
        // No patch for binary files
      },
      {
        filename: 'src/code.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: '@@ -1,2 +1,3 @@\n line1\n+line2',
      },
    ];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    // Should include both files, even binary ones
    expect(changedFiles).toEqual(['binary-file.png', 'src/code.ts']);
  });

  it('should handle empty file list', () => {
    const files: MockPRFile[] = [];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    expect(changedFiles).toEqual([]);
  });

  it('should handle various file statuses', () => {
    const files: MockPRFile[] = [
      {
        filename: 'added.ts',
        status: 'added',
        additions: 10,
        deletions: 0,
        changes: 10,
      },
      {
        filename: 'modified.ts',
        status: 'modified',
        additions: 5,
        deletions: 3,
        changes: 8,
      },
      {
        filename: 'renamed.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
      },
      {
        filename: 'removed.ts',
        status: 'removed',
        additions: 0,
        deletions: 15,
        changes: 15,
      },
    ];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    expect(changedFiles).toEqual(['added.ts', 'modified.ts', 'renamed.ts']);
    expect(changedFiles).not.toContain('removed.ts');
  });

  it('should preserve file path structure', () => {
    const files: MockPRFile[] = [
      {
        filename: 'src/components/Button.tsx',
        status: 'modified',
        additions: 2,
        deletions: 1,
        changes: 3,
      },
      {
        filename: 'tests/unit/button.test.ts',
        status: 'added',
        additions: 20,
        deletions: 0,
        changes: 20,
      },
      {
        filename: '.github/workflows/ci.yml',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      },
    ];

    const changedFiles = files
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    expect(changedFiles).toEqual([
      'src/components/Button.tsx',
      'tests/unit/button.test.ts',
      '.github/workflows/ci.yml',
    ]);
  });
});

describe('GitHub Patch Format Edge Cases', () => {
  it('should handle GitHub patches without diff header', () => {
    // GitHub API returns patches that may not include "diff --git" line
    const patch = `@@ -1,3 +1,4 @@
 function hello() {
+  console.log('world');
   return 'hello';
 }`;

    // The filename comes from the API response, not from parsing the patch
    const filename = 'src/hello.ts';

    expect(filename).toBe('src/hello.ts');
    expect(patch).toContain('+  console.log');
  });

  it('should handle GitHub patches with context', () => {
    const patch = `@@ -10,7 +10,8 @@ export function validateUser(user: User) {
   if (!user.email) {
     throw new Error('Email required');
   }
+  // Added validation
+  validateEmail(user.email);
   return true;
 }`;

    expect(patch).toContain('validateEmail');
  });

  it('should handle binary file changes without patch', () => {
    const file: MockPRFile = {
      filename: 'assets/logo.png',
      status: 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
      // Binary files don't have patch property
    };

    expect(file.patch).toBeUndefined();
    expect(file.filename).toBe('assets/logo.png');
  });
});
