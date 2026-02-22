import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';
import type { UnifiedReviewOptions } from '../lib/unified-review-executor.js';
import { reviewMR } from './review-mr.js';

const { mockGitLabClient, createGitLabClient, executeUnifiedReview } = vi.hoisted(() => ({
  mockGitLabClient: {
    getMergeRequest: vi.fn(),
    getMRChanges: vi.fn(),
  },
  createGitLabClient: vi.fn(),
  executeUnifiedReview: vi.fn(),
}));

vi.mock('../gitlab/client.js', () => ({
  createGitLabClient,
}));

vi.mock('../lib/unified-review-executor.js', () => ({
  executeUnifiedReview,
}));

const baseConfig = {
  opencode: {},
  gitlab: { url: 'https://gitlab.com', token: 'token' },
  github: { token: 'token' },
  review: {
    agents: ['security', 'quality'],
    ignorePatterns: [],
  },
} as unknown as DRSConfig;

const baseOptions = {
  projectId: 'group/repo',
  mrIid: 42,
  postComments: true,
  postErrorComment: true,
  describe: false,
  postDescription: false,
};

describe('review-mr', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createGitLabClient.mockReturnValue(mockGitLabClient);
    executeUnifiedReview.mockResolvedValue(undefined);

    mockGitLabClient.getMergeRequest.mockResolvedValue({
      iid: 42,
      title: 'Test MR',
      source_branch: 'feature/pi-migration',
      target_branch: 'main',
      author: { name: 'test-user' },
      diff_refs: {
        base_sha: 'base-sha',
        head_sha: 'head-sha',
        start_sha: 'start-sha',
      },
    });

    mockGitLabClient.getMRChanges.mockResolvedValue([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
        diff: '@@ -8,2 +8,3 @@\n context line\n+new line\n-removed line',
      },
      {
        oldPath: 'src/old.ts',
        newPath: 'src/old.ts',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
        diff: '@@ -1 +0,0 @@\n-old line',
      },
    ]);
  });

  it('loads MR context once and forwards diff-aware validators to unified review', async () => {
    await reviewMR(baseConfig, baseOptions);

    expect(createGitLabClient).toHaveBeenCalledTimes(1);
    expect(mockGitLabClient.getMergeRequest).toHaveBeenCalledWith('group/repo', 42);
    expect(mockGitLabClient.getMRChanges).toHaveBeenCalledWith('group/repo', 42);

    const unifiedOptions = vi.mocked(executeUnifiedReview).mock.calls[0][1] as UnifiedReviewOptions;

    expect(unifiedOptions.pullRequest).toEqual(
      expect.objectContaining({
        number: 42,
        title: 'Test MR',
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
        diff_refs: {
          base_sha: 'base-sha',
          head_sha: 'head-sha',
          start_sha: 'start-sha',
        },
      }
    );

    expect(inlinePosition).toEqual({
      path: 'src/app.ts',
      line: 9,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      startSha: 'start-sha',
    });
  });

  it('rejects with actionable guidance when GITLAB_TOKEN is missing', async () => {
    createGitLabClient.mockImplementationOnce(() => {
      throw new Error('GITLAB_TOKEN environment variable is required');
    });

    await expect(reviewMR(baseConfig, baseOptions)).rejects.toThrow('Set GITLAB_TOKEN');
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });

  it('maps GitLab authentication failures to actionable errors', async () => {
    mockGitLabClient.getMergeRequest.mockRejectedValueOnce(new Error('401 Unauthorized'));

    await expect(reviewMR(baseConfig, baseOptions)).rejects.toThrow(
      'GitLab authentication failed for group/repo!42'
    );
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });

  it('maps GitLab not found failures with project/mr remediation', async () => {
    mockGitLabClient.getMergeRequest.mockRejectedValueOnce(new Error('404 Not Found'));

    await expect(reviewMR(baseConfig, baseOptions)).rejects.toThrow(
      'GitLab merge request not found: group/repo!42'
    );
    expect(executeUnifiedReview).not.toHaveBeenCalled();
  });

  it('disables line validation when diff refs are unavailable', async () => {
    mockGitLabClient.getMergeRequest.mockResolvedValueOnce({
      iid: 42,
      title: 'Missing refs',
      source_branch: 'feature/pi-migration',
      target_branch: 'main',
      author: { name: 'test-user' },
    });

    await reviewMR(baseConfig, baseOptions);

    const unifiedOptions = vi.mocked(executeUnifiedReview).mock.calls[0][1] as UnifiedReviewOptions;
    expect(unifiedOptions.lineValidator?.isValidLine('src/app.ts', 8)).toBe(false);
  });
});
