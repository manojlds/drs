import type { DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { executeUnifiedReview } from '../lib/unified-review-executor.js';
import type {
  FileChange,
  PullRequest,
  LineValidator,
  InlineCommentPosition,
} from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';

export interface ReviewPROptions {
  owner: string;
  repo: string;
  prNumber: number;
  postComments: boolean;
  postErrorComment: boolean;
  describe: boolean;
  postDescription: boolean;
  outputPath?: string; // Optional path to write JSON results file
  jsonOutput?: boolean; // Output results as JSON to console
  baseBranch?: string;
  debug?: boolean;
}

interface GitHubErrorLike {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    statusCode?: number;
  };
  cause?: unknown;
}

/**
 * Parse a GitHub diff patch to extract valid line numbers for review comments.
 * GitHub only allows comments on lines that are in the diff (added, removed, or context).
 */
function parseValidLinesFromPatch(patch: string): Set<number> {
  const validLines = new Set<number>();
  const lines = patch.split('\n');
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
  const match = message.match(/\b(401|403|404|422|429)\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as GitHubErrorLike;

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

function mapGitHubContextError(error: unknown, options: ReviewPROptions): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const normalized = rawMessage.toLowerCase();
  const statusCode = extractStatusCode(error) ?? parseStatusCodeFromMessage(rawMessage);
  const pullRequestRef = `${options.owner}/${options.repo}#${options.prNumber}`;

  if (normalized.includes('github_token environment variable is required')) {
    return new Error(
      'GitHub authentication is required. Set GITHUB_TOKEN with a token that can access the target pull request.'
    );
  }

  if (
    statusCode === 401 ||
    normalized.includes('unauthorized') ||
    normalized.includes('bad credentials')
  ) {
    return new Error(
      `GitHub authentication failed for ${pullRequestRef}. Verify GITHUB_TOKEN and ensure it has permission to read the repository.`
    );
  }

  if (statusCode === 429 || normalized.includes('rate limit')) {
    return new Error(
      `GitHub API rate limit reached while loading ${pullRequestRef}. Retry after cooldown or use a token with higher API limits.`
    );
  }

  if (statusCode === 403 || normalized.includes('forbidden')) {
    return new Error(
      `GitHub authorization failed for ${pullRequestRef}. Ensure the token can access the repository and pull request.`
    );
  }

  if (statusCode === 404 || normalized.includes('not found')) {
    return new Error(
      `GitHub pull request not found: ${pullRequestRef}. Verify --owner/--repo/--pr values and token access.`
    );
  }

  if (
    statusCode === 422 ||
    normalized.includes('unprocessable entity') ||
    normalized.includes('validation failed')
  ) {
    return new Error(
      `GitHub rejected pull request lookup for ${pullRequestRef}. Confirm the PR number and repository details are valid.`
    );
  }

  const connectivityError =
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('etimedout') ||
    normalized.includes('econnreset');

  if (connectivityError) {
    return new Error(
      `Unable to reach GitHub API while loading ${pullRequestRef}. Check network connectivity and retry.`
    );
  }

  return new Error(
    `Failed to load GitHub pull request context for ${pullRequestRef}: ${rawMessage}`
  );
}

async function loadPullRequestContext(
  platformClient: GitHubPlatformAdapter,
  options: ReviewPROptions
): Promise<{ pullRequest: PullRequest; changedFiles: FileChange[] }> {
  const projectId = `${options.owner}/${options.repo}`;

  try {
    const pullRequest = await platformClient.getPullRequest(projectId, options.prNumber);
    const changedFiles = await platformClient.getChangedFiles(projectId, options.prNumber);

    return {
      pullRequest,
      changedFiles,
    };
  } catch (error) {
    throw mapGitHubContextError(error, options);
  }
}

/**
 * Review a GitHub pull request.
 */
export async function reviewPR(config: DRSConfig, options: ReviewPROptions): Promise<void> {
  let platformClient: GitHubPlatformAdapter;

  try {
    const githubClient = createGitHubClient();
    platformClient = new GitHubPlatformAdapter(githubClient);
  } catch (error) {
    throw mapGitHubContextError(error, options);
  }

  const projectId = `${options.owner}/${options.repo}`;
  const { pullRequest, changedFiles } = await loadPullRequestContext(platformClient, options);

  // Build a map of file -> valid line numbers (lines that are in the diff)
  const validLinesMap = new Map<string, Set<number>>();
  for (const file of changedFiles) {
    if (file.patch && file.status !== 'removed') {
      const validLines = parseValidLinesFromPatch(file.patch);
      validLinesMap.set(file.filename, validLines);
    }
  }

  // Create line validator
  const lineValidator: LineValidator = {
    isValidLine(file: string, line: number): boolean {
      const validLines = validLinesMap.get(file);
      return validLines !== undefined && validLines.has(line);
    },
  };

  // Create inline position builder
  const createInlinePosition = (
    issue: ReviewIssue,
    _platformData: unknown
  ): InlineCommentPosition => {
    return {
      path: issue.file,
      line: issue.line!,
      commitSha: pullRequest.headSha,
    };
  };

  // Execute unified review
  await executeUnifiedReview(config, {
    platformClient,
    projectId,
    prNumber: options.prNumber,
    pullRequest,
    changedFiles,
    postComments: options.postComments,
    postErrorComment: options.postErrorComment,
    outputPath: options.outputPath,
    jsonOutput: options.jsonOutput,
    baseBranch: options.baseBranch,
    lineValidator,
    createInlinePosition,
    workingDir: process.cwd(),
    describe: options.describe,
    postDescription: options.postDescription,
    debug: options.debug,
  });
}
