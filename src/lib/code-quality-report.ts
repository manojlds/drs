/**
 * GitLab Code Quality Report Generator
 *
 * Generates code quality reports in GitLab's JSON format for CI/CD integration.
 * @see https://docs.gitlab.com/ci/testing/code_quality/
 */

import type { ReviewIssue } from './comment-formatter.js';
import { createIssueFingerprint } from './comment-manager.js';

/**
 * GitLab Code Quality issue structure
 * Follows the CodeClimate format required by GitLab
 */
export interface CodeQualityIssue {
  /** Human-readable description of the violation */
  description: string;
  /** Unique name representing the static analysis check */
  check_name: string;
  /** Unique fingerprint to identify the violation (e.g., MD5 hash) */
  fingerprint: string;
  /** Severity level: info, minor, major, critical, or blocker */
  severity: 'info' | 'minor' | 'major' | 'critical' | 'blocker';
  /** Location of the issue */
  location: {
    /** Relative path to the file */
    path: string;
    /** Line information */
    lines: {
      /** Starting line number */
      begin: number;
    };
  };
}

/**
 * Map DRS severity to GitLab code quality severity
 */
function mapSeverity(drsSeverity: string): CodeQualityIssue['severity'] {
  const severityMap: Record<string, CodeQualityIssue['severity']> = {
    CRITICAL: 'blocker',
    HIGH: 'critical',
    MEDIUM: 'major',
    LOW: 'minor',
    INFO: 'info',
  };

  return severityMap[drsSeverity] || 'info';
}

/**
 * Generate check name from category and severity
 */
function generateCheckName(issue: ReviewIssue): string {
  const category = issue.category.toLowerCase().replace(/\s+/g, '-');
  return `drs-${category}`;
}

/**
 * Convert DRS ReviewIssue to GitLab CodeQuality format
 */
export function convertToCodeQualityIssue(issue: ReviewIssue): CodeQualityIssue {
  // Build description with problem and solution
  let description = issue.problem;
  if (issue.solution) {
    description += ` ${issue.solution}`;
  }

  return {
    description,
    check_name: generateCheckName(issue),
    fingerprint: createIssueFingerprint(issue),
    severity: mapSeverity(issue.severity),
    location: {
      path: issue.file,
      lines: {
        begin: issue.line || 1,
      },
    },
  };
}

/**
 * Generate GitLab code quality report from review issues
 */
export function generateCodeQualityReport(issues: ReviewIssue[]): CodeQualityIssue[] {
  return issues.map(convertToCodeQualityIssue);
}

/**
 * Convert code quality report to JSON string
 */
export function formatCodeQualityReport(report: CodeQualityIssue[]): string {
  return JSON.stringify(report, null, 2);
}
