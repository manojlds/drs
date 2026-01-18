import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { ReviewJsonOutput } from '../lib/json-output.js';
import type { LineValidator, InlineCommentPosition } from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { enforceRepoBranchMatch, postReviewComments } from '../lib/unified-review-executor.js';

export interface PostCommentsOptions {
  inputPath: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  projectId?: string;
  mrIid?: number;
  workingDir?: string;
  skipRepoCheck?: boolean;
}

function parseReviewJson(raw: string, inputPath: string): ReviewJsonOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON from ${inputPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid review JSON in ${inputPath}: expected an object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (!obj.summary || typeof obj.summary !== 'object') {
    throw new Error(`Invalid review JSON in ${inputPath}: missing summary`);
  }

  if (!Array.isArray(obj.issues)) {
    throw new Error(`Invalid review JSON in ${inputPath}: issues must be an array`);
  }

  return obj as unknown as ReviewJsonOutput;
}

function parseNumber(value: string | number | undefined, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${label} is required`);
}

function resolveGitHubTarget(
  options: PostCommentsOptions,
  reviewJson: ReviewJsonOutput
): {
  owner: string;
  repo: string;
  prNumber: number;
  projectId: string;
} {
  let owner = options.owner;
  let repo = options.repo;

  const projectFromMetadata = reviewJson.metadata?.project;
  if ((!owner || !repo) && projectFromMetadata && projectFromMetadata.includes('/')) {
    const [metaOwner, metaRepo] = projectFromMetadata.split('/');
    if (!owner) owner = metaOwner;
    if (!repo) repo = metaRepo;
  }

  if (!owner || !repo) {
    throw new Error('GitHub requires --owner and --repo (or a review JSON with metadata.project)');
  }

  const prNumber = parseNumber(options.prNumber ?? reviewJson.metadata?.source, 'PR number (--pr)');
  const projectId = `${owner}/${repo}`;

  if (projectFromMetadata && projectFromMetadata !== projectId) {
    throw new Error(
      `Review JSON project (${projectFromMetadata}) does not match provided project (${projectId})`
    );
  }

  return { owner, repo, prNumber, projectId };
}

function resolveGitLabTarget(
  options: PostCommentsOptions,
  reviewJson: ReviewJsonOutput
): {
  projectId: string;
  mrIid: number;
} {
  const projectId = options.projectId ?? reviewJson.metadata?.project;
  if (!projectId) {
    throw new Error('GitLab requires --project (or a review JSON with metadata.project)');
  }

  const mrIid = parseNumber(options.mrIid ?? reviewJson.metadata?.source, 'MR IID (--mr)');

  return { projectId, mrIid };
}

/**
 * Post comments from a saved review JSON to GitHub or GitLab.
 */
export async function postCommentsFromJson(options: PostCommentsOptions): Promise<void> {
  const workingDir = options.workingDir || process.cwd();
  const inputPath = resolve(workingDir, options.inputPath);
  const raw = await readFile(inputPath, 'utf-8');
  const reviewJson = parseReviewJson(raw, inputPath);

  const isGitHub = Boolean(options.owner || options.repo || options.prNumber);
  const isGitLab = Boolean(options.projectId || options.mrIid);

  if (isGitHub && isGitLab) {
    throw new Error(
      'Specify either GitHub options (--owner/--repo/--pr) or GitLab options (--project/--mr), not both.'
    );
  }

  if (!isGitHub && !isGitLab) {
    throw new Error(
      'Specify GitHub options (--owner/--repo/--pr) or GitLab options (--project/--mr) to post comments.'
    );
  }

  if (reviewJson.issues.length === 0) {
    console.log(chalk.yellow('✓ No issues in review JSON - only summary will be posted\n'));
  }

  if (isGitHub) {
    const { owner, repo, prNumber, projectId } = resolveGitHubTarget(options, reviewJson);
    const githubClient = createGitHubClient();
    const platformClient = new GitHubPlatformAdapter(githubClient);

    const pr = await platformClient.getPullRequest(projectId, prNumber);
    if (!options.skipRepoCheck) {
      await enforceRepoBranchMatch(workingDir, projectId, pr);
    }

    const files = await githubClient.getPRFiles(owner, repo, prNumber);
    const validLinesMap = new Map<string, Set<number>>();
    for (const file of files) {
      if (file.patch && file.status !== 'removed') {
        const validLines = parseValidLinesFromPatch(file.patch);
        validLinesMap.set(file.filename, validLines);
      }
    }

    const lineValidator: LineValidator = {
      isValidLine(file: string, line: number): boolean {
        const validLines = validLinesMap.get(file);
        return validLines !== undefined && validLines.has(line);
      },
    };

    const createInlinePosition = (
      issue: ReviewIssue,
      platformData: unknown
    ): InlineCommentPosition => {
      const data = platformData as { head: { sha: string } };
      return {
        path: issue.file,
        line: issue.line!,
        commitSha: data.head.sha,
      };
    };

    await postReviewComments(
      platformClient,
      projectId,
      prNumber,
      reviewJson.summary,
      reviewJson.issues,
      undefined,
      pr.platformData,
      lineValidator,
      createInlinePosition
    );
    return;
  }

  const { projectId, mrIid } = resolveGitLabTarget(options, reviewJson);
  const gitlabClient = createGitLabClient();
  const platformClient = new GitLabPlatformAdapter(gitlabClient);

  const pr = await platformClient.getPullRequest(projectId, mrIid);
  if (!options.skipRepoCheck) {
    await enforceRepoBranchMatch(workingDir, projectId, pr);
  }

  const changes = await gitlabClient.getMRChanges(projectId, mrIid);
  const validLinesMap = new Map<string, Set<number>>();
  for (const change of changes) {
    if (change.diff && !change.deletedFile) {
      const validLines = parseValidLinesFromDiff(change.diff);
      validLinesMap.set(change.newPath, validLines);
    }
  }

  const lineValidator: LineValidator = {
    isValidLine(file: string, line: number): boolean {
      const validLines = validLinesMap.get(file);
      return validLines !== undefined && validLines.has(line);
    },
  };

  const createInlinePosition = (
    issue: ReviewIssue,
    platformData: unknown
  ): InlineCommentPosition => {
    const data = platformData as {
      diff_refs: { base_sha: string; head_sha: string; start_sha: string };
    };
    const refs = data.diff_refs;
    return {
      path: issue.file,
      line: issue.line!,
      baseSha: refs.base_sha,
      headSha: refs.head_sha,
      startSha: refs.start_sha,
    };
  };

  await postReviewComments(
    platformClient,
    projectId,
    mrIid,
    reviewJson.summary,
    reviewJson.issues,
    undefined,
    pr.platformData,
    lineValidator,
    createInlinePosition
  );
}

/**
 * Parse a GitHub diff patch to extract valid line numbers for review comments
 * GitHub only allows comments on lines that are in the diff (added, removed, or context)
 */
function parseValidLinesFromPatch(patch: string): Set<number> {
  const validLines = new Set<number>();
  const lines = patch.split('\n');
  let currentLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!line || line.length === 0) continue;

    const prefix = line[0];
    if (prefix === '+') {
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === ' ') {
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === '-') {
      continue;
    }
  }

  return validLines;
}

/**
 * Parse a GitLab diff to extract valid line numbers for review comments
 * GitLab only allows comments on lines that are in the diff (added or context)
 */
function parseValidLinesFromDiff(diff: string): Set<number> {
  const validLines = new Set<number>();
  const lines = diff.split('\n');
  let currentLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!line || line.length === 0) continue;

    const prefix = line[0];
    if (prefix === '+') {
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === ' ') {
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === '-') {
      continue;
    }
  }

  return validLines;
}
