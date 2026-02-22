import { describe, it, expect } from 'vitest';
import {
  formatIssueComment,
  formatSummaryComment,
  formatTerminalIssue,
  formatErrorComment,
  calculateSummary,
  type ReviewIssue,
  type ReviewSummary,
} from './comment-formatter.js';
import type { ChangeSummary } from './change-summary.js';
import type { ReviewUsageSummary } from './review-usage.js';

describe('comment-formatter', () => {
  describe('formatIssueComment', () => {
    it('should format issue with line number', () => {
      const issue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'SQL Injection',
        file: 'src/db.ts',
        line: 42,
        problem: 'Unsafe query construction',
        solution: 'Use parameterized queries',
        agent: 'security',
      };

      const formatted = formatIssueComment(issue);

      expect(formatted).toContain('🔒 SECURITY - SQL Injection');
      expect(formatted).toContain('src/db.ts:42');
      expect(formatted).toContain('🔴 CRITICAL');
      expect(formatted).toContain('security');
      expect(formatted).toContain('Unsafe query construction');
      expect(formatted).toContain('Use parameterized queries');
    });

    it('should format issue without line number', () => {
      const issue: ReviewIssue = {
        category: 'QUALITY',
        severity: 'MEDIUM',
        title: 'Code complexity',
        file: 'src/app.ts',
        problem: 'Function is too complex',
        solution: 'Refactor into smaller functions',
        agent: 'quality',
      };

      const formatted = formatIssueComment(issue);

      expect(formatted).toContain('📊 QUALITY - Code complexity');
      expect(formatted).toContain('src/app.ts`');
      expect(formatted).not.toContain('src/app.ts:'); // Should not have line number
      expect(formatted).toContain('🟠 MEDIUM');
    });

    it('should format issue with references', () => {
      const issue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'HIGH',
        title: 'XSS Vulnerability',
        file: 'src/render.ts',
        line: 10,
        problem: 'Unescaped user input',
        solution: 'Sanitize input before rendering',
        references: ['https://owasp.org/www-community/attacks/xss/', 'CWE-79'],
        agent: 'security',
      };

      const formatted = formatIssueComment(issue);

      expect(formatted).toContain('### References');
      expect(formatted).toContain('https://owasp.org/www-community/attacks/xss/');
      expect(formatted).toContain('CWE-79');
    });

    it('should include fingerprint when provided', () => {
      const issue: ReviewIssue = {
        category: 'STYLE',
        severity: 'LOW',
        title: 'Missing semicolon',
        file: 'src/utils.ts',
        line: 5,
        problem: 'Inconsistent style',
        solution: 'Add semicolon',
        agent: 'style',
      };

      const fingerprint = 'src/utils.ts:5:STYLE:Missing semicolon';
      const formatted = formatIssueComment(issue, fingerprint);

      expect(formatted).toContain(`<!-- issue-fp: ${fingerprint} -->`);
    });

    it('should not include fingerprint when not provided', () => {
      const issue: ReviewIssue = {
        category: 'STYLE',
        severity: 'LOW',
        title: 'Missing semicolon',
        file: 'src/utils.ts',
        line: 5,
        problem: 'Inconsistent style',
        solution: 'Add semicolon',
        agent: 'style',
      };

      const formatted = formatIssueComment(issue);

      expect(formatted).not.toContain('<!-- issue-fp:');
    });

    it('should format PERFORMANCE category correctly', () => {
      const issue: ReviewIssue = {
        category: 'PERFORMANCE',
        severity: 'HIGH',
        title: 'Inefficient loop',
        file: 'src/process.ts',
        line: 20,
        problem: 'N^2 complexity',
        solution: 'Use hash map for O(n) lookup',
        agent: 'performance',
      };

      const formatted = formatIssueComment(issue);

      expect(formatted).toContain('⚡ PERFORMANCE - Inefficient loop');
    });

    it('should format DOCUMENTATION category correctly', () => {
      const issue: ReviewIssue = {
        category: 'DOCUMENTATION',
        severity: 'LOW',
        title: 'Missing JSDoc',
        file: 'src/api.ts',
        line: 15,
        problem: 'Function lacks documentation',
        solution: 'Add JSDoc comment',
        agent: 'documentation',
      };

      const formatted = formatIssueComment(issue);

      expect(formatted).toContain('📝 DOCUMENTATION - Missing JSDoc');
      expect(formatted).toContain('⚪ LOW');
    });
  });

  describe('formatSummaryComment', () => {
    it('should format summary with no issues', () => {
      const summary: ReviewSummary = {
        filesReviewed: 5,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const formatted = formatSummaryComment(summary, []);

      expect(formatted).toContain('📋 Code Review Analysis');
      expect(formatted).toContain('Files Reviewed**: 5');
      expect(formatted).toContain('Total Issues**: 0');
      expect(formatted).toContain('✅ **No issues found!**');
      expect(formatted).toContain('DRS');
    });

    it('should format summary with issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'SQL Injection',
          file: 'src/db.ts',
          line: 42,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'HIGH',
          title: 'Code smell',
          file: 'src/app.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const summary: ReviewSummary = {
        filesReviewed: 2,
        issuesFound: 2,
        bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 1, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const formatted = formatSummaryComment(summary, issues);

      expect(formatted).toContain('Files Reviewed**: 2');
      expect(formatted).toContain('Total Issues**: 2');
      expect(formatted).toContain('Critical**: 1');
      expect(formatted).toContain('High**: 1');
      expect(formatted).toContain('Security**: 1');
      expect(formatted).toContain('Quality**: 1');
      expect(formatted).toContain('🔴 Critical Issues');
      expect(formatted).toContain('🟡 High Priority Issues');
      expect(formatted).toContain('SQL Injection');
      expect(formatted).toContain('Code smell');
    });

    it('should include comment ID when provided', () => {
      const summary: ReviewSummary = {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const commentId = 'drs-review-summary';
      const formatted = formatSummaryComment(summary, [], commentId);

      expect(formatted).toContain(`<!-- drs-comment-id: ${commentId} -->`);
    });

    it('should include change summary when provided', () => {
      const summary: ReviewSummary = {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const changeSummary: ChangeSummary = {
        description: 'Added authentication system',
        type: 'feature',
        complexity: 'high',
        riskLevel: 'medium',
        subsystems: ['auth', 'api'],
      };

      const formatted = formatSummaryComment(summary, [], undefined, changeSummary);

      expect(formatted).toContain('🧭 Change Summary');
      expect(formatted).toContain('Added authentication system');
      expect(formatted).toContain('Type**: feature');
      expect(formatted).toContain('Complexity**: high');
      expect(formatted).toContain('Risk Level**: medium');
      expect(formatted).toContain('Affected Subsystems**: auth, api');
    });

    it('should format medium priority issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Medium issue',
          file: 'file.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const summary: ReviewSummary = {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const formatted = formatSummaryComment(summary, issues);

      expect(formatted).toContain('🟠 Medium Priority Issues');
      expect(formatted).toContain('Medium issue');
    });

    it('should format low priority issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Low issue',
          file: 'file.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'style',
        },
      ];

      const summary: ReviewSummary = {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 1, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const formatted = formatSummaryComment(summary, issues);

      expect(formatted).toContain('⚪ Low Priority Issues');
      expect(formatted).toContain('Low issue');
    });

    it('should include references in issue details', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Issue with refs',
          file: 'file.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          references: ['https://example.com', 'CWE-123'],
          agent: 'security',
        },
      ];

      const summary: ReviewSummary = {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 1, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const formatted = formatSummaryComment(summary, issues);

      expect(formatted).toContain('**References**: https://example.com, CWE-123');
    });

    it('should handle change summary without subsystems', () => {
      const summary: ReviewSummary = {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const changeSummary: ChangeSummary = {
        description: 'Minor fix',
        type: 'bugfix',
        complexity: 'simple',
        riskLevel: 'low',
        subsystems: [],
      };

      const formatted = formatSummaryComment(summary, [], undefined, changeSummary);

      expect(formatted).toContain('Minor fix');
      expect(formatted).not.toContain('Affected Subsystems');
    });

    it('should include expandable usage block when usage data is provided', () => {
      const summary: ReviewSummary = {
        filesReviewed: 3,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      };

      const usage: ReviewUsageSummary = {
        total: {
          input: 1234,
          output: 234,
          cacheRead: 500,
          cacheWrite: 0,
          totalTokens: 1968,
          cost: 0.0423,
        },
        agents: [
          {
            agentType: 'unified-reviewer',
            model: 'opencode/glm-5-free',
            turns: 4,
            success: true,
            usage: {
              input: 1234,
              output: 234,
              cacheRead: 500,
              cacheWrite: 0,
              totalTokens: 1968,
              cost: 0.0423,
            },
          },
        ],
      };

      const formatted = formatSummaryComment(summary, [], undefined, undefined, usage);

      expect(formatted).toContain('💰 Model Usage');
      expect(formatted).toContain('<details>');
      expect(formatted).toContain('View token and cost breakdown');
      expect(formatted).toContain('| Agent | Model | Turns | Input | Output | Cache Read |');
      expect(formatted).toContain('unified-reviewer');
      expect(formatted).toContain('opencode/glm-5-free');
      expect(formatted).toContain('$0.0423');
      expect(formatted).toContain('</details>');
    });
  });

  describe('formatTerminalIssue', () => {
    it('should format issue for terminal output', () => {
      const issue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Security Issue',
        file: 'src/app.ts',
        line: 10,
        problem: 'This is a problem',
        solution: 'This is a solution',
        agent: 'security',
      };

      const formatted = formatTerminalIssue(issue);

      expect(formatted).toContain('🔴 CRITICAL');
      expect(formatted).toContain('🔒 SECURITY');
      expect(formatted).toContain('Security Issue');
      expect(formatted).toContain('📁 src/app.ts:10');
      expect(formatted).toContain('This is a problem');
      expect(formatted).toContain('✅ Fix: This is a solution');
      expect(formatted).toContain('━━━'); // Border
    });

    it('should format issue without line number', () => {
      const issue: ReviewIssue = {
        category: 'QUALITY',
        severity: 'MEDIUM',
        title: 'Quality Issue',
        file: 'src/utils.ts',
        problem: 'Problem description',
        solution: 'Solution description',
        agent: 'quality',
      };

      const formatted = formatTerminalIssue(issue);

      expect(formatted).toContain('📁 src/utils.ts');
      expect(formatted).not.toContain('src/utils.ts:'); // Should not have line number
    });

    it('should format all severity levels correctly', () => {
      const severities: Array<{ severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; emoji: string }> =
        [
          { severity: 'CRITICAL', emoji: '🔴' },
          { severity: 'HIGH', emoji: '🟡' },
          { severity: 'MEDIUM', emoji: '🟠' },
          { severity: 'LOW', emoji: '⚪' },
        ];

      for (const { severity, emoji } of severities) {
        const issue: ReviewIssue = {
          category: 'SECURITY',
          severity,
          title: 'Test',
          file: 'test.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'test',
        };

        const formatted = formatTerminalIssue(issue);
        expect(formatted).toContain(`${emoji} ${severity}`);
      }
    });

    it('should format all categories correctly', () => {
      const categories: Array<{
        category: 'SECURITY' | 'QUALITY' | 'STYLE' | 'PERFORMANCE' | 'DOCUMENTATION';
        emoji: string;
      }> = [
        { category: 'SECURITY', emoji: '🔒' },
        { category: 'QUALITY', emoji: '📊' },
        { category: 'STYLE', emoji: '✨' },
        { category: 'PERFORMANCE', emoji: '⚡' },
        { category: 'DOCUMENTATION', emoji: '📝' },
      ];

      for (const { category, emoji } of categories) {
        const issue: ReviewIssue = {
          category,
          severity: 'MEDIUM',
          title: 'Test',
          file: 'test.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'test',
        };

        const formatted = formatTerminalIssue(issue);
        expect(formatted).toContain(`${emoji} ${category}`);
      }
    });
  });

  describe('calculateSummary', () => {
    it('should calculate summary for empty issues', () => {
      const summary = calculateSummary(5, []);

      expect(summary.filesReviewed).toBe(5);
      expect(summary.issuesFound).toBe(0);
      expect(summary.bySeverity.CRITICAL).toBe(0);
      expect(summary.bySeverity.HIGH).toBe(0);
      expect(summary.bySeverity.MEDIUM).toBe(0);
      expect(summary.bySeverity.LOW).toBe(0);
      expect(summary.byCategory.SECURITY).toBe(0);
      expect(summary.byCategory.QUALITY).toBe(0);
      expect(summary.byCategory.STYLE).toBe(0);
      expect(summary.byCategory.PERFORMANCE).toBe(0);
      expect(summary.byCategory.DOCUMENTATION).toBe(0);
    });

    it('should calculate summary with mixed severity issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Issue 1',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Issue 2',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Issue 3',
          file: 'file.ts',
          line: 3,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Issue 4',
          file: 'file.ts',
          line: 4,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'style',
        },
      ];

      const summary = calculateSummary(3, issues);

      expect(summary.filesReviewed).toBe(3);
      expect(summary.issuesFound).toBe(4);
      expect(summary.bySeverity.CRITICAL).toBe(1);
      expect(summary.bySeverity.HIGH).toBe(1);
      expect(summary.bySeverity.MEDIUM).toBe(1);
      expect(summary.bySeverity.LOW).toBe(1);
      expect(summary.byCategory.SECURITY).toBe(2);
      expect(summary.byCategory.QUALITY).toBe(1);
      expect(summary.byCategory.STYLE).toBe(1);
    });

    it('should calculate summary with multiple issues of same severity', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Issue 1',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'CRITICAL',
          title: 'Issue 2',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
        {
          category: 'PERFORMANCE',
          severity: 'CRITICAL',
          title: 'Issue 3',
          file: 'file.ts',
          line: 3,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'performance',
        },
      ];

      const summary = calculateSummary(1, issues);

      expect(summary.issuesFound).toBe(3);
      expect(summary.bySeverity.CRITICAL).toBe(3);
      expect(summary.byCategory.SECURITY).toBe(1);
      expect(summary.byCategory.QUALITY).toBe(1);
      expect(summary.byCategory.PERFORMANCE).toBe(1);
    });

    it('should calculate summary with multiple issues of same category', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Issue 1',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Issue 2',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'MEDIUM',
          title: 'Issue 3',
          file: 'file.ts',
          line: 3,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
      ];

      const summary = calculateSummary(1, issues);

      expect(summary.issuesFound).toBe(3);
      expect(summary.byCategory.SECURITY).toBe(3);
      expect(summary.bySeverity.CRITICAL).toBe(1);
      expect(summary.bySeverity.HIGH).toBe(1);
      expect(summary.bySeverity.MEDIUM).toBe(1);
    });

    it('should handle zero files reviewed', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Issue',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'style',
        },
      ];

      const summary = calculateSummary(0, issues);

      expect(summary.filesReviewed).toBe(0);
      expect(summary.issuesFound).toBe(1);
    });

    it('should handle all categories and severities', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: '1',
          file: 'f.ts',
          line: 1,
          problem: 'P',
          solution: 'S',
          agent: 'a',
        },
        {
          category: 'QUALITY',
          severity: 'HIGH',
          title: '2',
          file: 'f.ts',
          line: 2,
          problem: 'P',
          solution: 'S',
          agent: 'a',
        },
        {
          category: 'STYLE',
          severity: 'MEDIUM',
          title: '3',
          file: 'f.ts',
          line: 3,
          problem: 'P',
          solution: 'S',
          agent: 'a',
        },
        {
          category: 'PERFORMANCE',
          severity: 'LOW',
          title: '4',
          file: 'f.ts',
          line: 4,
          problem: 'P',
          solution: 'S',
          agent: 'a',
        },
        {
          category: 'DOCUMENTATION',
          severity: 'LOW',
          title: '5',
          file: 'f.ts',
          line: 5,
          problem: 'P',
          solution: 'S',
          agent: 'a',
        },
      ];

      const summary = calculateSummary(5, issues);

      expect(summary.issuesFound).toBe(5);
      expect(summary.byCategory.SECURITY).toBe(1);
      expect(summary.byCategory.QUALITY).toBe(1);
      expect(summary.byCategory.STYLE).toBe(1);
      expect(summary.byCategory.PERFORMANCE).toBe(1);
      expect(summary.byCategory.DOCUMENTATION).toBe(1);
      expect(summary.bySeverity.CRITICAL).toBe(1);
      expect(summary.bySeverity.HIGH).toBe(1);
      expect(summary.bySeverity.MEDIUM).toBe(1);
      expect(summary.bySeverity.LOW).toBe(2);
    });
  });

  describe('formatErrorComment', () => {
    it('should format error comment with standard message', () => {
      const formatted = formatErrorComment();

      expect(formatted).toContain(':warning: DRS Review Failed');
      expect(formatted).toContain('automated code review encountered an error');
      expect(formatted).toContain('check the CI/CD logs');
      expect(formatted).toContain('automatically removed when the review succeeds');
      expect(formatted).toContain('DRS');
    });

    it('should include comment ID when provided', () => {
      const formatted = formatErrorComment('drs-error');

      expect(formatted).toContain('<!-- drs-comment-id: drs-error -->');
    });

    it('should not include comment ID when not provided', () => {
      const formatted = formatErrorComment();

      expect(formatted).not.toContain('<!-- drs-comment-id:');
    });

    it('should not expose error details in comment', () => {
      // Error details should not be in the comment - users should check CI/CD logs
      const formatted = formatErrorComment('drs-error');

      // Should contain the log directive
      expect(formatted).toContain('Please check the CI/CD logs for error details');
      // Should not have a code block for error messages
      expect(formatted).not.toContain('```');
    });
  });
});
