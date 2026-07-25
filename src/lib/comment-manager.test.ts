import { describe, it, expect } from 'vitest';
import {
  createIssueFingerprint,
  createIssueStableSignature,
  createLegacyIssueFingerprint,
  extractCommentId,
  extractIssueFingerprints,
  extractIssueSignatures,
  filterCriticalAndHigh,
  filterDuplicateIssues,
  filterDuplicateIssuesAgainstComments,
  findStaleIssueComments,
  findExistingSummaryComment,
  findExistingErrorComment,
  collectExistingFingerprints,
  prepareIssuesForPosting,
  BOT_COMMENT_ID,
  ERROR_COMMENT_ID,
  type PlatformComment,
} from './comment-manager.js';
import type { ReviewIssue } from './comment-formatter.js';

describe('comment-manager', () => {
  describe('createIssueFingerprint', () => {
    const issue: ReviewIssue = {
      category: 'SECURITY',
      severity: 'HIGH',
      title: 'SQL Injection',
      file: 'src/db.ts',
      line: 42,
      problem: 'Unsafe query',
      solution: 'Use parameterized queries',
      agent: 'security',
    };

    it('creates a deterministic versioned exact fingerprint', () => {
      const fingerprint = createIssueFingerprint(issue);

      expect(fingerprint).toMatch(/^v2:[a-f0-9]{64}$/);
      expect(createIssueFingerprint({ ...issue })).toBe(fingerprint);
    });

    it('keeps exact fingerprints line-sensitive and stable signatures line-insensitive', () => {
      const moved = { ...issue, line: 84 };

      expect(createIssueFingerprint(moved)).not.toBe(createIssueFingerprint(issue));
      expect(createIssueStableSignature(moved)).toBe(createIssueStableSignature(issue));
      expect(createIssueStableSignature(issue)).toMatch(/^sig1:[a-f0-9]{64}$/);
    });

    it('normalizes superficial text and path formatting', () => {
      const reformatted = {
        ...issue,
        file: 'src\\db.ts',
        title: '  **sql   injection** ',
        problem: ' unsafe   QUERY ',
      };

      expect(createIssueFingerprint(reformatted)).toBe(createIssueFingerprint(issue));
      expect(createIssueStableSignature(reformatted)).toBe(createIssueStableSignature(issue));
    });

    it('preserves meaningful punctuation while normalizing Markdown wrappers', () => {
      expect(createIssueFingerprint({ ...issue, title: 'user_id', problem: 'a*b' })).not.toBe(
        createIssueFingerprint({ ...issue, title: 'userid', problem: 'ab' })
      );
      expect(createIssueFingerprint({ ...issue, title: '~flag' })).not.toBe(
        createIssueFingerprint({ ...issue, title: 'flag' })
      );
    });

    it('preserves the legacy fingerprint for existing comments and artifacts', () => {
      expect(createLegacyIssueFingerprint(issue)).toBe('src/db.ts:42:SECURITY:SQL Injection');
      expect(createLegacyIssueFingerprint({ ...issue, line: 0 })).toBe(
        'src/db.ts:general:SECURITY:SQL Injection'
      );
    });

    it('creates distinct exact fingerprints for repeated instances on different lines', () => {
      expect(createIssueFingerprint({ ...issue, line: 43 })).not.toBe(
        createIssueFingerprint(issue)
      );
    });

    it('creates unique fingerprints for different issues', () => {
      const issue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'HIGH',
        title: 'Issue 1',
        file: 'file1.ts',
        line: 10,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'security',
      };

      const issue2: ReviewIssue = {
        category: 'SECURITY',
        severity: 'HIGH',
        title: 'Issue 2',
        file: 'file1.ts',
        line: 10,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'security',
      };

      const fp1 = createIssueFingerprint(issue);
      const fp2 = createIssueFingerprint(issue2);
      expect(fp1).not.toBe(fp2);
    });
  });

  describe('extractCommentId', () => {
    it('should extract comment ID from body', () => {
      const body = 'Some text\n<!-- drs-comment-id: drs-review-summary -->\nMore text';
      const id = extractCommentId(body);
      expect(id).toBe('drs-review-summary');
    });

    it('should return null if no comment ID found', () => {
      const body = 'Just some regular text without markers';
      const id = extractCommentId(body);
      expect(id).toBeNull();
    });

    it('should extract custom comment ID', () => {
      const body = '<!-- drs-comment-id: custom-id-123 -->';
      const id = extractCommentId(body);
      expect(id).toBe('custom-id-123');
    });

    it('should handle multiple comment IDs and return first', () => {
      const body = '<!-- drs-comment-id: first-id -->\n<!-- drs-comment-id: second-id -->';
      const id = extractCommentId(body);
      expect(id).toBe('first-id');
    });
  });

  describe('extractIssueFingerprints', () => {
    it('should extract single fingerprint', () => {
      const body = 'Issue here\n<!-- issue-fp: src/app.ts:10:SECURITY:SQL Injection -->';
      const fingerprints = extractIssueFingerprints(body);
      expect(fingerprints.size).toBe(1);
      expect(fingerprints.has('src/app.ts:10:SECURITY:SQL Injection')).toBe(true);
    });

    it('should extract multiple fingerprints', () => {
      const body = `
        <!-- issue-fp: src/app.ts:10:SECURITY:Issue 1 -->
        Some text
        <!-- issue-fp: src/db.ts:20:QUALITY:Issue 2 -->
        More text
        <!-- issue-fp: src/utils.ts:general:STYLE:Issue 3 -->
      `;
      const fingerprints = extractIssueFingerprints(body);
      expect(fingerprints.size).toBe(3);
      expect(fingerprints.has('src/app.ts:10:SECURITY:Issue 1')).toBe(true);
      expect(fingerprints.has('src/db.ts:20:QUALITY:Issue 2')).toBe(true);
      expect(fingerprints.has('src/utils.ts:general:STYLE:Issue 3')).toBe(true);
    });

    it('should return empty set if no fingerprints found', () => {
      const body = 'Just regular text with no fingerprints';
      const fingerprints = extractIssueFingerprints(body);
      expect(fingerprints.size).toBe(0);
    });

    it('should handle duplicate fingerprints in same comment', () => {
      const body = `
        <!-- issue-fp: src/app.ts:10:SECURITY:Issue -->
        <!-- issue-fp: src/app.ts:10:SECURITY:Issue -->
      `;
      const fingerprints = extractIssueFingerprints(body);
      expect(fingerprints.size).toBe(1);
    });
  });

  describe('stable signature matching', () => {
    const issue: ReviewIssue = {
      category: 'SECURITY',
      severity: 'HIGH',
      title: 'Missing authorization',
      file: 'src/api.ts',
      line: 10,
      problem: 'The endpoint does not verify access.',
      solution: 'Restore the authorization check.',
      agent: 'security',
    };

    it('extracts stable signatures from comments', () => {
      const signature = createIssueStableSignature(issue);
      expect(extractIssueSignatures(`<!-- issue-sig: ${signature} -->`)).toEqual(
        new Set([signature])
      );
    });

    it('deduplicates a uniquely moved issue by stable signature', () => {
      const fingerprint = createIssueFingerprint(issue);
      const signature = createIssueStableSignature(issue);
      const moved = { ...issue, line: 40 };
      const comments = [
        {
          id: 1,
          body: `<!-- issue-fp: ${fingerprint} -->\n<!-- issue-sig: ${signature} -->`,
        },
      ];

      expect(filterDuplicateIssuesAgainstComments([moved], comments)).toEqual([]);
      expect(findStaleIssueComments([moved], comments)).toEqual([]);
    });

    it('does not collapse repeated current instances with an ambiguous signature', () => {
      const fingerprint = createIssueFingerprint({ ...issue, line: 30 });
      const signature = createIssueStableSignature(issue);
      const repeated = { ...issue, line: 20 };
      const comments = [
        {
          id: 1,
          body: `<!-- issue-fp: ${fingerprint} -->\n<!-- issue-sig: ${signature} -->`,
        },
      ];

      expect(filterDuplicateIssuesAgainstComments([issue, repeated], comments)).toEqual([
        issue,
        repeated,
      ]);
      expect(findStaleIssueComments([issue, repeated], comments)).toEqual(comments);
    });

    it('does not treat a signature-only comment as DRS-owned', () => {
      const signature = createIssueStableSignature(issue);
      const comments = [{ id: 1, body: `<!-- issue-sig: ${signature} -->` }];

      expect(filterDuplicateIssuesAgainstComments([issue], comments)).toEqual([issue]);
      expect(findStaleIssueComments([], comments)).toEqual([]);
    });

    it('does not use signature continuity when existing comments are ambiguous', () => {
      const signature = createIssueStableSignature(issue);
      const comments = [
        {
          id: 1,
          body: `<!-- issue-fp: v2:first -->\n<!-- issue-sig: ${signature} -->`,
        },
        {
          id: 2,
          body: `<!-- issue-fp: v2:second -->\n<!-- issue-sig: ${signature} -->`,
        },
      ];

      expect(filterDuplicateIssuesAgainstComments([issue], comments)).toEqual([issue]);
      expect(findStaleIssueComments([issue], comments)).toEqual(comments);
    });

    it('matches an existing legacy fingerprint exactly', () => {
      const comments = [
        { id: 1, body: `<!-- issue-fp: ${createLegacyIssueFingerprint(issue)} -->` },
      ];

      expect(filterDuplicateIssuesAgainstComments([issue], comments)).toEqual([]);
    });

    it('removes comments whose fingerprint and signature are no longer current', () => {
      const stale = {
        id: 1,
        body: '<!-- issue-fp: v2:stale -->\n<!-- issue-sig: sig1:stale -->',
      };
      const human = { id: 2, body: 'Human comment' };

      expect(findStaleIssueComments([issue], [stale, human])).toEqual([stale]);
    });
  });

  describe('filterCriticalAndHigh', () => {
    it('should filter only CRITICAL issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Critical issue',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Medium issue',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const filtered = filterCriticalAndHigh(issues);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].severity).toBe('CRITICAL');
    });

    it('should filter only HIGH issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'High issue',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'LOW',
          title: 'Low issue',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const filtered = filterCriticalAndHigh(issues);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].severity).toBe('HIGH');
    });

    it('should filter both CRITICAL and HIGH issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Critical',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'High',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Medium',
          file: 'file.ts',
          line: 3,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Low',
          file: 'file.ts',
          line: 4,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'style',
        },
      ];

      const filtered = filterCriticalAndHigh(issues);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH')).toBe(true);
    });

    it('should return empty array if no critical/high issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Medium',
          file: 'file.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Low',
          file: 'file.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'style',
        },
      ];

      const filtered = filterCriticalAndHigh(issues);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('filterDuplicateIssues', () => {
    it('should filter out duplicate issues', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'SQL Injection',
          file: 'src/db.ts',
          line: 42,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Code smell',
          file: 'src/app.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const existingFingerprints = new Set(['src/db.ts:42:SECURITY:SQL Injection']);
      const filtered = filterDuplicateIssues(issues, existingFingerprints);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Code smell');
    });

    it('should return all issues if no duplicates', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Issue 1',
          file: 'file1.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Issue 2',
          file: 'file2.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const existingFingerprints = new Set<string>();
      const filtered = filterDuplicateIssues(issues, existingFingerprints);

      expect(filtered).toHaveLength(2);
    });

    it('should filter all issues if all are duplicates', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Issue 1',
          file: 'file1.ts',
          line: 1,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Issue 2',
          file: 'file2.ts',
          line: 2,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const existingFingerprints = new Set([
        'file1.ts:1:SECURITY:Issue 1',
        'file2.ts:2:QUALITY:Issue 2',
      ]);
      const filtered = filterDuplicateIssues(issues, existingFingerprints);

      expect(filtered).toHaveLength(0);
    });
  });

  describe('findExistingSummaryComment', () => {
    it('should find summary comment with bot marker', () => {
      const comments: PlatformComment[] = [
        { id: 1, body: 'Regular comment' },
        {
          id: 2,
          body: `Review Summary\n<!-- drs-comment-id: ${BOT_COMMENT_ID} -->\nSummary text`,
        },
        { id: 3, body: 'Another comment' },
      ];

      const found = findExistingSummaryComment(comments);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(2);
    });

    it('should return null if no summary comment exists', () => {
      const comments: PlatformComment[] = [
        { id: 1, body: 'Regular comment 1' },
        { id: 2, body: 'Regular comment 2' },
      ];

      const found = findExistingSummaryComment(comments);
      expect(found).toBeNull();
    });

    it('should return first summary comment if multiple exist', () => {
      const comments: PlatformComment[] = [
        {
          id: 1,
          body: `Summary 1\n<!-- drs-comment-id: ${BOT_COMMENT_ID} -->`,
        },
        {
          id: 2,
          body: `Summary 2\n<!-- drs-comment-id: ${BOT_COMMENT_ID} -->`,
        },
      ];

      const found = findExistingSummaryComment(comments);
      expect(found?.id).toBe(1);
    });

    it('should handle empty comments array', () => {
      const comments: PlatformComment[] = [];
      const found = findExistingSummaryComment(comments);
      expect(found).toBeNull();
    });
  });

  describe('findExistingErrorComment', () => {
    it('should find error comment with error marker', () => {
      const comments: PlatformComment[] = [
        { id: 1, body: 'Regular comment' },
        {
          id: 2,
          body: `Error!\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->\nError details`,
        },
        { id: 3, body: 'Another comment' },
      ];

      const found = findExistingErrorComment(comments);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(2);
    });

    it('should return null if no error comment exists', () => {
      const comments: PlatformComment[] = [
        { id: 1, body: 'Regular comment 1' },
        { id: 2, body: 'Regular comment 2' },
        {
          id: 3,
          body: `Summary\n<!-- drs-comment-id: ${BOT_COMMENT_ID} -->`,
        },
      ];

      const found = findExistingErrorComment(comments);
      expect(found).toBeNull();
    });

    it('should return first error comment if multiple exist', () => {
      const comments: PlatformComment[] = [
        {
          id: 1,
          body: `Error 1\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`,
        },
        {
          id: 2,
          body: `Error 2\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`,
        },
      ];

      const found = findExistingErrorComment(comments);
      expect(found?.id).toBe(1);
    });

    it('should handle empty comments array', () => {
      const comments: PlatformComment[] = [];
      const found = findExistingErrorComment(comments);
      expect(found).toBeNull();
    });

    it('should distinguish between error and summary comments', () => {
      const comments: PlatformComment[] = [
        {
          id: 1,
          body: `Summary\n<!-- drs-comment-id: ${BOT_COMMENT_ID} -->`,
        },
        {
          id: 2,
          body: `Error\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`,
        },
      ];

      const errorComment = findExistingErrorComment(comments);
      const summaryComment = findExistingSummaryComment(comments);

      expect(errorComment?.id).toBe(2);
      expect(summaryComment?.id).toBe(1);
    });
  });

  describe('collectExistingFingerprints', () => {
    it('should collect fingerprints from multiple comments', () => {
      const comments: PlatformComment[] = [
        {
          id: 1,
          body: `Issue 1\n<!-- issue-fp: file1.ts:10:SECURITY:Issue 1 -->`,
        },
        {
          id: 2,
          body: `Issue 2\n<!-- issue-fp: file2.ts:20:QUALITY:Issue 2 -->`,
        },
      ];

      const fingerprints = collectExistingFingerprints(comments);
      expect(fingerprints.size).toBe(2);
      expect(fingerprints.has('file1.ts:10:SECURITY:Issue 1')).toBe(true);
      expect(fingerprints.has('file2.ts:20:QUALITY:Issue 2')).toBe(true);
    });

    it('should collect multiple fingerprints from single comment', () => {
      const comments: PlatformComment[] = [
        {
          id: 1,
          body: `
            <!-- issue-fp: file1.ts:10:SECURITY:Issue 1 -->
            <!-- issue-fp: file2.ts:20:QUALITY:Issue 2 -->
            <!-- issue-fp: file3.ts:30:STYLE:Issue 3 -->
          `,
        },
      ];

      const fingerprints = collectExistingFingerprints(comments);
      expect(fingerprints.size).toBe(3);
    });

    it('should deduplicate fingerprints across comments', () => {
      const comments: PlatformComment[] = [
        {
          id: 1,
          body: `<!-- issue-fp: file1.ts:10:SECURITY:Issue -->`,
        },
        {
          id: 2,
          body: `<!-- issue-fp: file1.ts:10:SECURITY:Issue -->`,
        },
      ];

      const fingerprints = collectExistingFingerprints(comments);
      expect(fingerprints.size).toBe(1);
    });

    it('should return empty set for comments with no fingerprints', () => {
      const comments: PlatformComment[] = [
        { id: 1, body: 'Regular comment 1' },
        { id: 2, body: 'Regular comment 2' },
      ];

      const fingerprints = collectExistingFingerprints(comments);
      expect(fingerprints.size).toBe(0);
    });

    it('should handle empty comments array', () => {
      const comments: PlatformComment[] = [];
      const fingerprints = collectExistingFingerprints(comments);
      expect(fingerprints.size).toBe(0);
    });
  });

  describe('prepareIssuesForPosting', () => {
    it('should filter and prepare issues correctly', () => {
      const allIssues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'New critical issue',
          file: 'file1.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'New high issue',
          file: 'file2.ts',
          line: 20,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Medium issue',
          file: 'file3.ts',
          line: 30,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Low issue',
          file: 'file4.ts',
          line: 40,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'style',
        },
      ];

      const existingComments: PlatformComment[] = [];

      const result = prepareIssuesForPosting(allIssues, existingComments);

      expect(result.inlineIssues).toHaveLength(2);
      expect(result.deduplicatedCount).toBe(0);
      expect(result.nonInlineCount).toBe(2); // MEDIUM + LOW
    });

    it('should deduplicate existing issues', () => {
      const allIssues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Existing issue',
          file: 'file1.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'New issue',
          file: 'file2.ts',
          line: 20,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
      ];

      const existingComments: PlatformComment[] = [
        {
          id: 1,
          body: '<!-- issue-fp: file1.ts:10:SECURITY:Existing issue -->',
        },
      ];

      const result = prepareIssuesForPosting(allIssues, existingComments);

      expect(result.inlineIssues).toHaveLength(1);
      expect(result.inlineIssues[0].title).toBe('New issue');
      expect(result.deduplicatedCount).toBe(1);
    });

    it('should filter out issues without line numbers', () => {
      const allIssues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'With line',
          file: 'file1.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Without line',
          file: 'file2.ts',
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
      ];

      const existingComments: PlatformComment[] = [];

      const result = prepareIssuesForPosting(allIssues, existingComments);

      expect(result.inlineIssues).toHaveLength(1);
      expect(result.inlineIssues[0].title).toBe('With line');
    });

    it('should apply custom valid lines checker', () => {
      const allIssues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'Valid line',
          file: 'file1.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Invalid line',
          file: 'file2.ts',
          line: 999,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'security',
        },
      ];

      const existingComments: PlatformComment[] = [];

      // Only allow lines <= 100
      const validLinesChecker = (issue: ReviewIssue) => {
        return issue.line !== undefined && issue.line <= 100;
      };

      const result = prepareIssuesForPosting(allIssues, existingComments, validLinesChecker);

      expect(result.inlineIssues).toHaveLength(1);
      expect(result.inlineIssues[0].title).toBe('Valid line');
    });

    it('should handle all issues being filtered out', () => {
      const allIssues: ReviewIssue[] = [
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Medium issue',
          file: 'file1.ts',
          line: 10,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      ];

      const existingComments: PlatformComment[] = [];

      const result = prepareIssuesForPosting(allIssues, existingComments);

      expect(result.inlineIssues).toHaveLength(0);
      expect(result.nonInlineCount).toBe(1);
      expect(result.deduplicatedCount).toBe(0);
    });

    it('should handle empty issues array', () => {
      const allIssues: ReviewIssue[] = [];
      const existingComments: PlatformComment[] = [];

      const result = prepareIssuesForPosting(allIssues, existingComments);

      expect(result.inlineIssues).toHaveLength(0);
      expect(result.nonInlineCount).toBe(0);
      expect(result.deduplicatedCount).toBe(0);
    });
  });
});
