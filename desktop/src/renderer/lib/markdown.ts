import { CATEGORY_EMOJI, SEVERITY_EMOJI } from './badges';
import type { ReviewJsonOutput, ReviewIssue } from '../types';

/**
 * Render a DRS review as Markdown for "Copy as Markdown".
 *
 * This is a compact, self-contained formatter that mirrors the spirit of DRS's
 * `formatSummaryComment` (from `src/lib/comment-formatter.ts`) without a hard
 * dependency on the DRS package — the desktop renderer runs in the browser and
 * cannot import the Node-based formatter directly.
 */
export function buildReviewMarkdown(review: ReviewJsonOutput): string {
  const { summary, issues } = review;
  const lines: string[] = [];

  lines.push('# 🤖 DRS Review');
  lines.push('');
  lines.push(
    `**Files reviewed:** ${summary.filesReviewed} · **Issues found:** ${summary.issuesFound}`,
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `- ${SEVERITY_EMOJI.CRITICAL} Critical: ${summary.bySeverity.CRITICAL}`,
  );
  lines.push(`- ${SEVERITY_EMOJI.HIGH} High: ${summary.bySeverity.HIGH}`);
  lines.push(`- ${SEVERITY_EMOJI.MEDIUM} Medium: ${summary.bySeverity.MEDIUM}`);
  lines.push(`- ${SEVERITY_EMOJI.LOW} Low: ${summary.bySeverity.LOW}`);
  lines.push('');

  const byCategory = summary.byCategory;
  const categoryParts = Object.entries(byCategory)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${CATEGORY_EMOJI[category as keyof typeof CATEGORY_EMOJI]} ${category}: ${count}`);
  if (categoryParts.length > 0) {
    lines.push(`**By category:** ${categoryParts.join(' · ')}`);
    lines.push('');
  }

  if (issues.length === 0) {
    lines.push('_No issues found._');
    return lines.join('\n');
  }

  lines.push('## Issues');
  lines.push('');

  for (const issue of issues) {
    lines.push(...formatIssueSection(issue));
  }

  return lines.join('\n');
}

function formatIssueSection(issue: ReviewIssue): string[] {
  const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  const heading = `${SEVERITY_EMOJI[issue.severity]} [${issue.severity}] ${issue.title}`;
  return [
    `### ${heading}`,
    '',
    `**File:** \`${location}\`  ·  **Category:** ${CATEGORY_EMOJI[issue.category]} ${issue.category}  ·  **Agent:** \`${issue.agent}\``,
    '',
    `**Problem:** ${issue.problem}`,
    '',
    `**Solution:** ${issue.solution}`,
    issue.references && issue.references.length > 0
      ? `\n**References:**\n${issue.references.map((ref) => `- ${ref}`).join('\n')}\n`
      : '',
  ];
}

/** Copy text to the clipboard, preferring the Electron clipboard path. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for contexts without the async clipboard API.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}
