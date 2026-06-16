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
import { buildCursorFixLink, type CursorFixLinkOptions } from './cursor-fix-link.js';
import { formatCost, formatCount } from './format-utils.js';
import type { ReviewUsageSummary } from './review-usage.js';

export interface ReviewSummary {
  filesReviewed: number;
  issuesFound: number;
  bySeverity: Record<IssueSeverity, number>;
  byCategory: Record<IssueCategory, number>;
}

export interface ReviewMetadata {
  headSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
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

function cleanMetadataValue(value?: string): string | undefined {
  const cleaned = value?.trim().replace(/[\r\n]+/g, ' ');
  return cleaned ? cleaned : undefined;
}

function formatShortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function escapeHtmlCommentValue(value: string): string {
  return value.replace(/--/g, '- -');
}

function formatMarkdownCodeSpan(value: string): string {
  const backtickRuns = value.match(/`+/g) ?? [];
  const delimiterLength = Math.max(1, ...backtickRuns.map((run) => run.length + 1));
  const delimiter = '`'.repeat(delimiterLength);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function formatReviewMetadataSection(metadata: ReviewMetadata): string {
  const headSha = cleanMetadataValue(metadata.headSha);
  const sourceBranch = cleanMetadataValue(metadata.sourceBranch);
  const targetBranch = cleanMetadataValue(metadata.targetBranch);
  const lines: string[] = [];

  if (headSha) {
    lines.push(
      `- **Reviewed Commit**: ${formatMarkdownCodeSpan(formatShortSha(escapeHtmlCommentValue(headSha)))}`
    );
  }

  if (sourceBranch && targetBranch) {
    lines.push(
      `- **Branch**: ${formatMarkdownCodeSpan(sourceBranch)} -> ${formatMarkdownCodeSpan(targetBranch)}`
    );
  }

  if (lines.length === 0) {
    return '';
  }

  return `## 🔎 Review Context\n\n${lines.join('\n')}\n\n`;
}

function formatReviewUsageSection(usage: ReviewUsageSummary): string {
  const total = usage.total;

  let markdown = `## 💰 Model Usage\n\n`;
  markdown += `<details>\n<summary>View token and cost breakdown</summary>\n\n`;
  markdown += `### Run Totals\n\n`;
  markdown += `- **Input Tokens**: ${formatCount(total.input)}\n`;
  markdown += `- **Output Tokens**: ${formatCount(total.output)}\n`;
  markdown += `- **Cache Read Tokens**: ${formatCount(total.cacheRead)}\n`;
  markdown += `- **Cache Write Tokens**: ${formatCount(total.cacheWrite)}\n`;
  markdown += `- **Total Tokens**: ${formatCount(total.totalTokens)}\n`;
  markdown += `- **Estimated Cost**: ${formatCost(total.cost)}\n`;
  if (total.totalTokens > 0 && total.cost === 0) {
    markdown +=
      '- _Cost is $0.0000 because model pricing is unknown or configured as free. Add `pricing.models` in `.drs/drs.config.yaml` to override._\n';
  }
  markdown += `\n`;

  if (usage.agents.length > 0) {
    markdown += `### By Agent\n\n`;
    markdown += `| Agent | Model | Turns | Input | Output | Cache Read | Cache Write | Total Tokens | Cost | Status |\n`;
    markdown += `| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n`;

    for (const agent of usage.agents) {
      markdown += `| ${agent.agentType} | ${agent.model ?? 'n/a'} | ${formatCount(agent.turns)} | ${formatCount(agent.usage.input)} | ${formatCount(agent.usage.output)} | ${formatCount(agent.usage.cacheRead)} | ${formatCount(agent.usage.cacheWrite)} | ${formatCount(agent.usage.totalTokens)} | ${formatCost(agent.usage.cost)} | ${agent.success === false ? 'failed' : 'ok'} |\n`;
    }

    markdown += `\n`;
  }

  markdown += `</details>\n\n`;

  return markdown;
}

/**
 * Format a single review issue as a PR/MR comment.
 * @param issue The review issue to format.
 * @param fingerprint Optional fingerprint to embed for deduplication.
 * @param cursorFixLinks Optional Cursor link settings. When enabled, a Fix in Cursor link is appended.
 */
export function formatIssueComment(
  issue: ReviewIssue,
  fingerprint?: string,
  cursorFixLinks?: CursorFixLinkOptions
): string {
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

  const cursorFixLink = buildCursorFixLink(issue, cursorFixLinks);
  if (cursorFixLink) {
    comment += `\n[Fix in Cursor](${cursorFixLink})\n`;
  }

  if (issue.references && issue.references.length > 0) {
    comment += `\n### References\n`;
    for (const ref of issue.references) {
      comment += `- ${ref}\n`;
    }
  }

  return comment;
}

/**
 * Format a review summary as a PR/MR comment.
 * @param summary Aggregated review statistics.
 * @param issues Review issues to include in the summary details.
 * @param commentId Optional comment ID to embed for update identification.
 * @param changeSummary Optional change summary to include before review statistics.
 * @param reviewUsage Optional usage summary to include for cost reporting.
 * @param cursorFixLinks Optional Cursor link settings. When enabled, per-issue links are appended.
 * @param reviewMetadata Optional PR/MR metadata for identifying the reviewed commit.
 */
export function formatSummaryComment(
  summary: ReviewSummary,
  issues: ReviewIssue[],
  commentId?: string,
  changeSummary?: ChangeSummary,
  reviewUsage?: ReviewUsageSummary,
  cursorFixLinks?: CursorFixLinkOptions,
  reviewMetadata?: ReviewMetadata
): string {
  // Add hidden identifier for update-or-create logic
  let comment = '';
  if (commentId) {
    comment += `<!-- drs-comment-id: ${commentId} -->\n`;
  }
  const headSha = cleanMetadataValue(reviewMetadata?.headSha);
  if (headSha) {
    comment += `<!-- drs-reviewed-head-sha: ${escapeHtmlCommentValue(headSha)} -->\n`;
  }

  comment += `# 📋 Code Review Analysis\n\n`;

  if (reviewMetadata) {
    comment += formatReviewMetadataSection(reviewMetadata);
  }

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

  if (reviewUsage) {
    comment += formatReviewUsageSection(reviewUsage);
  }

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
      const cursorFixLink = buildCursorFixLink(issue, cursorFixLinks);
      if (cursorFixLink) {
        details += `\n[Fix in Cursor](${cursorFixLink})\n`;
      }
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
