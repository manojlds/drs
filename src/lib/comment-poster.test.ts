/**
 * Tests for comment-poster.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postReviewComments } from './comment-poster.js';
import type { ReviewIssue } from './comment-formatter.js';
import type { PlatformClient } from './platform-client.js';

// Mock dependencies
vi.mock('./comment-formatter.js', () => ({
  formatSummaryComment: vi.fn((summary, issues, botId, changeSummary) => 'formatted summary'),
  formatIssueComment: vi.fn((issue, fingerprint) => `formatted issue: ${issue.title}`),
}));

vi.mock('./comment-manager.js', () => ({
  BOT_COMMENT_ID: '<!-- DRS-REVIEW-BOT -->',
  createIssueFingerprint: vi.fn((issue: any) => `fp-${issue.file}-${issue.line}`),
  findExistingSummaryComment: vi.fn((comments: any[]) => {
    return comments.find((c: any) => c.body.includes('<!-- DRS-REVIEW-BOT -->'));
  }),
  prepareIssuesForPosting: vi.fn((issues: any[], allComments: any[], lineValidator: any) => {
    const criticalHigh = issues.filter((i: any) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
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
    it('should create a new summary comment when none exists', async () => {
      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
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
      };

      mockPlatformClient.getComments = vi.fn().mockResolvedValue([existingComment]);

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
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

    it('should post inline comments for CRITICAL/HIGH issues', async () => {
      const mockLineValidator = {
        isValidLine: vi.fn((file: string, line: number) => true),
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
      };

      await postReviewComments(
        mockPlatformClient,
        'owner/repo',
        123,
        mockSummary,
        mockIssues,
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
        {},
        undefined,
        undefined
      );

      expect(mockPlatformClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockPlatformClient.getInlineComments).toHaveBeenCalledWith('owner/repo', 123);
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
        mockChangeSummary
      );
    });
  });
});
