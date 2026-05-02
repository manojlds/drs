import { basename } from 'path';
import type { DRSConfig } from './config.js';
import type { ReviewIssue } from './comment-formatter.js';

const CURSOR_PROMPT_LINK = 'https://cursor.com/link/prompt';
const PROMPT_LIMITS = {
  TITLE: 160,
  AGENT: 80,
  FILE: 300,
  PROBLEM: 1200,
  SOLUTION: 1200,
} as const;

/** Options for generating Cursor fix links on review issue comments. */
export interface CursorFixLinkOptions {
  /** Whether Cursor fix links are enabled. */
  enabled: boolean;
  /** Optional Cursor workspace or folder name to route the deeplink. */
  workspace?: string;
}

/**
 * Infer a Cursor workspace name from the project ID or working directory.
 */
export function inferCursorWorkspaceName(projectId: string, workingDir = process.cwd()): string {
  const lastProjectSegment = projectId.split('/').filter(Boolean).at(-1);
  if (lastProjectSegment && !/^\d+$/.test(lastProjectSegment)) {
    return lastProjectSegment;
  }

  return basename(workingDir);
}

/**
 * Resolve Cursor fix link options from config and CLI overrides.
 * CLI enable wins over CLI disable, and both take precedence over config.
 */
export function resolveCursorFixLinkOptions(
  config: DRSConfig,
  projectId: string,
  workingDir: string,
  enableOverride?: boolean,
  disableOverride?: boolean
): CursorFixLinkOptions | undefined {
  const configured = config.review.cursorFixLinks;

  if (enableOverride === true) {
    return {
      enabled: true,
      workspace: configured?.workspace ?? inferCursorWorkspaceName(projectId, workingDir),
    };
  }

  if (disableOverride === true || !configured?.enabled) {
    return undefined;
  }

  return {
    enabled: true,
    workspace: configured?.workspace ?? inferCursorWorkspaceName(projectId, workingDir),
  };
}

/**
 * Build a Cursor prompt link for a review issue, if the feature is enabled.
 */
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
  const title = truncateForPrompt(cleanPromptText(issue.title), PROMPT_LIMITS.TITLE);
  const agent = truncateForPrompt(cleanPromptText(issue.agent), PROMPT_LIMITS.AGENT);
  const file = truncateForPrompt(cleanPromptText(location), PROMPT_LIMITS.FILE);
  const problem = truncateForPrompt(cleanPromptText(issue.problem), PROMPT_LIMITS.PROBLEM);
  const solution = truncateForPrompt(cleanPromptText(issue.solution), PROMPT_LIMITS.SOLUTION);

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
  const cleaned: string[] = [];
  for (const char of value) {
    cleaned.push(shouldReplacePromptChar(char) ? ' ' : char);
  }

  return cleaned
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
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
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
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
