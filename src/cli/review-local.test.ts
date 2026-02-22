import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { reviewLocal } from './review-local.js';

const {
  mockGit,
  parseDiff,
  getChangedFiles,
  getFilesWithDiffs,
  executeReview,
  displayReviewSummary,
  hasBlockingIssues,
  formatReviewJson,
  writeReviewJson,
  printReviewJson,
  formatTerminalIssue,
} = vi.hoisted(() => ({
  mockGit: {
    checkIsRepo: vi.fn(),
    diff: vi.fn(),
  },
  parseDiff: vi.fn(),
  getChangedFiles: vi.fn(),
  getFilesWithDiffs: vi.fn(),
  executeReview: vi.fn(),
  displayReviewSummary: vi.fn(),
  hasBlockingIssues: vi.fn(),
  formatReviewJson: vi.fn(),
  writeReviewJson: vi.fn(),
  printReviewJson: vi.fn(),
  formatTerminalIssue: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
}));

vi.mock('../lib/diff-parser.js', () => ({
  parseDiff,
  getChangedFiles,
  getFilesWithDiffs,
}));

vi.mock('../lib/review-orchestrator.js', () => ({
  executeReview,
  displayReviewSummary,
  hasBlockingIssues,
}));

vi.mock('../lib/json-output.js', () => ({
  formatReviewJson,
  writeReviewJson,
  printReviewJson,
}));

vi.mock('../lib/comment-formatter.js', () => ({
  formatTerminalIssue,
}));

const baseConfig = {
  opencode: {},
  gitlab: { url: '', token: '' },
  github: { token: '' },
  review: {
    agents: ['security', 'quality'],
    ignorePatterns: ['*.test.ts'],
  },
} as unknown as DRSConfig;

const emptySummary = {
  filesReviewed: 1,
  issuesFound: 0,
  bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
  byCategory: {
    SECURITY: 0,
    QUALITY: 0,
    STYLE: 0,
    PERFORMANCE: 0,
    DOCUMENTATION: 0,
  },
};

describe('review-local', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockGit.checkIsRepo.mockResolvedValue(true);
    mockGit.diff.mockResolvedValue('diff --git a/src/app.ts b/src/app.ts');

    parseDiff.mockReturnValue([{ filename: 'src/app.ts' }]);
    getChangedFiles.mockReturnValue(['src/app.ts']);
    getFilesWithDiffs.mockReturnValue([{ filename: 'src/app.ts', patch: '+const answer = 42;' }]);

    executeReview.mockResolvedValue({
      issues: [],
      summary: emptySummary,
      filesReviewed: 1,
    });

    hasBlockingIssues.mockReturnValue(false);
    formatReviewJson.mockReturnValue({ result: 'ok' });
    writeReviewJson.mockResolvedValue(undefined);
    printReviewJson.mockImplementation(() => {});
    displayReviewSummary.mockImplementation(() => {});
    formatTerminalIssue.mockReturnValue('formatted issue');
  });

  it('runs staged reviews through the shared review executor', async () => {
    await reviewLocal(baseConfig, { staged: true });

    expect(mockGit.diff).toHaveBeenCalledWith(['--cached']);
    expect(executeReview).toHaveBeenCalledWith(
      expect.objectContaining({
        review: expect.objectContaining({
          agents: ['security', 'quality'],
        }),
      }),
      expect.objectContaining({
        name: 'Local staged diff',
        files: ['src/app.ts'],
        filesWithDiffs: [{ filename: 'src/app.ts', patch: '+const answer = 42;' }],
        staged: true,
        workingDir: process.cwd(),
      })
    );
  });

  it('throws when executed outside a git repository', async () => {
    mockGit.checkIsRepo.mockResolvedValue(false);

    await expect(reviewLocal(baseConfig, { staged: false })).rejects.toThrow(
      'Not a git repository'
    );
  });

  it('returns early when there are no local changes', async () => {
    mockGit.diff.mockResolvedValue('   ');

    await reviewLocal(baseConfig, { staged: false });

    expect(parseDiff).not.toHaveBeenCalled();
    expect(executeReview).not.toHaveBeenCalled();
  });

  it('exits with code 1 when blocking issues are found', async () => {
    executeReview.mockResolvedValueOnce({
      issues: [
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'SQL Injection risk',
          file: 'src/app.ts',
          line: 10,
          problem: 'Unsanitized SQL input',
          solution: 'Use parameterized query',
          agent: 'security',
        },
      ],
      summary: {
        ...emptySummary,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 1, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      filesReviewed: 1,
    });
    hasBlockingIssues.mockReturnValueOnce(true);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    await reviewLocal(baseConfig, { staged: false });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('writes and prints JSON output when requested', async () => {
    await reviewLocal(baseConfig, {
      staged: false,
      outputPath: '.drs/review-output.json',
      jsonOutput: true,
    });

    expect(formatReviewJson).toHaveBeenCalledWith(emptySummary, [], {
      source: 'local-unstaged',
    });
    expect(writeReviewJson).toHaveBeenCalledWith(
      { result: 'ok' },
      '.drs/review-output.json',
      process.cwd()
    );
    expect(printReviewJson).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('surfaces runtime failures from review execution', async () => {
    executeReview.mockRejectedValueOnce(new Error('Pi runtime unavailable'));

    await expect(reviewLocal(baseConfig, { staged: false })).rejects.toThrow(
      'Pi runtime unavailable'
    );
  });
});
