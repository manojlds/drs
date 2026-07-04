import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import type { ReviewIssue } from '../types';

export type GitFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';

export type DiffLayout = 'unified' | 'split';

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary: boolean;
  metadata?: FileDiffMetadata;
}

const CHANGE_STATUS: Record<FileDiffMetadata['type'], GitFileStatus> = {
  change: 'modified',
  deleted: 'deleted',
  new: 'added',
  'rename-changed': 'renamed',
  'rename-pure': 'renamed',
};

function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function parseDiffPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '/dev/null') return null;
  return stripPrefix(trimmed);
}

function parseFileHeader(line: string): DiffFile {
  const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
  const path = match
    ? stripPrefix(match[2])
    : (line.slice('diff --git '.length).split(' b/').pop() ?? '');
  return {
    path: stripPrefix(path),
    oldPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    hunks: [],
    binary: false,
  };
}

function parseHunkHeader(line: string): DiffHunk {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  const oldStart = match ? parseInt(match[1], 10) : 0;
  const oldCount = match && match[2] ? parseInt(match[2], 10) : 1;
  const newStart = match ? parseInt(match[3], 10) : 0;
  const newCount = match && match[4] ? parseInt(match[4], 10) : 1;
  return { oldStart, newStart, oldCount, newCount, lines: [] };
}

function nextOld(hunk: DiffHunk): number {
  const last = [...hunk.lines].reverse().find((l) => l.oldLine !== null);
  return last && last.oldLine !== null ? last.oldLine + 1 : hunk.oldStart;
}

function nextNew(hunk: DiffHunk): number {
  const last = [...hunk.lines].reverse().find((l) => l.newLine !== null);
  return last && last.newLine !== null ? last.newLine + 1 : hunk.newStart;
}

/**
 * Parse a unified diff patch (`git diff` output) into a structured model.
 *
 * Handles new files, deletions, renames, and binary files. File paths are
 * stripped of the `a/` and `b/` prefixes so they match DRS issue `file` values.
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  if (!patch.trim()) return [];

  const pierreFiles = parsePierreDiffFiles(patch);
  if (pierreFiles.length > 0) return pierreFiles;

  const lines = patch.split('\n');
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      current = parseFileHeader(line);
      i++;
      while (i < lines.length) {
        const meta = lines[i];
        if (meta.startsWith('new file mode')) {
          current.status = 'added';
          i++;
          continue;
        }
        if (meta.startsWith('deleted file mode')) {
          current.status = 'deleted';
          i++;
          continue;
        }
        if (meta.startsWith('rename from')) {
          current.oldPath = stripPrefix(meta.slice('rename from'.length).trim());
          current.status = 'renamed';
          i++;
          continue;
        }
        if (meta.startsWith('rename to')) {
          current.path = stripPrefix(meta.slice('rename to'.length).trim());
          i++;
          continue;
        }
        if (
          meta.startsWith('index ') ||
          meta.startsWith('similarity index') ||
          meta.startsWith('dissimilarity index') ||
          meta.startsWith('old mode') ||
          meta.startsWith('new mode')
        ) {
          i++;
          continue;
        }
        if (meta.startsWith('--- ')) {
          const oldPath = parseDiffPath(meta.slice(4));
          if (oldPath) current.oldPath = oldPath;
          i++;
          continue;
        }
        if (meta.startsWith('+++ ')) {
          const newPath = parseDiffPath(meta.slice(4));
          if (newPath) current.path = newPath;
          i++;
          break;
        }
        if (meta.startsWith('Binary files') || meta.startsWith('GIT binary patch')) {
          current.binary = true;
          i++;
          continue;
        }
        if (meta.startsWith('@@')) break;
        i++;
      }
      continue;
    }

    if (line.startsWith('@@') && current) {
      const hunk = parseHunkHeader(line);
      i++;
      while (i < lines.length) {
        const body = lines[i];
        if (body.startsWith('diff --git ') || body.startsWith('@@')) break;
        if (body === '') {
          if (
            i + 1 >= lines.length ||
            lines[i + 1].startsWith('diff --git ') ||
            lines[i + 1].startsWith('@@')
          ) {
            i++;
            break;
          }
          pushHunkLine(hunk, ' ', '');
          i++;
          continue;
        }
        const prefix = body[0];
        if (prefix === '+') {
          pushHunkLine(hunk, '+', body.slice(1));
          current.additions++;
        } else if (prefix === '-') {
          pushHunkLine(hunk, '-', body.slice(1));
          current.deletions++;
        } else if (prefix === ' ') {
          pushHunkLine(hunk, ' ', body.slice(1));
        } else if (body.startsWith('\\ No newline at end of file')) {
          /* footer */
        } else break;
        i++;
      }
      current.hunks.push(hunk);
      continue;
    }

    i++;
  }

  if (current) files.push(current);
  return files;
}

function parsePierreDiffFiles(patch: string): DiffFile[] {
  try {
    return parsePatchFiles(patch, 'drs-desktop', true).flatMap((parsedPatch) =>
      parsedPatch.files.map((fileDiff) => ({
        path: fileDiff.name,
        oldPath: fileDiff.prevName ?? null,
        status: CHANGE_STATUS[fileDiff.type],
        additions: fileDiff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
        deletions: fileDiff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
        hunks: [],
        binary: fileDiff.hunks.length === 0,
        metadata: fileDiff,
      }))
    );
  } catch {
    return [];
  }
}

function pushHunkLine(hunk: DiffHunk, prefix: string, text: string): void {
  if (prefix === '+') {
    hunk.lines.push({ type: 'add', text, oldLine: null, newLine: nextNew(hunk) });
  } else if (prefix === '-') {
    hunk.lines.push({ type: 'del', text, oldLine: nextOld(hunk), newLine: null });
  } else {
    hunk.lines.push({ type: 'context', text, oldLine: nextOld(hunk), newLine: nextNew(hunk) });
  }
}

export interface IssueLineIndex {
  byFileLine: Map<string, ReviewIssue[]>;
  general: Map<string, ReviewIssue[]>;
}

export function buildIssueLineIndex(issues: ReviewIssue[]): IssueLineIndex {
  const byFileLine = new Map<string, ReviewIssue[]>();
  const general = new Map<string, ReviewIssue[]>();
  for (const issue of issues) {
    if (issue.line) {
      const key = issueLineKey(issue.file, issue.line);
      const list = byFileLine.get(key) ?? [];
      list.push(issue);
      byFileLine.set(key, list);
    } else {
      const list = general.get(issue.file) ?? [];
      list.push(issue);
      general.set(issue.file, list);
    }
  }
  return { byFileLine, general };
}

export function issueLineKey(file: string, line: number): string {
  return `${file}:${line}`;
}

/** Stable identity for a review issue, used for selection state and list
 * keys. Line-anchored issues key on file:line; general (file-level) issues
 * fall back to file:title since they have no line number. */
export function issueKey(issue: ReviewIssue): string {
  return issue.line ? issueLineKey(issue.file, issue.line) : `${issue.file}:${issue.title}`;
}

export function lineDomId(file: string, newLine: number | null, oldLine: number | null): string {
  const line = newLine ?? oldLine ?? 0;
  return `dl-${encodeURIComponent(file)}-${line}`;
}

export function fileDomId(file: string): string {
  return `df-${encodeURIComponent(file)}`;
}
