import type { DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { executeUnifiedReview } from '../lib/unified-review-executor.js';
import type { LineValidator, InlineCommentPosition } from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';

export interface ReviewMROptions {
  projectId: string;
  mrIid: number;
  postComments: boolean;
  codeQualityReport?: string; // Optional path to output code quality report JSON
  outputPath?: string; // Optional path to write JSON results file
  jsonOutput?: boolean; // Output results as JSON to console
  debug?: boolean;
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
 * Review a GitLab merge request
 */
export async function reviewMR(config: DRSConfig, options: ReviewMROptions): Promise<void> {
  // Create GitLab client and adapter
  const gitlabClient = createGitLabClient();
  const platformClient = new GitLabPlatformAdapter(gitlabClient);

  // Fetch MR details to get diff refs
  const mr = await gitlabClient.getMergeRequest(options.projectId, options.mrIid);

  // Fetch MR changes to build valid lines map
  const changes = await gitlabClient.getMRChanges(options.projectId, options.mrIid);

  // Build a map of file -> valid line numbers (lines that are in the diff)
  const validLinesMap = new Map<string, Set<number>>();
  for (const change of changes) {
    if (change.diff && !change.deletedFile) {
      const validLines = parseValidLinesFromDiff(change.diff);
      validLinesMap.set(change.newPath, validLines);
    }
  }

  // Create line validator - only allow comments on lines that are in the diff
  const diffRefs: any = mr.diff_refs;
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
  const createInlinePosition = (issue: ReviewIssue, platformData: any): InlineCommentPosition => {
    const refs = platformData.diff_refs;
    return {
      path: issue.file,
      line: issue.line!,
      baseSha: refs.base_sha,
      headSha: refs.head_sha,
      startSha: refs.start_sha,
    };
  };

  // Execute unified review
  await executeUnifiedReview(config, {
    platformClient,
    projectId: options.projectId,
    prNumber: options.mrIid,
    postComments: options.postComments,
    codeQualityReport: options.codeQualityReport,
    outputPath: options.outputPath,
    jsonOutput: options.jsonOutput,
    lineValidator,
    createInlinePosition,
    debug: options.debug,
  });
}
