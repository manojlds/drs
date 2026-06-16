/**
 * Parse a unified diff patch and return line numbers in the new file that can receive comments.
 */
export function parseValidLinesFromPatch(patch: string): Set<number> {
  const validLines = new Set<number>();
  const lines = patch.split('\n');
  let currentLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!line) continue;

    const prefix = line[0];
    if (prefix === '+') {
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === ' ') {
      validLines.add(currentLine);
      currentLine++;
    }
  }

  return validLines;
}

/**
 * Alias for GitLab call sites, where API responses call the same unified patch text a diff.
 */
export const parseValidLinesFromDiff = parseValidLinesFromPatch;
