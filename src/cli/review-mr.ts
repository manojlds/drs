import type { DRSConfig } from '../lib/config.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import { executeUnifiedReview } from '../lib/unified-review-executor.js';
import type { LineValidator, InlineCommentPosition } from '../lib/platform-client.js';
import type { ReviewIssue } from '../gitlab/comment-formatter.js';

export interface ReviewMROptions {
  projectId: string;
  mrIid: number;
  postComments: boolean;
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

  // Create line validator
  // For GitLab, we can post on any line with valid diff_refs
  const diffRefs: any = mr.diff_refs;
  const lineValidator: LineValidator = {
    isValidLine(file: string, line: number): boolean {
      return (
        line !== undefined &&
        diffRefs?.base_sha &&
        diffRefs.head_sha &&
        diffRefs.start_sha
      );
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
    lineValidator,
    createInlinePosition,
  });
}
