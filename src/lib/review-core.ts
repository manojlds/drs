/**
 * Core review execution logic shared between local and platform reviews
 *
 * This module contains the common agent execution logic to avoid duplication
 * between review-orchestrator.ts (local) and unified-review-executor.ts (platform).
 */

import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import { getAgentNames } from './config.js';
import { buildReviewPrompt } from './context-loader.js';
import { parseReviewIssues } from './issue-parser.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import type { OpencodeClient } from '../opencode/client.js';

/**
 * File with optional diff content
 */
export interface FileWithDiff {
  /** File path */
  filename: string;
  /** Unified diff patch (if available from platform) */
  patch?: string;
}

/**
 * Result from running review agents
 */
export interface AgentReviewResult {
  /** All issues found by review agents */
  issues: ReviewIssue[];
  /** Calculated summary statistics */
  summary: ReturnType<typeof calculateSummary>;
  /** Number of files actually reviewed */
  filesReviewed: number;
  /** Agent execution results */
  agentResults: AgentResult[];
}

export interface AgentResult {
  agentType: string;
  success: boolean;
  issues: ReviewIssue[];
}

/**
 * Build base review instructions for agents
 *
 * @param label - Human-readable label for the review (e.g., "PR/MR #123", "Local staged diff")
 * @param files - List of files with optional diff content
 * @param diffCommand - Fallback git diff command hint (used when diff not provided)
 */
export function buildBaseInstructions(
  label: string,
  files: FileWithDiff[],
  diffCommand?: string
): string {
  // Check if we have actual diff content
  const filesWithDiffs = files.filter((f) => f.patch);
  const hasDiffs = filesWithDiffs.length > 0;

  const fileList = files.map((f) => `- ${f.filename}`).join('\n');

  if (hasDiffs) {
    // We have diff content from the platform - include it directly
    const diffContent = filesWithDiffs
      .map((f) => `### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``)
      .join('\n\n');

    return `Review the following changed files from ${label}:

${fileList}

## Diff Content

The following shows exactly what changed in this PR/MR:

${diffContent}

**Instructions:**
1. Analyze the diff content above to understand what lines were changed
2. Use the Read tool to examine the full file for additional context if needed
3. **IMPORTANT: Only report issues on lines that were actually changed or added (lines starting with + in the diff).** Do not report issues on unchanged code.
4. Analyze the changed code for issues in your specialty area
5. Output your findings in this JSON format:

\`\`\`json
{
  "issues": [
    {
      "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": "Brief title",
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "Description of the problem",
      "solution": "How to fix it",
      "agent": "security" | "quality" | "style" | "performance"
    }
  ]
}
\`\`\`

Focus on the changes - only report issues for newly added or modified lines (lines with + prefix in the diff).`;
  }

  // No diff content available - fall back to git diff command
  const fallbackCommand = diffCommand || 'git diff HEAD~1 -- <file>';

  return `Review the following changed files from ${label}:

${fileList}

**Instructions:**
1. First, use the Bash tool to run \`${fallbackCommand}\` to see what lines were actually changed
2. Use the Read tool to examine the full file for context
3. **IMPORTANT: Only report issues on lines that were actually changed or added.** Do not report issues on existing code that was not modified.
4. Analyze the changed code for issues in your specialty area
5. Output your findings in this JSON format:

\`\`\`json
{
  "issues": [
    {
      "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": "Brief title",
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "Description of the problem",
      "solution": "How to fix it",
      "agent": "security" | "quality" | "style" | "performance"
    }
  ]
}
\`\`\`

Focus on the changes - only report issues for newly added or modified lines.`;
}

/**
 * Run all configured review agents in parallel
 *
 * This is the core agent execution logic shared between local and platform reviews.
 */
export async function runReviewAgents(
  opencode: OpencodeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  additionalContext: Record<string, any> = {}
): Promise<AgentReviewResult> {
  console.log(chalk.gray('Starting code analysis...\n'));

  const agentNames = getAgentNames(config);
  const agentPromises = agentNames.map(async (agentType) => {
    const agentName = `review/${agentType}`;
    console.log(chalk.gray(`Running ${agentType} review...\n`));

    try {
      // Build prompt with global and agent-specific context
      const reviewPrompt = buildReviewPrompt(
        agentType,
        baseInstructions,
        reviewLabel,
        filteredFiles
      );

      const session = await opencode.createSession({
        agent: agentName,
        message: reviewPrompt,
        context: {
          ...additionalContext,
          files: filteredFiles,
        },
      });

      const agentIssues: ReviewIssue[] = [];

      // Collect results from this agent
      for await (const message of opencode.streamMessages(session.id)) {
        if (message.role === 'assistant') {
          const parsedIssues = parseReviewIssues(message.content);
          if (parsedIssues.length > 0) {
            agentIssues.push(...parsedIssues);
            console.log(chalk.green(`✓ [${agentType}] Found ${parsedIssues.length} issue(s)`));
          }
        }
      }

      await opencode.closeSession(session.id);
      return { agentType, success: true, issues: agentIssues };
    } catch (error) {
      console.error(chalk.red(`✗ ${agentType} agent failed: ${error}`));
      return { agentType, success: false, issues: [] };
    }
  });

  // Wait for all agents to complete
  const agentResults = await Promise.all(agentPromises);

  // Check agent results
  const successfulAgents = agentResults.filter((r) => r.success);
  const failedAgents = agentResults.filter((r) => !r.success);

  if (successfulAgents.length === 0) {
    console.error(chalk.red('\n✗ All review agents failed!\n'));
    console.error(
      chalk.yellow(
        'This usually means:\n' +
          '  1. Model configuration is incorrect or missing\n' +
          '  2. API credentials are invalid or missing\n' +
          '  3. Models are not accessible or timed out\n' +
          '  4. Agents cannot find files to review\n'
      )
    );
    throw new Error('All review agents failed');
  }

  if (failedAgents.length > 0) {
    console.log(
      chalk.yellow(
        `\n⚠️  ${failedAgents.length} of ${agentResults.length} agents failed: ${failedAgents.map((r) => r.agentType).join(', ')}\n`
      )
    );
  }

  // Flatten all issues from successful agents
  const issues: ReviewIssue[] = [];
  agentResults.forEach((result) => issues.push(...result.issues));

  const summary = calculateSummary(filteredFiles.length, issues);

  return {
    issues,
    summary,
    filesReviewed: filteredFiles.length,
    agentResults,
  };
}

/**
 * Display review summary to terminal
 */
export function displayReviewSummary(result: {
  issues: ReviewIssue[];
  summary: ReturnType<typeof calculateSummary>;
  filesReviewed: number;
}): void {
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📊 Review Summary'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(`  Files reviewed: ${chalk.cyan(result.summary.filesReviewed)}`);
  console.log(`  Issues found: ${chalk.yellow(result.summary.issuesFound)}`);

  if (result.summary.issuesFound > 0) {
    console.log(`    🔴 Critical: ${chalk.red(result.summary.bySeverity.CRITICAL)}`);
    console.log(`    🟡 High: ${chalk.yellow(result.summary.bySeverity.HIGH)}`);
    console.log(`    🟠 Medium: ${chalk.hex('#FFA500')(result.summary.bySeverity.MEDIUM)}`);
    console.log(`    ⚪ Low: ${chalk.gray(result.summary.bySeverity.LOW)}`);
  }

  console.log('');
}

/**
 * Check if review has blocking issues (CRITICAL or HIGH)
 */
export function hasBlockingIssues(result: {
  summary: ReturnType<typeof calculateSummary>;
}): boolean {
  return result.summary.bySeverity.CRITICAL > 0 || result.summary.bySeverity.HIGH > 0;
}
