import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { reviewMR } from './review-mr.js';
import { reviewPR } from './review-pr.js';

export interface ReviewUrlOptions {
  url: string;
  postComments: boolean;
  postErrorComment: boolean;
  describe: boolean;
  postDescription: boolean;
  codeQualityReport?: string;
  outputPath?: string;
  jsonOutput?: boolean;
  baseBranch?: string;
  debug?: boolean;
  thinkingLevel?: string;
}

export type ParsedReviewUrl =
  | {
      platform: 'github';
      owner: string;
      repo: string;
      prNumber: number;
    }
  | {
      platform: 'gitlab';
      projectId: string;
      mrIid: number;
    };

function sanitizeUrlForError(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.replace(/:\/\/[^@/\s]+@/g, '://').replace(/[?#].*$/, '');
  }
}

/**
 * Parse a GitHub or GitLab PR/MR URL into platform-specific identifiers.
 */
export function parseReviewUrl(url: string): ParsedReviewUrl {
  const safeUrl = sanitizeUrlForError(url);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${safeUrl}`);
  }

  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);

  // GitHub: /owner/repo/pull/<number>
  if (pathParts.length >= 4 && pathParts[2] === 'pull') {
    const owner = pathParts[0];
    const repo = pathParts[1];
    const prNumber = parseInt(pathParts[3] ?? '', 10);

    if (!owner || !repo || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new Error(
        `Invalid GitHub PR URL format: ${safeUrl}. Expected https://<host>/<owner>/<repo>/pull/<number>.`
      );
    }

    return {
      platform: 'github',
      owner,
      repo,
      prNumber,
    };
  }

  // GitLab: /group/subgroup/repo/-/merge_requests/<number>
  const mergeRequestIndex = pathParts.indexOf('merge_requests');
  if (mergeRequestIndex >= 0) {
    if (mergeRequestIndex < 2 || pathParts[mergeRequestIndex - 1] !== '-') {
      throw new Error(
        `Invalid GitLab MR URL format: ${safeUrl}. Expected .../<group>/<repo>/-/merge_requests/<number>.`
      );
    }

    const mrIid = parseInt(pathParts[mergeRequestIndex + 1] ?? '', 10);
    if (!Number.isSafeInteger(mrIid) || mrIid <= 0) {
      throw new Error(
        `Invalid GitLab MR URL format: ${safeUrl}. Merge request IID must be a positive integer.`
      );
    }

    const repo = pathParts[mergeRequestIndex - 2];
    const ownerParts = pathParts.slice(0, mergeRequestIndex - 2);
    if (!repo || ownerParts.length === 0) {
      throw new Error(
        `Invalid GitLab MR URL format: ${safeUrl}. Expected .../<group>/<repo>/-/merge_requests/<number>.`
      );
    }

    return {
      platform: 'gitlab',
      projectId: `${ownerParts.join('/')}/${repo}`,
      mrIid,
    };
  }

  throw new Error(
    `Unsupported review URL: ${safeUrl}. Expected a GitHub pull request URL (.../pull/<number>) or GitLab merge request URL (.../-/merge_requests/<number>).`
  );
}

/**
 * Route review execution based on PR/MR URL.
 */
export async function reviewByUrl(config: DRSConfig, options: ReviewUrlOptions): Promise<void> {
  const parsed = parseReviewUrl(options.url);

  if (parsed.platform === 'github') {
    if (options.codeQualityReport) {
      console.warn(
        chalk.yellow(
          '⚠ --code-quality-report is only supported for GitLab MRs. Ignoring this option for GitHub PR reviews.'
        )
      );
    }

    await reviewPR(config, {
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      postComments: options.postComments,
      postErrorComment: options.postErrorComment,
      describe: options.describe,
      postDescription: options.postDescription,
      outputPath: options.outputPath,
      jsonOutput: options.jsonOutput,
      baseBranch: options.baseBranch,
      debug: options.debug,
      thinkingLevel: options.thinkingLevel,
    });
    return;
  }

  await reviewMR(config, {
    projectId: parsed.projectId,
    mrIid: parsed.mrIid,
    postComments: options.postComments,
    postErrorComment: options.postErrorComment,
    describe: options.describe,
    postDescription: options.postDescription,
    codeQualityReport: options.codeQualityReport,
    outputPath: options.outputPath,
    jsonOutput: options.jsonOutput,
    baseBranch: options.baseBranch,
    debug: options.debug,
    thinkingLevel: options.thinkingLevel,
  });
}
