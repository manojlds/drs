export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'delete' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ParsedDiff {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

/**
 * Parse a unified diff string into structured format
 */
export function parseDiff(diffText: string): ParsedDiff[] {
  const files: ParsedDiff[] = [];
  const lines = diffText.split('\n');

  let currentFile: ParsedDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      if (currentFile) {
        files.push(currentFile);
      }

      currentFile = {
        oldPath: '',
        newPath: '',
        hunks: [],
        isNew: false,
        isDeleted: false,
        isRenamed: false,
      };
      currentHunk = null;
    }

    // Old file: --- a/path or --- /dev/null
    if (line.startsWith('---')) {
      if (currentFile) {
        if (line === '--- /dev/null') {
          currentFile.isNew = true;
          currentFile.oldPath = '/dev/null';
        } else {
          currentFile.oldPath = line.substring(6); // Remove '--- a/'
        }
      }
    }

    // New file: +++ b/path or +++ /dev/null
    if (line.startsWith('+++')) {
      if (currentFile) {
        if (line === '+++ /dev/null') {
          currentFile.isDeleted = true;
          currentFile.newPath = '/dev/null';
        } else {
          currentFile.newPath = line.substring(6); // Remove '+++ b/'
        }
      }
    }

    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    if (line.startsWith('@@')) {
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        oldLineNumber = parseInt(match[1]);
        newLineNumber = parseInt(match[3]);

        currentHunk = {
          oldStart: oldLineNumber,
          oldLines: match[2] ? parseInt(match[2]) : 1,
          newStart: newLineNumber,
          newLines: match[4] ? parseInt(match[4]) : 1,
          lines: [],
        };
      }
    }

    // Diff line content
    if (currentHunk && line.length > 0) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({
          type: 'add',
          content: line.substring(1),
          newLineNumber: newLineNumber++,
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({
          type: 'delete',
          content: line.substring(1),
          oldLineNumber: oldLineNumber++,
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.substring(1),
          oldLineNumber: oldLineNumber++,
          newLineNumber: newLineNumber++,
        });
      }
    }
  }

  // Push last hunk and file
  if (currentFile && currentHunk) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Get a list of changed file paths from parsed diff
 */
export function getChangedFiles(diffs: ParsedDiff[]): string[] {
  return diffs
    .filter((d) => !d.isDeleted)
    .map((d) => d.newPath)
    .filter((path) => path !== '/dev/null');
}

/**
 * Get added lines from a diff with their line numbers
 */
export function getAddedLines(diff: ParsedDiff): Array<{ line: number; content: string }> {
  const added: Array<{ line: number; content: string }> = [];

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add' && line.newLineNumber) {
        added.push({
          line: line.newLineNumber,
          content: line.content,
        });
      }
    }
  }

  return added;
}

/**
 * Check if a diff contains specific patterns (e.g., for filtering)
 */
export function diffContainsPattern(diff: ParsedDiff, pattern: RegExp): boolean {
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add' && pattern.test(line.content)) {
        return true;
      }
    }
  }
  return false;
}
