import { describe, it, expect } from 'vitest';
import {
  convertToCodeQualityIssue,
  generateCodeQualityReport,
  formatCodeQualityReport,
  type CodeQualityIssue,
} from './code-quality-report.js';
import type { ReviewIssue } from './comment-formatter.js';

describe('code-quality-report', () => {
  describe('convertToCodeQualityIssue', () => {
    it('should convert a DRS issue to GitLab code quality format', () => {
      const drsIssue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'SQL Injection',
        file: 'src/api/users.ts',
        line: 42,
        problem: 'Query uses string concatenation.',
        solution: 'Use parameterized queries instead.',
        agent: 'security',
      };

      const result = convertToCodeQualityIssue(drsIssue);

      expect(result).toMatchObject({
        description: 'Query uses string concatenation. Use parameterized queries instead.',
        check_name: 'drs-security',
        severity: 'blocker',
        location: {
          path: 'src/api/users.ts',
          lines: {
            begin: 42,
          },
        },
      });
      expect(result.fingerprint).toBeDefined();
      expect(result.fingerprint.length).toBeGreaterThan(0);
    });

    it('should map CRITICAL severity to blocker', () => {
      const issue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Test',
        file: 'test.ts',
        line: 1,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.severity).toBe('blocker');
    });

    it('should map HIGH severity to critical', () => {
      const issue: ReviewIssue = {
        category: 'QUALITY',
        severity: 'HIGH',
        title: 'Test',
        file: 'test.ts',
        line: 1,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.severity).toBe('critical');
    });

    it('should map MEDIUM severity to major', () => {
      const issue: ReviewIssue = {
        category: 'QUALITY',
        severity: 'MEDIUM',
        title: 'Test',
        file: 'test.ts',
        line: 1,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.severity).toBe('major');
    });

    it('should map LOW severity to minor', () => {
      const issue: ReviewIssue = {
        category: 'STYLE',
        severity: 'LOW',
        title: 'Test',
        file: 'test.ts',
        line: 1,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.severity).toBe('minor');
    });

    it('should generate check_name from category', () => {
      const issue: ReviewIssue = {
        category: 'QUALITY',
        severity: 'MEDIUM',
        title: 'Test',
        file: 'test.ts',
        line: 1,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.check_name).toBe('drs-quality');
    });

    it('should handle issues with empty solution', () => {
      const issue: ReviewIssue = {
        category: 'SECURITY',
        severity: 'HIGH',
        title: 'Test',
        file: 'test.ts',
        line: 1,
        problem: 'This is a problem',
        solution: '',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.description).toBe('This is a problem');
    });

    it('should default to line 1 if no line number provided', () => {
      const issue: ReviewIssue = {
        category: 'STYLE',
        severity: 'LOW',
        title: 'Missing header',
        file: 'src/main.ts',
        problem: 'No copyright header',
        solution: 'Add standard file header',
        agent: 'test',
      };

      const result = convertToCodeQualityIssue(issue);
      expect(result.location.lines.begin).toBe(1);
    });

    it('should create consistent fingerprints for identical issues', () => {
      const issue1: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Test',
        file: 'test.ts',
        line: 42,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const issue2: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Test',
        file: 'test.ts',
        line: 42,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result1 = convertToCodeQualityIssue(issue1);
      const result2 = convertToCodeQualityIssue(issue2);

      expect(result1.fingerprint).toBe(result2.fingerprint);
    });

    it('should create different fingerprints for different issues', () => {
      const issue1: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Test',
        file: 'test.ts',
        line: 42,
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const issue2: ReviewIssue = {
        category: 'SECURITY',
        severity: 'CRITICAL',
        title: 'Test',
        file: 'test.ts',
        line: 43, // Different line
        problem: 'Problem',
        solution: 'Solution',
        agent: 'test',
      };

      const result1 = convertToCodeQualityIssue(issue1);
      const result2 = convertToCodeQualityIssue(issue2);

      expect(result1.fingerprint).not.toBe(result2.fingerprint);
    });
  });

  describe('generateCodeQualityReport', () => {
    it('should convert multiple DRS issues to code quality format', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'SQL Injection',
          file: 'src/api/users.ts',
          line: 42,
          problem: 'Query uses string concatenation',
          solution: 'Use parameterized queries',
          agent: 'security',
        },
        {
          category: 'QUALITY',
          severity: 'HIGH',
          title: 'High complexity',
          file: 'src/utils/helper.ts',
          line: 10,
          problem: 'Function has cyclomatic complexity of 15',
          solution: 'Break into smaller functions',
          agent: 'quality',
        },
      ];

      const report = generateCodeQualityReport(issues);

      expect(report).toHaveLength(2);
      expect(report[0].severity).toBe('blocker');
      expect(report[0].check_name).toBe('drs-security');
      expect(report[1].severity).toBe('critical');
      expect(report[1].check_name).toBe('drs-quality');
    });

    it('should handle empty issues array', () => {
      const report = generateCodeQualityReport([]);
      expect(report).toEqual([]);
    });

    it('should preserve all issues in order', () => {
      const issues: ReviewIssue[] = [
        {
          category: 'SECURITY',
          severity: 'CRITICAL',
          title: 'First',
          file: 'a.ts',
          line: 1,
          problem: 'Problem 1',
          solution: 'Solution 1',
          agent: 'test',
        },
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Second',
          file: 'b.ts',
          line: 2,
          problem: 'Problem 2',
          solution: 'Solution 2',
          agent: 'test',
        },
        {
          category: 'STYLE',
          severity: 'LOW',
          title: 'Third',
          file: 'c.ts',
          line: 3,
          problem: 'Problem 3',
          solution: 'Solution 3',
          agent: 'test',
        },
      ];

      const report = generateCodeQualityReport(issues);

      expect(report).toHaveLength(3);
      expect(report[0].location.path).toBe('a.ts');
      expect(report[1].location.path).toBe('b.ts');
      expect(report[2].location.path).toBe('c.ts');
    });
  });

  describe('formatCodeQualityReport', () => {
    it('should format report as valid JSON', () => {
      const report: CodeQualityIssue[] = [
        {
          description: 'Query uses string concatenation',
          check_name: 'drs-security',
          fingerprint: 'abc123',
          severity: 'blocker',
          location: {
            path: 'src/api/users.ts',
            lines: {
              begin: 42,
            },
          },
        },
      ];

      const json = formatCodeQualityReport(report);

      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].description).toBe('Query uses string concatenation');
    });

    it('should format with pretty printing', () => {
      const report: CodeQualityIssue[] = [
        {
          description: 'Test issue',
          check_name: 'drs-test',
          fingerprint: 'test123',
          severity: 'minor',
          location: {
            path: 'test.ts',
            lines: {
              begin: 1,
            },
          },
        },
      ];

      const json = formatCodeQualityReport(report);

      // Should have indentation (pretty printed)
      expect(json).toContain('\n');
      expect(json).toContain('  ');
    });

    it('should handle empty report', () => {
      const json = formatCodeQualityReport([]);
      expect(json).toBe('[]');
    });

    it('should produce valid GitLab code quality format', () => {
      const report: CodeQualityIssue[] = [
        {
          description: "'unused' is assigned a value but never used.",
          check_name: 'no-unused-vars',
          fingerprint: '7815696ecbf1c96e6894b779456d330e',
          severity: 'minor',
          location: {
            path: 'lib/index.js',
            lines: {
              begin: 42,
            },
          },
        },
      ];

      const json = formatCodeQualityReport(report);
      const parsed = JSON.parse(json);

      // Verify all required fields are present
      expect(parsed[0]).toHaveProperty('description');
      expect(parsed[0]).toHaveProperty('fingerprint');
      expect(parsed[0]).toHaveProperty('location');
      expect(parsed[0].location).toHaveProperty('path');
      expect(parsed[0].location).toHaveProperty('lines');
      expect(parsed[0].location.lines).toHaveProperty('begin');
    });
  });
});
