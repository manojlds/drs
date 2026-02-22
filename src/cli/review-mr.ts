import type { DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { executeUnifiedReview } from '../lib/unified-review-executor.js';
import type {
  FileChange,
  PullRequest,
  LineValidator,
  InlineCommentPosition,
} from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';

export interface ReviewMROptions {
  projectId: string;
  mrIid: number;
  postComments: boolean;
  postErrorComment: boolean;
  describe: boolean;
  postDescription: boolean;
  codeQualityReport?: string; // Optional path to output code quality report JSON
  outputPath?: string; // Optional path to write JSON results file
  jsonOutput?: boolean; // Output results as JSON to console
  baseBranch?: string;
  debug?: boolean;
}

interface GitLabDiffRefs {
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
}

interface GitLabErrorLike {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    statusCode?: number;
  };
  cause?: unknown;
}

/**
 * Parse a GitLab diff to extract valid line numbers for review comments.
 * GitLab only allows comments on lines that are in the diff (added or context).
 */
function parseValidLinesFromDiff(diff: string): Set<number> {
  const validLines = new Set<number>();
  const lines = diff.split('\n');
  let currentLine = 0;

  for (const line of lines) {
    // Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip empty lines or lines without proper diff prefix
    if (!line || line.length === 0) continue;

    const prefix = line[0];
    if (prefix === '+') {
      // Added line - can comment on this
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === ' ') {
      // Context line - can comment on this
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === '-') {
      // Removed line - cannot comment on "new" version, skip
      continue;
    }
  }

  return validLines;
}

function parseStatusCodeFromMessage(message: string): number | undefined {
  const match = message.match(/\b(401|403|404|429)\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as GitLabErrorLike;

  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }

  if (typeof candidate.status === 'number') {
    return candidate.status;
  }

  if (candidate.response && typeof candidate.response === 'object') {
    if (typeof candidate.response.statusCode === 'number') {
      return candidate.response.statusCode;
    }

    if (typeof candidate.response.status === 'number') {
      return candidate.response.status;
    }
  }

  if (candidate.cause && candidate.cause !== error) {
    return extractStatusCode(candidate.cause);
  }

  return undefined;
}

function mapGitLabContextError(error: unknown, options: ReviewMROptions): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const normalized = rawMessage.toLowerCase();
  const statusCode = extractStatusCode(error) ?? parseStatusCodeFromMessage(rawMessage);
  const gitlabUrl = process.env.GITLAB_URL ?? 'https://gitlab.com';

  if (normalized.includes('gitlab_token environment variable is required')) {
    return new Error(
      'GitLab authentication is required. Set GITLAB_TOKEN with an API token that can access the target merge request.'
    );
  }

  if (statusCode === 401 || normalized.includes('unauthorized')) {
    return new Error(
      `GitLab authentication failed for ${options.projectId}!${options.mrIid}. Verify GITLAB_TOKEN for ${gitlabUrl} and ensure it has API access.`
    );
  }

  if (statusCode === 403 || normalized.includes('forbidden')) {
    return new Error(
      `GitLab authorization failed for ${options.projectId}!${options.mrIid}. Ensure the token has permission to read the project and merge request.`
    );
  }

  if (statusCode === 404 || normalized.includes('not found')) {
    return new Error(
      `GitLab merge request not found: ${options.projectId}!${options.mrIid}. Verify --project/--mr values and that the token can access the project.`
    );
  }

  if (statusCode === 429 || normalized.includes('rate limit')) {
    return new Error(
      `GitLab API rate limit reached while loading ${options.projectId}!${options.mrIid}. Retry after cooldown or use a token with higher limits.`
    );
  }

  const connectivityError =
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('etimedout');

  if (connectivityError) {
    return new Error(
      `Unable to reach GitLab at ${gitlabUrl} while loading ${options.projectId}!${options.mrIid}. Check GITLAB_URL and network connectivity.`
    );
  }

  return new Error(
    `Failed to load GitLab merge request context for ${options.projectId}!${options.mrIid}: ${rawMessage}`
  );
}

async function loadMergeRequestContext(
  platformClient: GitLabPlatformAdapter,
  options: ReviewMROptions
): Promise<{ pullRequest: PullRequest; changedFiles: FileChange[] }> {
  try {
    const pullRequest = await platformClient.getPullRequest(options.projectId, options.mrIid);
    const changedFiles = await platformClient.getChangedFiles(options.projectId, options.mrIid);

    return {
      pullRequest,
      changedFiles,
    };
  } catch (error) {
    throw mapGitLabContextError(error, options);
  }
}

/**
 * Review a GitLab merge request.
 */
export async function reviewMR(config: DRSConfig, options: ReviewMROptions): Promise<void> {
  let platformClient: GitLabPlatformAdapter;

  try {
    const gitlabClient = createGitLabClient();
    platformClient = new GitLabPlatformAdapter(gitlabClient);
  } catch (error) {
    throw mapGitLabContextError(error, options);
  }

  const { pullRequest, changedFiles } = await loadMergeRequestContext(platformClient, options);

  // Build a map of file -> valid line numbers (lines that are in the diff)
  const validLinesMap = new Map<string, Set<number>>();
  for (const file of changedFiles) {
    if (file.patch && file.status !== 'removed') {
      const validLines = parseValidLinesFromDiff(file.patch);
      validLinesMap.set(file.filename, validLines);
    }
  }

  const platformData = pullRequest.platformData as { diff_refs?: GitLabDiffRefs } | undefined;
  const diffRefs = platformData?.diff_refs;

  // Create line validator - only allow comments on lines that are in the diff
  const lineValidator: LineValidator = {
    isValidLine(file: string, line: number): boolean {
      if (!diffRefs?.base_sha || !diffRefs.head_sha || !diffRefs.start_sha) {
        return false;
      }
      const validLines = validLinesMap.get(file);
      return validLines !== undefined && validLines.has(line);
    },
  };

  // Create inline position builder
  const createInlinePosition = (
    issue: ReviewIssue,
    platformDataInput: unknown
  ): InlineCommentPosition => {
    const data = platformDataInput as {
      diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string };
    };
    const refs = data.diff_refs;
    return {
      path: issue.file,
      line: issue.line!,
      baseSha: refs?.base_sha,
      headSha: refs?.head_sha,
      startSha: refs?.start_sha,
    };
  };

  // Execute unified review
  await executeUnifiedReview(config, {
    platformClient,
    projectId: options.projectId,
    prNumber: options.mrIid,
    pullRequest,
    changedFiles,
    postComments: options.postComments,
    postErrorComment: options.postErrorComment,
    codeQualityReport: options.codeQualityReport,
    outputPath: options.outputPath,
    jsonOutput: options.jsonOutput,
    baseBranch: options.baseBranch,
    lineValidator,
    createInlinePosition,
    describe: options.describe,
    postDescription: options.postDescription,
    debug: options.debug,
  });
}
