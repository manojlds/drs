import { basename } from 'path';
import type { DRSConfig } from './config.js';
import type { ReviewIssue } from './comment-formatter.js';

const CURSOR_PROMPT_LINK = 'https://cursor.com/link/prompt';

export interface CursorFixLinkOptions {
  enabled: boolean;
  workspace?: string;
}

export function inferCursorWorkspaceName(projectId: string, workingDir = process.cwd()): string {
  const lastProjectSegment = projectId.split('/').filter(Boolean).at(-1);
  if (lastProjectSegment && !/^\d+$/.test(lastProjectSegment)) {
    return lastProjectSegment;
  }

  return basename(workingDir);
}

export function resolveCursorFixLinkOptions(
  config: DRSConfig,
  projectId: string,
  workingDir: string,
  enableOverride?: boolean,
  disableOverride?: boolean
): CursorFixLinkOptions | undefined {
  const configured = config.review.cursorFixLinks;
  const enabled =
    enableOverride === true ? true : disableOverride === true ? false : configured?.enabled;

  if (!enabled) {
    return undefined;
  }

  return {
    enabled: true,
    workspace: configured?.workspace ?? inferCursorWorkspaceName(projectId, workingDir),
  };
}

export function buildCursorFixLink(
  issue: ReviewIssue,
  options?: CursorFixLinkOptions
): string | undefined {
  if (!options?.enabled) {
    return undefined;
  }

  const params = new URLSearchParams({
    text: buildCursorFixPrompt(issue),
    mode: 'agent',
  });

  const workspace = options.workspace?.trim();
  if (workspace) {
    params.set('workspace', workspace);
  }

  return `${CURSOR_PROMPT_LINK}?${params.toString()}`;
}

function buildCursorFixPrompt(issue: ReviewIssue): string {
  const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  const title = truncateForPrompt(cleanPromptText(issue.title), 160);
  const agent = truncateForPrompt(cleanPromptText(issue.agent), 80);
  const file = truncateForPrompt(cleanPromptText(location), 300);
  const problem = truncateForPrompt(cleanPromptText(issue.problem), 1200);
  const solution = truncateForPrompt(cleanPromptText(issue.solution), 1200);

  return [
    'Fix this DRS review issue in the current repository.',
    '',
    `Issue: ${issue.severity} ${issue.category} - ${title}`,
    `File: ${file}`,
    `Analysis by: ${agent}`,
    '',
    `Problem: ${problem}`,
    '',
    `Suggested fix: ${solution}`,
    '',
    'Please inspect the code, make the minimal correct change, and run relevant tests.',
  ].join('\n');
}

function cleanPromptText(value: string): string {
  let cleaned = '';
  for (const char of value) {
    cleaned += shouldReplacePromptChar(char) ? ' ' : char;
  }

  return cleaned.replace(/[ \t]+/g, ' ').trim();
}

function shouldReplacePromptChar(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }

  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}
