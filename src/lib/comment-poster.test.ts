/**
 * Tests for comment-poster.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postReviewComments } from './comment-poster.js';
import {
  formatJevReportComment,
  formatSummaryComment,
  type ReviewIssue,
} from './comment-formatter.js';
import type { PlatformClient } from './platform-client.js';
import { metricKeys, type JevEvaluation } from './jev/types.js';
import {
  createJevPrBaseline,
  encodeJevPrBaselineMarker,
  extractJevPrBaseline,
} from './jev/pr-trend.js';

function jevEvaluation(correctness: number): JevEvaluation {
  return {
    model: 'jev-1.13.0',
    metrics: Object.fromEntries(
      metricKeys.map((metric) => [
        metric,
        metric === 'correctness'
          ? {
              applicable: true,
              score: correctness,
              confidence: 0.8,
              summary: 'Correctness summary',
            }
          : { applicable: false },
      ])
    ) as JevEvaluation['metrics'],
    priorities: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

// Mock dependencies
vi.mock('./comment-formatter.js', () => ({
  formatSummaryComment: vi.fn(
    (_summary, _issues, _botId, _changeSummary, _reviewUsage) => 'formatted summary'
  ),
  formatJevReportComment: vi.fn(() => 'formatted jev'),
  formatIssueComment: vi.fn((issue, _fingerprint) => `formatted issue: ${issue.title}`),
}));

vi.mock('./comment-manager.js', () => ({
  BOT_COMMENT_ID: '<!-- DRS-REVIEW-BOT -->',
  JEV_COMMENT_ID: 'drs-jev-review',
  createIssueIdentity: vi.fn((issue: any) => ({
    fingerprint: `fp-${issue.file}-${issue.line}`,
    stableSignature: `sig-${issue.file}-${issue.title}`,
    legacyFingerprint: `legacy-${issue.file}-${issue.line}`,
  })),
  findStaleIssueComments: vi.fn((issues: any[], comments: any[]) => {
    const currentFingerprints = new Set(issues.map((issue) => `fp-${issue.file}-${issue.line}`));
    return comments.filter((comment) => {
      const match = /<!-- issue-fp: (.*?) -->/.exec(comment.body);
      return match ? !currentFingerprints.has(match[1]) : false;
    });
  }),
  findExistingSummaryComment: vi.fn((comments: any[]) => {
    return comments.find((c: any) => c.body.includes('<!-- DRS-REVIEW-BOT -->'));
  }),
  findExistingCommentById: vi.fn((comments: any[], id: string) => {
    return comments.find((c: any) => c.body.includes(`<!-- drs-comment-id: ${id} -->`)) ?? null;
  }),
  prepareIssuesForPosting: vi.fn((issues: any[], allComments: any[], lineValidator: any) => {
    const criticalHigh = issues.filter(
      (i: any) => i.severity === 'CRITICAL' || i.severity === 'HIGH'
    );
    const inlineIssues = criticalHigh.filter((i: any) => i.line && lineValidator(i));
    return {
      inlineIssues,
      deduplicatedCount: 0,
    };
  }),
}));

describe('comment-poster', () => {
  let mockPlatformClient: PlatformClient;
  let mockSummary: ReturnType<any>;
  let mockIssues: ReviewIssue[];

  beforeEach(() => {
    mockPlatformClient = {
      getPullRequest: vi.fn(),
      getChangedFiles: vi.fn(),
      getComments: vi.fn().mockResolvedValue([]),
      getInlineComments: vi.fn().mockResolvedValue([]),
      createComment: vi.fn().mockResolvedValue({ id: '1' }),
      updateComment: vi.fn().mockResolvedValue({ id: '1' }),
      deleteComment: vi.fn().mockResolvedValue(undefined),
      createBulkInlineComments: vi.fn().mockResolvedValue([]),
      addLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlatformClient;

    mockSummary = {
      issuesFound: 3,
      filesReviewed: 2,
      bySeverity: {
        CRITICAL: 1,
        HIGH: 1,
        MEDIUM: 1,
        LOW: 0,
      },
      byCategory: {
        SECURITY: 1,
        QUALITY: 1,
        STYLE: 1,
        PERFORMANCE: 0,
        DOCUMENTATION: 0,
      },
    };

    mockIssues = [
      {
        severity: 'CRITICAL',
        category: 'SECURITY',
        title: 'SQL injection vulnerability',
        problem: 'SQL injection vulnerability detected',
        solution: 'Use parameterized queries',
        file: 'src/api.ts',
        line: 42,
        agent: 'security',
      },
      {
        severity: 'HIGH',
        category: 'QUALITY',
        title: 'Complex function',
        problem: 'Function is too complex',
        solution: 'Refactor into smaller functions',
        file: 'src/utils.ts',
        line: 10,
        agent: 'quality',
      },
      {
        severity: 'MEDIUM',
        category: 'STYLE',
        title: 'Missing type annotation',
        problem: 'Variable lacks type annotation',
        solution: 'Add explicit type annotation',
        file: 'src/types.ts',
        line: 5,
        agent: 'style',
      },
    ];
  });

  describe('postReviewComments', () => {
    it('rejects oversized comments before reading or mutating platform state', async () => {
      vi.mocked(formatSummaryComment).mockReturnValueOnce('x'.repeat(60_001));

      await expect(
        postReviewComments(
          mockPlatformClient,
          'owner/repo',
          123,
          mockSummary,
          mockIssues,
          undefined,
          undefined,
          {},
          undefined,
          undefined
        )
      ).rejects.toThrow('exceeds the safe platform comment length');

      expect(mockPlatformClient.getComments).not.toHaveBeenCalled();
      expect(mockPlatformClient.deleteComment).not.toHaveBeenCalled();
      expect(mockPlatformClient.createComment).not.toHaveBeenCalled();
      expect(mockPlatformClient.addLabels).not.toHaveBeenCalled();
    });

    it('rechecks head freshness after reads and before platform mutation', async () => {
      const assertCurrentHead = vi.fn().mockRejectedValue(new Error('head moved'));

      await expect(
        postReviewComments(
          mockPlatformClient,
          'owner/repo',
          123,
          mockSummary,
          mockIssues,
          undefined,
          undefined,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          assertCurrentHead
        )
      ).rejects.toThrow('head moved');

      expect(mockPlatformClient.getComments).toHaveBeenCalled();
      expect(mockPlatformClient.createComment).not.toHaveBeenCalled();
      expect(mockPlatformClient.deleteComment).not.toHaveBeenCalled();
      expect(mockPlatformClient.addLabels).not.toHaveBeenCalled();
    });

    it('should create a new summary comment when none exists', async () => {
      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(mockPlatformClient.createComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        'formatted summary'
      );
      expect(mockPlatformClient.updateComment).not.toHaveBeenCalled();
    });

    it('should update existing summary comment', async () => {
      const existingComment = {
        id: '999',
        body: '<!-- DRS-REVIEW-BOT --> Old summary',
        authoredByCurrentUser: true,
      };

      mockPlatformClient.getComments = vi.fn().mockResolvedValue([existingComment]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(mockPlatformClient.updateComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        '999',
        'formatted summary'
      );
      expect(mockPlatformClient.createComment).not.toHaveBeenCalled();
    });

    it('posts Jev and agent results as separate canonical comments', async () => {
      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        { headSha: 'current-head' },
        undefined,
        undefined,
        {
          mode: 'combined',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(8) } },
        }
      );

      const bodies = vi.mocked(mockPlatformClient.createComment).mock.calls.map((call) => call[2]);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain('formatted jev');
      expect(bodies[0]).toContain('drs-jev-pr-baseline-v1');
      expect(bodies[1]).toContain('formatted summary');
      expect(bodies[1]).toContain('separate canonical **Jev Quality Review** comment');
      expect(bodies[1]).not.toContain('drs-jev-pr-baseline-v1');
    });

    it('updates only the canonical Jev comment in Jev-only mode', async () => {
      mockPlatformClient.getComments = vi.fn().mockResolvedValue([
        {
          id: 'summary-id',
          body: '<!-- DRS-REVIEW-BOT --> old summary',
          authoredByCurrentUser: true,
        },
        {
          id: 'jev-id',
          body: '<!-- drs-comment-id: drs-jev-review --> old Jev report',
          authoredByCurrentUser: true,
        },
      ]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        { headSha: 'current-head' },
        undefined,
        undefined,
        {
          mode: 'jev',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(8) } },
        }
      );

      expect(mockPlatformClient.updateComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        'jev-id',
        expect.stringContaining('formatted jev')
      );
      expect(mockPlatformClient.deleteComment).not.toHaveBeenCalledWith(
        'owner/repo',
        123,
        'summary-id'
      );
      expect(mockPlatformClient.createComment).not.toHaveBeenCalled();
    });

    it('migrates a legacy summary baseline when an existing Jev comment has no baseline', async () => {
      const baseline = createJevPrBaseline(jevEvaluation(6), 'first-head');
      const marker = encodeJevPrBaselineMarker(baseline);
      mockPlatformClient.getComments = vi.fn().mockResolvedValue([
        {
          id: 'summary-id',
          body: `<!-- DRS-REVIEW-BOT -->\n${marker}`,
          authoredByCurrentUser: true,
        },
        {
          id: 'jev-id',
          body: '<!-- drs-comment-id: drs-jev-review --> incomplete report',
          authoredByCurrentUser: true,
        },
      ]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        { headSha: 'current-head' },
        undefined,
        undefined,
        {
          mode: 'combined',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(8) } },
        }
      );

      expect(mockPlatformClient.updateComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        'jev-id',
        expect.stringContaining(marker)
      );
    });

    it('preserves the first Jev baseline and passes its trend to summary rendering', async () => {
      const baseline = createJevPrBaseline(jevEvaluation(6), 'first-head');
      const marker = encodeJevPrBaselineMarker(baseline);
      mockPlatformClient.getComments = vi.fn().mockResolvedValue([
        {
          id: '999',
          body: `<!-- DRS-REVIEW-BOT -->\n${marker}`,
          authoredByCurrentUser: true,
        },
      ]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        { headSha: 'current-head' },
        undefined,
        undefined,
        {
          mode: 'combined',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(8) } },
        }
      );

      expect(formatJevReportComment).toHaveBeenLastCalledWith(
        expect.objectContaining({
          jevTrend: expect.objectContaining({
            baselineHeadSha: 'first-head',
            currentHeadSha: 'current-head',
            comparable: true,
          }),
        }),
        undefined,
        { headSha: 'current-head' },
        'drs-jev-review'
      );
      expect(mockPlatformClient.createComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        expect.stringContaining(marker)
      );
    });

    it.each([
      {
        label: 'failed',
        evaluationOptions: {
          mode: 'combined' as const,
          evaluations: {
            jev: {
              status: 'failed' as const,
              error: { code: 'upstream-error', message: 'Jev failed.' },
            },
          },
        },
      },
      { label: 'missing', evaluationOptions: { mode: 'agent' as const } },
    ])(
      'preserves the exact baseline when the current Jev evaluation is $label',
      async ({ evaluationOptions }) => {
        const baseline = createJevPrBaseline(jevEvaluation(6), 'first-head');
        const marker = encodeJevPrBaselineMarker(baseline);
        mockPlatformClient.getComments = vi.fn().mockResolvedValue([
          {
            id: '999',
            body: `<!-- DRS-REVIEW-BOT -->\n${marker}`,
            authoredByCurrentUser: true,
          },
        ]);

        await postReviewComments(
          mockPlatformClient,
          'owner/repo',
          123,
          mockSummary,
          [],
          undefined,
          undefined,
          {},
          undefined,
          undefined,
          undefined,
          { headSha: 'later-head' },
          undefined,
          undefined,
          evaluationOptions
        );

        const bodies = [
          ...vi.mocked(mockPlatformClient.createComment).mock.calls.map((call) => call[2]),
          ...vi.mocked(mockPlatformClient.updateComment).mock.calls.map((call) => call[3]),
        ];
        const baselineBody = bodies.find((body) => body.includes(marker)) ?? '';
        expect(extractJevPrBaseline(baselineBody)).toEqual(baseline);
      }
    );

    it('captures the first successful Jev evaluation as hidden score-only state', async () => {
      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        { headSha: 'first-head' },
        undefined,
        undefined,
        {
          mode: 'jev',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(6) } },
        }
      );

      const postedBody = vi.mocked(mockPlatformClient.createComment).mock.calls[0]?.[2];
      expect(postedBody).toBeDefined();
      expect(extractJevPrBaseline(postedBody ?? '')).toMatchObject({
        headSha: 'first-head',
        model: 'jev-1.13.0',
        metrics: { correctness: { applicable: true, score: 6 } },
      });
      expect(postedBody).not.toContain('Correctness summary');
    });

    it('ignores a forged summary marker from another commenter', async () => {
      const forgedBaseline = createJevPrBaseline(jevEvaluation(1), 'attacker-head');
      mockPlatformClient.getComments = vi.fn().mockResolvedValue([
        {
          id: 'attacker-comment',
          body: `<!-- DRS-REVIEW-BOT -->\n${encodeJevPrBaselineMarker(forgedBaseline)}`,
          authoredByCurrentUser: false,
        },
      ]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        { headSha: 'real-head' },
        undefined,
        undefined,
        {
          mode: 'jev',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(8) } },
        }
      );

      expect(mockPlatformClient.updateComment).not.toHaveBeenCalled();
      const postedBody = vi.mocked(mockPlatformClient.createComment).mock.calls[0]?.[2] ?? '';
      expect(extractJevPrBaseline(postedBody)).toMatchObject({
        headSha: 'real-head',
        metrics: { correctness: { applicable: true, score: 8 } },
      });
    });

    it('should post inline comments for CRITICAL/HIGH issues', async () => {
      const mockLineValidator = {
        isValidLine: vi.fn((_file: string, _line: number) => true),
        isChangedLine: vi.fn((_file: string, _line: number) => true),
      };

      const mockCreateInlinePosition = vi.fn((issue: ReviewIssue) => ({
        path: issue.file,
        line: issue.line!,
        side: 'RIGHT' as const,
      }));

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        mockLineValidator,
        mockCreateInlinePosition
      );

      expect(mockPlatformClient.createBulkInlineComments).toHaveBeenCalledWith(
        'owner/repo',
        123,
        expect.arrayContaining([
          expect.objectContaining({
            body: expect.stringContaining('SQL injection vulnerability'),
            position: expect.objectContaining({ path: 'src/api.ts', line: 42 }),
          }),
          expect.objectContaining({
            body: expect.stringContaining('Complex function'),
            position: expect.objectContaining({ path: 'src/utils.ts', line: 10 }),
          }),
        ])
      );
    });

    it('keeps a deletion-only finding in the summary without posting it inline', async () => {
      const deletionIssue: ReviewIssue = {
        severity: 'HIGH',
        category: 'SECURITY',
        title: 'Authorization check removed',
        problem: 'The deletion removes the required authorization check.',
        solution: 'Restore the authorization check.',
        file: 'src/api.ts',
        agent: 'security',
      };
      const mockLineValidator = {
        isValidLine: vi.fn(() => true),
        isChangedLine: vi.fn(() => true),
      };
      const mockCreateInlinePosition = vi.fn();

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        { ...mockSummary, issuesFound: 1 },
        [deletionIssue],
        undefined,
        undefined,
        {},
        mockLineValidator,
        mockCreateInlinePosition
      );

      expect(formatSummaryComment).toHaveBeenCalledWith(
        expect.anything(),
        [deletionIssue],
        expect.any(String),
        undefined,
        undefined,
        undefined,
        undefined
      );
      expect(mockLineValidator.isChangedLine).not.toHaveBeenCalled();
      expect(mockCreateInlinePosition).not.toHaveBeenCalled();
      expect(mockPlatformClient.createBulkInlineComments).not.toHaveBeenCalled();
    });

    it('posts only findings anchored to added lines', async () => {
      const findings: ReviewIssue[] = [
        { ...mockIssues[0], title: 'Added-line issue', line: 11 },
        { ...mockIssues[1], title: 'Context-line issue', line: 10 },
        { ...mockIssues[1], title: 'Deleted-line issue', line: 9 },
      ];
      const mockLineValidator = {
        isValidLine: vi.fn(() => true),
        isChangedLine: vi.fn((_file: string, line: number) => line === 11),
      };
      const mockCreateInlinePosition = vi.fn((issue: ReviewIssue) => ({
        path: issue.file,
        line: issue.line!,
      }));

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        findings,
        undefined,
        undefined,
        {},
        mockLineValidator,
        mockCreateInlinePosition
      );

      expect(mockLineValidator.isChangedLine).toHaveBeenCalledTimes(3);
      expect(mockLineValidator.isValidLine).not.toHaveBeenCalled();
      expect(mockCreateInlinePosition).toHaveBeenCalledTimes(1);
      expect(mockCreateInlinePosition).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Added-line issue', line: 11 }),
        {}
      );
    });

    it('should not post inline comments for MEDIUM/LOW issues', async () => {
      const lowSeverityIssues: ReviewIssue[] = [
        {
          severity: 'MEDIUM',
          category: 'STYLE',
          title: 'Medium issue',
          problem: 'Medium severity issue',
          solution: 'Fix this issue',
          file: 'src/test.ts',
          line: 1,
          agent: 'style',
        },
        {
          severity: 'LOW',
          category: 'STYLE',
          title: 'Low issue',
          problem: 'Low severity issue',
          solution: 'Fix this issue',
          file: 'src/test.ts',
          line: 2,
          agent: 'style',
        },
      ];

      const mockLineValidator = {
        isValidLine: vi.fn(() => true),
        isChangedLine: vi.fn(() => true),
      };

      const mockCreateInlinePosition = vi.fn((issue: ReviewIssue) => ({
        path: issue.file,
        line: issue.line!,
        side: 'RIGHT' as const,
      }));

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        {
          issuesFound: 2,
          filesReviewed: 1,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 1 },
          byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 2, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
        lowSeverityIssues,
        undefined,
        undefined,
        {},
        mockLineValidator,
        mockCreateInlinePosition
      );

      // Should not create inline comments for MEDIUM/LOW
      expect(mockPlatformClient.createBulkInlineComments).not.toHaveBeenCalled();
    });

    it('should skip inline comments when no line validator provided', async () => {
      const mockCreateInlinePosition = vi.fn((issue: ReviewIssue) => ({
        path: issue.file,
        line: issue.line!,
        side: 'RIGHT' as const,
      }));

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined, // No line validator
        mockCreateInlinePosition
      );

      // Should not create inline comments
      expect(mockPlatformClient.createBulkInlineComments).not.toHaveBeenCalled();
    });

    it('should skip inline comments when no position builder provided', async () => {
      const mockLineValidator = {
        isValidLine: vi.fn(() => true),
        isChangedLine: vi.fn(() => true),
      };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        mockLineValidator,
        undefined // No position builder
      );

      // Should not create inline comments
      expect(mockPlatformClient.createBulkInlineComments).not.toHaveBeenCalled();
    });

    it('should add ai-reviewed label', async () => {
      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(mockPlatformClient.addLabels).toHaveBeenCalledWith('owner/repo', 123, ['ai-reviewed']);
    });

    it('should fetch both regular and inline comments', async () => {
      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(mockPlatformClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockPlatformClient.getInlineComments).toHaveBeenCalledWith('owner/repo', 123);
    });

    it('should delete stale DRS inline comments before posting new comments', async () => {
      mockPlatformClient.getInlineComments = vi.fn().mockResolvedValue([
        { id: 'current', body: '<!-- issue-fp: fp-src/api.ts-42 --> current issue' },
        { id: 'stale', body: '<!-- issue-fp: fp-src/old.ts-99 --> stale issue' },
        { id: 'human', body: 'regular reviewer comment' },
      ]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined,
        undefined
      );

      expect(mockPlatformClient.deleteComment).toHaveBeenCalledWith('owner/repo', 123, 'stale');
      expect(mockPlatformClient.deleteComment).not.toHaveBeenCalledWith(
        'owner/repo',
        123,
        'current'
      );
      expect(mockPlatformClient.deleteComment).not.toHaveBeenCalledWith('owner/repo', 123, 'human');
    });

    it('should include change summary in formatted comment', async () => {
      const mockChangeSummary = {
        type: 'feature' as const,
        subsystems: ['api'],
        complexity: 'medium' as const,
        riskLevel: 'low' as const,
        linesAdded: 50,
        linesRemoved: 20,
        filesChanged: 5,
        description: 'Added new feature',
      };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        mockChangeSummary,
        undefined,
        {},
        undefined,
        undefined
      );

      // Should be called with change summary
      const { formatSummaryComment } = await import('./comment-formatter.js');
      expect(formatSummaryComment).toHaveBeenCalledWith(
        mockSummary,
        mockIssues,
        expect.any(String),
        mockChangeSummary,
        undefined,
        undefined,
        undefined
      );
    });

    it('should pass usage summary into formatted comment', async () => {
      const usage = {
        total: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 125,
          cost: 0.01,
        },
        agents: [],
      };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        usage,
        {},
        undefined,
        undefined
      );

      const { formatSummaryComment } = await import('./comment-formatter.js');
      expect(formatSummaryComment).toHaveBeenCalledWith(
        mockSummary,
        mockIssues,
        expect.any(String),
        undefined,
        usage,
        undefined,
        undefined
      );
    });

    it('separates agent and Jev usage between their canonical comments', async () => {
      const agent = {
        agentType: 'review/unified-reviewer',
        model: 'provider/reviewer',
        turns: 1,
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: 0.01,
        },
      };
      const evaluator = {
        agentType: 'evaluator/jev',
        model: 'jev-1.13.0',
        turns: 1,
        usage: {
          input: 50,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 60,
          cost: 0.0000021,
        },
      };
      const usage = {
        total: {
          input: 150,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 180,
          cost: 0.0100021,
        },
        agents: [agent, evaluator],
      };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        [],
        undefined,
        usage,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          mode: 'combined',
          evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(8) } },
        }
      );

      expect(formatSummaryComment).toHaveBeenCalledWith(
        mockSummary,
        [],
        expect.any(String),
        undefined,
        expect.objectContaining({ agents: [agent] }),
        undefined,
        undefined
      );
      expect(formatJevReportComment).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ agents: [evaluator] }),
        undefined,
        'drs-jev-review'
      );
    });

    it('should pass review metadata into formatted comment', async () => {
      const reviewMetadata = {
        headSha: 'abcdef1234567890',
        sourceBranch: 'feature/review-metadata',
        targetBranch: 'main',
      };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        reviewMetadata
      );

      const { formatSummaryComment } = await import('./comment-formatter.js');
      expect(formatSummaryComment).toHaveBeenCalledWith(
        mockSummary,
        mockIssues,
        expect.any(String),
        undefined,
        undefined,
        undefined,
        reviewMetadata
      );
    });

    it('should pass Cursor fix link options into formatted comments when enabled', async () => {
      const mockLineValidator = {
        isValidLine: vi.fn((_file: string, _line: number) => true),
        isChangedLine: vi.fn((_file: string, _line: number) => true),
      };

      const mockCreateInlinePosition = vi.fn((issue: ReviewIssue) => ({
        path: issue.file,
        line: issue.line!,
      }));

      const cursorFixLinks = { enabled: true, workspace: 'drs' };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
        undefined,
        undefined,
        {},
        mockLineValidator,
        mockCreateInlinePosition,
        cursorFixLinks
      );

      const { formatSummaryComment, formatIssueComment } = await import('./comment-formatter.js');
      expect(formatSummaryComment).toHaveBeenCalledWith(
        mockSummary,
        mockIssues,
        expect.any(String),
        undefined,
        undefined,
        cursorFixLinks,
        undefined
      );
      expect(formatIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'SQL injection vulnerability' }),
        expect.any(String),
        cursorFixLinks,
        expect.any(String)
      );
    });
  });
});
