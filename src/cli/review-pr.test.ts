import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';
import type { UnifiedReviewOptions } from '../lib/unified-review-executor.js';
import { reviewPR } from './review-pr.js';

const { mockGitHubClient, createGitHubClient, executeUnifiedReview } = vi.hoisted(() => ({
  mockGitHubClient: {
    getPullRequest: vi.fn(),
    getPRFiles: vi.fn(),
  },
  createGitHubClient: vi.fn(),
  executeUnifiedReview: vi.fn(),
}));

vi.mock('../github/client.js', () => ({
  createGitHubClient,
}));

vi.mock('../lib/unified-review-executor.js', () => ({
  executeUnifiedReview,
}));

const baseConfig = {
  pi: {},
  gitlab: { url: 'https://gitlab.com', token: 'token' },
  github: { token: 'token' },
  review: {
    agents: ['security', 'quality'],
    ignorePatterns: [],
  },
} as unknown as DRSConfig;

const baseOptions = {
  owner: 'octocat',
  repo: 'hello-world',
  prNumber: 17,
  postComments: true,
  postErrorComment: true,
  describe: false,
  postDescription: false,
};

describe('review-pr', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createGitHubClient.mockReturnValue(mockGitHubClient);
    executeUnifiedReview.mockResolvedValue(undefined);

    mockGitHubClient.getPullRequest.mockResolvedValue({
      number: 17,
      title: 'Test PR',
      body: 'Test description',
      user: { login: 'octocat' },
      head: {
        ref: 'feature/pi-migration',
        sha: 'head-sha',
      },
      base: {
        ref: 'main',
      },
    });

    mockGitHubClient.getPRFiles.mockResolvedValue([
      {
        filename: 'src/app.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: '@@ -8,2 +8,3 @@\n context line\n+new line\n-removed line',
      },
      {
        filename: 'src/old.ts',
        status: 'removed',
        additions: 0,
        deletions: 5,
        changes: 5,
        patch: '@@ -1 +0,0 @@\n-old line',
      },
    ]);
  });

  it('loads PR context once and forwards diff-aware validators to unified review', async () => {
    await reviewPR(baseConfig, baseOptions);

    expect(createGitHubClient).toHaveBeenCalledTimes(1);
    expect(mockGitHubClient.getPullRequest).toHaveBeenCalledWith('octocat', 'hello-world', 17);
    expect(mockGitHubClient.getPRFiles).toHaveBeenCalledWith('octocat', 'hello-world', 17);

    const unifiedOptions = vi.mocked(executeUnifiedReview).mock.calls[0][1] as UnifiedReviewOptions;

    expect(unifiedOptions.pullRequest).toEqual(
      expect.objectContaining({
        number: 17,
        title: 'Test PR',
        headSha: 'head-sha',
      })
    );
    expect(unifiedOptions.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: 'src/app.ts', status: 'modified' }),
        expect.objectContaining({ filename: 'src/old.ts', status: 'removed' }),
      ])
    );

    expect(unifiedOptions.lineValidator?.isValidLine('src/app.ts', 8)).toBe(true);
    expect(unifiedOptions.lineValidator?.isValidLine('src/app.ts', 9)).toBe(true);
    expect(unifiedOptions.lineValidator?.isValidLine('src/app.ts', 10)).toBe(false);
    expect(unifiedOptions.lineValidator?.isValidLine('src/old.ts', 1)).toBe(false);

    const inlinePosition = unifiedOptions.createInlinePosition?.(
      {
        category: 'QUALITY',
        severity: 'HIGH',
        title: 'Example issue',
        file: 'src/app.ts',
        line: 9,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'quality',
      } as ReviewIssue,
      {
        head: {
          sha: 'ignored-sha',
        },
      }
    );

    expect(inlinePosition).toEqual({
      path: 'src/app.ts',
      line: 9,
      commitSha: 'head-sha',
    });
  });

  it('rejects with actionable guidance when GITHUB_TOKEN is missing', async () => {
    createGitHubClient.mockImplementationOnce(() => {
      throw new Error('GITHUB_TOKEN environment variable is required');
    });

    await expect(reviewPR(baseConfig, baseOptions)).rejects.toThrow('Set GITHUB_TOKEN');
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });

  it('maps GitHub authentication failures to actionable errors', async () => {
    const authError = Object.assign(new Error('Bad credentials'), { status: 401 });
    mockGitHubClient.getPullRequest.mockRejectedValueOnce(authError);

    await expect(reviewPR(baseConfig, baseOptions)).rejects.toThrow(
      'GitHub authentication failed for octocat/hello-world#17'
    );
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });

  it('maps GitHub not found failures with repository/pr remediation', async () => {
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    mockGitHubClient.getPullRequest.mockRejectedValueOnce(notFoundError);

    await expect(reviewPR(baseConfig, baseOptions)).rejects.toThrow(
      'GitHub pull request not found: octocat/hello-world#17'
    );
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });

  it('maps GitHub rate limit failures with retry guidance', async () => {
    const rateLimitError = Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    mockGitHubClient.getPRFiles.mockRejectedValueOnce(rateLimitError);

    await expect(reviewPR(baseConfig, baseOptions)).rejects.toThrow(
      'GitHub API rate limit reached while loading octocat/hello-world#17'
    );
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });
});
