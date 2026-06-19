/**
 * Parse a unified diff patch and return line numbers in the new file that can receive comments.
 */
export interface DiffLineInfo {
  /** New-file lines that were added by the patch. */
  addedLines: Set<number>;
  /** New-file lines present in diff hunks and commentable by platforms. */
  commentableLines: Set<number>;
}

export function parseDiffLineInfo(patch: string): DiffLineInfo {
  const addedLines = new Set<number>();
  const commentableLines = new Set<number>();
  const lines = patch.split('\n');
  let currentLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !line) continue;

    const prefix = line[0];
    if (prefix === '+') {
      addedLines.add(currentLine);
      commentableLines.add(currentLine);
      currentLine++;
    } else if (prefix === ' ') {
      commentableLines.add(currentLine);
      currentLine++;
    }
  }

  return { addedLines, commentableLines };
}

export function parseValidLinesFromPatch(patch: string): Set<number> {
  return parseDiffLineInfo(patch).commentableLines;
}

export function parseAddedLinesFromPatch(patch: string): Set<number> {
  return parseDiffLineInfo(patch).addedLines;
}

/**
 * Alias for GitLab call sites, where API responses call the same unified patch text a diff.
 */
export const parseValidLinesFromDiff = parseValidLinesFromPatch;
export const parseAddedLinesFromDiff = parseAddedLinesFromPatch;
