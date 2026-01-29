export type IssueSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type IssueCategory = 'SECURITY' | 'QUALITY' | 'STYLE' | 'PERFORMANCE' | 'DOCUMENTATION';

export interface ReviewIssue {
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  file: string;
  line?: number;
  problem: string;
  solution: string;
  references?: string[];
  agent: string;
}

import type { ChangeSummary } from './change-summary.js';

export interface ReviewSummary {
  filesReviewed: number;
  issuesFound: number;
  bySeverity: Record<IssueSeverity, number>;
  byCategory: Record<IssueCategory, number>;
}

const SEVERITY_EMOJI: Record<IssueSeverity, string> = {
  CRITICAL: '🔴',
  HIGH: '🟡',
  MEDIUM: '🟠',
  LOW: '⚪',
};

const CATEGORY_EMOJI: Record<IssueCategory, string> = {
  SECURITY: '🔒',
  QUALITY: '📊',
  STYLE: '✨',
  PERFORMANCE: '⚡',
  DOCUMENTATION: '📝',
};

/**
 * Format a single review issue as a GitLab comment
 * @param fingerprint Optional fingerprint to embed in comment for deduplication
 */
export function formatIssueComment(issue: ReviewIssue, fingerprint?: string): string {
  const emoji = CATEGORY_EMOJI[issue.category];
  const severityEmoji = SEVERITY_EMOJI[issue.severity];

  // Add hidden fingerprint for deduplication
  let comment = '';
  if (fingerprint) {
    comment += `<!-- issue-fp: ${fingerprint} -->\n`;
  }

  comment += `## ${emoji} ${issue.category} - ${issue.title}\n\n`;
  comment += `**File**: \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`\n`;
  comment += `**Severity**: ${severityEmoji} ${issue.severity}\n`;
  comment += `**Analysis by**: ${issue.agent}\n\n`;

  comment += `### Problem\n${issue.problem}\n\n`;
  comment += `### Solution\n${issue.solution}\n`;

  if (issue.references && issue.references.length > 0) {
    comment += `\n### References\n`;
    for (const ref of issue.references) {
      comment += `- ${ref}\n`;
    }
  }

  return comment;
}

/**
 * Format a review summary as a GitLab comment
 * @param commentId Optional comment ID to embed for update identification
 */
export function formatSummaryComment(
  summary: ReviewSummary,
  issues: ReviewIssue[],
  commentId?: string,
  changeSummary?: ChangeSummary
): string {
  // Add hidden identifier for update-or-create logic
  let comment = '';
  if (commentId) {
    comment += `<!-- drs-comment-id: ${commentId} -->\n`;
  }

  comment += `# 📋 Code Review Analysis\n\n`;

  if (changeSummary) {
    comment += `## 🧭 Change Summary\n\n`;
    comment += `${changeSummary.description}\n\n`;
    comment += `- **Type**: ${changeSummary.type}\n`;
    comment += `- **Complexity**: ${changeSummary.complexity}\n`;
    comment += `- **Risk Level**: ${changeSummary.riskLevel}\n`;
    if (changeSummary.subsystems.length > 0) {
      comment += `- **Affected Subsystems**: ${changeSummary.subsystems.join(', ')}\n`;
    }
    comment += `\n`;
  }

  comment += `## 📊 Statistics\n\n`;
  comment += `- **Files Reviewed**: ${summary.filesReviewed}\n`;
  comment += `- **Total Issues**: ${summary.issuesFound}\n\n`;

  if (summary.issuesFound > 0) {
    comment += `### By Severity\n`;
    comment += `- ${SEVERITY_EMOJI.CRITICAL} **Critical**: ${summary.bySeverity.CRITICAL}\n`;
    comment += `- ${SEVERITY_EMOJI.HIGH} **High**: ${summary.bySeverity.HIGH}\n`;
    comment += `- ${SEVERITY_EMOJI.MEDIUM} **Medium**: ${summary.bySeverity.MEDIUM}\n`;
    comment += `- ${SEVERITY_EMOJI.LOW} **Low**: ${summary.bySeverity.LOW}\n\n`;

    comment += `### By Category\n`;
    comment += `- ${CATEGORY_EMOJI.SECURITY} **Security**: ${summary.byCategory.SECURITY}\n`;
    comment += `- ${CATEGORY_EMOJI.QUALITY} **Quality**: ${summary.byCategory.QUALITY}\n`;
    comment += `- ${CATEGORY_EMOJI.STYLE} **Style**: ${summary.byCategory.STYLE}\n`;
    comment += `- ${CATEGORY_EMOJI.PERFORMANCE} **Performance**: ${summary.byCategory.PERFORMANCE}\n`;
    comment += `- ${CATEGORY_EMOJI.DOCUMENTATION} **Documentation**: ${summary.byCategory.DOCUMENTATION}\n\n`;

    // Group issues by severity
    const criticalIssues = issues.filter((i) => i.severity === 'CRITICAL');
    const highIssues = issues.filter((i) => i.severity === 'HIGH');
    const mediumIssues = issues.filter((i) => i.severity === 'MEDIUM');
    const lowIssues = issues.filter((i) => i.severity === 'LOW');

    // Helper function to format issue details
    const formatIssueDetails = (issue: ReviewIssue) => {
      let details = `### ${CATEGORY_EMOJI[issue.category]} ${issue.title}\n\n`;
      details += `**File**: \`${issue.file}${issue.line ? `:${issue.line}` : ''}\` | **Category**: ${issue.category}\n\n`;
      details += `**Problem**: ${issue.problem}\n\n`;
      details += `**Solution**: ${issue.solution}\n`;
      if (issue.references && issue.references.length > 0) {
        details += `\n**References**: ${issue.references.join(', ')}\n`;
      }
      return details + '\n';
    };

    if (criticalIssues.length > 0) {
      comment += `## 🔴 Critical Issues\n\n`;
      for (const issue of criticalIssues) {
        comment += formatIssueDetails(issue);
      }
    }

    if (highIssues.length > 0) {
      comment += `## 🟡 High Priority Issues\n\n`;
      for (const issue of highIssues) {
        comment += formatIssueDetails(issue);
      }
    }

    if (mediumIssues.length > 0) {
      comment += `## 🟠 Medium Priority Issues\n\n`;
      for (const issue of mediumIssues) {
        comment += formatIssueDetails(issue);
      }
    }

    if (lowIssues.length > 0) {
      comment += `## ⚪ Low Priority Issues\n\n`;
      for (const issue of lowIssues) {
        comment += formatIssueDetails(issue);
      }
    }
  } else {
    comment += `✅ **No issues found!** The code looks good.\n`;
  }

  comment += `\n---\n\n*Analyzed by **DRS** | Diff Review System*\n`;

  return comment;
}

/**
 * Format issue for terminal output with colors
 */
export function formatTerminalIssue(issue: ReviewIssue): string {
  const emoji = CATEGORY_EMOJI[issue.category];
  const severityEmoji = SEVERITY_EMOJI[issue.severity];

  let output = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  output += `${severityEmoji} ${issue.severity}: ${emoji} ${issue.category} - ${issue.title}\n`;
  output += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  output += `📁 ${issue.file}${issue.line ? `:${issue.line}` : ''}\n\n`;
  output += `${issue.problem}\n\n`;
  output += `✅ Fix: ${issue.solution}\n`;

  return output;
}

/**
 * Format an error comment for when DRS fails
 * Does not include error details to avoid exposing sensitive information.
 * Users should check CI/CD logs for the actual error.
 * @param commentId Optional comment ID to embed for identification
 */
export function formatErrorComment(commentId?: string): string {
  let comment = '';
  if (commentId) {
    comment += `<!-- drs-comment-id: ${commentId} -->\n`;
  }

  comment += `# :warning: DRS Review Failed\n\n`;
  comment += `The automated code review encountered an error and could not complete.\n\n`;
  comment += `Please check the CI/CD logs for error details.\n\n`;
  comment += `---\n\n`;
  comment += `*This comment will be automatically removed when the review succeeds.*\n`;
  comment += `*Reported by **DRS** | Diff Review System*\n`;

  return comment;
}

/**
 * Calculate review summary from issues
 */
export function calculateSummary(filesReviewed: number, issues: ReviewIssue[]): ReviewSummary {
  const summary: ReviewSummary = {
    filesReviewed,
    issuesFound: issues.length,
    bySeverity: {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    },
    byCategory: {
      SECURITY: 0,
      QUALITY: 0,
      STYLE: 0,
      PERFORMANCE: 0,
      DOCUMENTATION: 0,
    },
  };

  for (const issue of issues) {
    summary.bySeverity[issue.severity]++;
    summary.byCategory[issue.category]++;
  }

  return summary;
}
