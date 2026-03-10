import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { parseReviewUrl, reviewByUrl } from './review-url.js';

const { reviewPR, reviewMR } = vi.hoisted(() => ({
  reviewPR: vi.fn(),
  reviewMR: vi.fn(),
}));

vi.mock('./review-pr.js', () => ({
  reviewPR,
}));

vi.mock('./review-mr.js', () => ({
  reviewMR,
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

describe('parseReviewUrl', () => {
  it('parses GitHub pull request URLs', () => {
    const parsed = parseReviewUrl('https://github.com/octocat/hello-world/pull/123');

    expect(parsed).toEqual({
      platform: 'github',
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 123,
    });
  });

  it('parses GitLab merge request URLs with subgroups', () => {
    const parsed = parseReviewUrl(
      'https://gitlab.example.com/org/security/tools/drs/-/merge_requests/42'
    );

    expect(parsed).toEqual({
      platform: 'gitlab',
      projectId: 'org/security/tools/drs',
      mrIid: 42,
    });
  });

  it('throws for unsupported URLs', () => {
    expect(() => parseReviewUrl('https://example.com/org/repo/issues/10')).toThrow(
      'Unsupported review URL'
    );
  });
});

describe('reviewByUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewPR.mockResolvedValue(undefined);
    reviewMR.mockResolvedValue(undefined);
  });

  it('routes GitHub URLs to reviewPR', async () => {
    await reviewByUrl(baseConfig, {
      url: 'https://github.com/octocat/hello-world/pull/10',
      postComments: true,
      postErrorComment: true,
      describe: true,
      postDescription: false,
      outputPath: 'review.json',
      jsonOutput: true,
      baseBranch: 'release/2026-01',
      debug: true,
    });

    expect(reviewPR).toHaveBeenCalledWith(baseConfig, {
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 10,
      postComments: true,
      postErrorComment: true,
      describe: true,
      postDescription: false,
      outputPath: 'review.json',
      jsonOutput: true,
      baseBranch: 'release/2026-01',
      debug: true,
    });
    expect(reviewMR).not.toHaveBeenCalled();
  });

  it('routes GitLab URLs to reviewMR', async () => {
    await reviewByUrl(baseConfig, {
      url: 'https://gitlab.com/group/subgroup/repo/-/merge_requests/88',
      postComments: false,
      postErrorComment: false,
      describe: false,
      postDescription: false,
      codeQualityReport: 'gl-code-quality-report.json',
      outputPath: 'review.json',
      jsonOutput: false,
      baseBranch: 'main',
      debug: false,
    });

    expect(reviewMR).toHaveBeenCalledWith(baseConfig, {
      projectId: 'group/subgroup/repo',
      mrIid: 88,
      postComments: false,
      postErrorComment: false,
      describe: false,
      postDescription: false,
      codeQualityReport: 'gl-code-quality-report.json',
      outputPath: 'review.json',
      jsonOutput: false,
      baseBranch: 'main',
      debug: false,
    });
    expect(reviewPR).not.toHaveBeenCalled();
  });

  it('warns and ignores --code-quality-report for GitHub URLs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await reviewByUrl(baseConfig, {
      url: 'https://github.com/octocat/hello-world/pull/9',
      postComments: false,
      postErrorComment: false,
      describe: false,
      postDescription: false,
      codeQualityReport: 'gl-code-quality-report.json',
      jsonOutput: false,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('--code-quality-report is only supported for GitLab MRs')
    );

    warnSpy.mockRestore();
  });
});
