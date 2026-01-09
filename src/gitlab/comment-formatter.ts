export type IssueSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type IssueCategory = 'SECURITY' | 'QUALITY' | 'STYLE' | 'PERFORMANCE';

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
};

/**
 * Format a single review issue as a GitLab comment
 */
export function formatIssueComment(issue: ReviewIssue): string {
  const emoji = CATEGORY_EMOJI[issue.category];
  const severityEmoji = SEVERITY_EMOJI[issue.severity];

  let comment = `## ${emoji} ${issue.category} - ${issue.title}\n\n`;
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
 */
export function formatSummaryComment(summary: ReviewSummary, issues: ReviewIssue[]): string {
  let comment = `# 📋 Code Review Analysis\n\n`;

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
    comment += `- ${CATEGORY_EMOJI.PERFORMANCE} **Performance**: ${summary.byCategory.PERFORMANCE}\n\n`;

    // List critical and high issues
    const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
    const highIssues = issues.filter(i => i.severity === 'HIGH');

    if (criticalIssues.length > 0) {
      comment += `## 🔴 Critical Issues\n\n`;
      for (const issue of criticalIssues) {
        comment += `- **${issue.title}** in \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`\n`;
      }
      comment += `\n`;
    }

    if (highIssues.length > 0) {
      comment += `## 🟡 High Priority Issues\n\n`;
      for (const issue of highIssues) {
        comment += `- **${issue.title}** in \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`\n`;
      }
      comment += `\n`;
    }

    comment += `\n---\n`;
    comment += `*Detailed findings have been posted as individual discussion threads on the affected lines.*\n`;
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
 * Calculate review summary from issues
 */
export function calculateSummary(
  filesReviewed: number,
  issues: ReviewIssue[]
): ReviewSummary {
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
    },
  };

  for (const issue of issues) {
    summary.bySeverity[issue.severity]++;
    summary.byCategory[issue.category]++;
  }

  return summary;
}
