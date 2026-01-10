import type { DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { executeUnifiedReview } from '../lib/unified-review-executor.js';
import type { LineValidator, InlineCommentPosition } from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';

export interface ReviewPROptions {
  owner: string;
  repo: string;
  prNumber: number;
  postComments: boolean;
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

/**
 * Review a GitHub pull request
 */
export async function reviewPR(config: DRSConfig, options: ReviewPROptions): Promise<void> {
  // Create GitHub client and adapter
  const githubClient = createGitHubClient();
  const platformClient = new GitHubPlatformAdapter(githubClient);

  // Project ID in format "owner/repo"
  const projectId = `${options.owner}/${options.repo}`;

  // Fetch files to build line validator
  const files = await githubClient.getPRFiles(options.owner, options.repo, options.prNumber);

  // Build a map of file -> valid line numbers (lines that are in the diff)
  const validLinesMap = new Map<string, Set<number>>();
  for (const file of files) {
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
  const createInlinePosition = (issue: ReviewIssue, platformData: any): InlineCommentPosition => {
    return {
      path: issue.file,
      line: issue.line!,
      commitSha: platformData.head.sha,
    };
  };

  // Execute unified review
  await executeUnifiedReview(config, {
    platformClient,
    projectId,
    prNumber: options.prNumber,
    postComments: options.postComments,
    lineValidator,
    createInlinePosition,
    workingDir: process.cwd(),
  });
}
