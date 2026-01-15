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
import type { ChangeSummary } from './change-summary.js';
import type { OpencodeClient } from '../opencode/client.js';
import { loadReviewAgents } from '../opencode/agent-loader.js';

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
  /** Diff-based change summary when available */
  changeSummary?: ChangeSummary;
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
      "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE" | "DOCUMENTATION",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": "Brief title",
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "Description of the problem",
      "solution": "How to fix it",
      "agent": "security" | "quality" | "style" | "performance" | "documentation"
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
      "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE" | "DOCUMENTATION",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": "Brief title",
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "Description of the problem",
      "solution": "How to fix it",
      "agent": "security" | "quality" | "style" | "performance" | "documentation"
    }
  ]
}
\`\`\`

Focus on the changes - only report issues for newly added or modified lines.`;
}

/**
 * Get information about configured review agents
 */
function getConfiguredAgentInfo(
  config: DRSConfig,
  workingDir: string
): Array<{ name: string; description: string }> {
  const configuredNames = getAgentNames(config);
  const allAgents = loadReviewAgents(workingDir);

  return configuredNames
    .map((name) => {
      const fullName = `review/${name}`;
      const agent = allAgents.find((a) => a.name === fullName);
      return {
        name,
        description: agent?.description || `${name} review agent`,
      };
    })
    .filter((a) => a !== null);
}

function renderAgentMessage(content: string, maxLines = 6, maxChars = 320): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return '';
  }

  const lines = trimmed.split('\n');
  const limitedLines = lines.slice(0, maxLines).join('\n');
  const limitedChars =
    limitedLines.length > maxChars ? `${limitedLines.slice(0, maxChars)}…` : limitedLines;
  return limitedChars;
}

export async function runReviewAgents(
  opencode: OpencodeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  additionalContext: Record<string, any> = {},
  workingDir: string = process.cwd(),
  debug = false
): Promise<AgentReviewResult> {
  console.log(chalk.gray('Starting code analysis...\n'));

  const configuredAgentInfo = getConfiguredAgentInfo(config, workingDir);
  if (configuredAgentInfo.length > 0) {
    console.log(chalk.bold('🧰 Available Review Agents'));
    configuredAgentInfo.forEach((agent) => {
      console.log(`  • ${chalk.cyan(agent.name)} - ${agent.description}`);
    });
    console.log('');
  }

  const agentNames = getAgentNames(config);
  console.log(chalk.bold(`🎯 Selected Agents: ${agentNames.join(', ') || 'None'}\n`));
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

      if (debug) {
        console.log(chalk.gray('┌── DEBUG: Message sent to review agent'));
        console.log(chalk.gray(`│ Agent: ${agentName}`));
        console.log(chalk.gray('│ Prompt:'));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(reviewPrompt);
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.gray(`└── End message for ${agentName}\n`));
      }

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
          if (debug) {
            console.log(chalk.gray(`┌── DEBUG: Full response from ${agentName}`));
            console.log(message.content);
            console.log(chalk.gray(`└── End response for ${agentName}\n`));
          } else {
            const snippet = renderAgentMessage(message.content);
            if (snippet) {
              console.log(chalk.gray(`[${agentType}] ${snippet}\n`));
            }
          }
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
  changeSummary?: ChangeSummary;
}): void {
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📊 Review Summary'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  if (result.changeSummary) {
    console.log(chalk.bold('🧭 Change Summary'));
    console.log(`  ${result.changeSummary.description}`);
    console.log(`  Type: ${result.changeSummary.type}`);
    console.log(`  Complexity: ${result.changeSummary.complexity}`);
    console.log(`  Risk level: ${result.changeSummary.riskLevel}`);
    if (result.changeSummary.subsystems.length > 0) {
      console.log(`  Subsystems: ${result.changeSummary.subsystems.join(', ')}`);
    }
    console.log('');
  }

  console.log(`  Files reviewed: ${chalk.cyan(result.summary.filesReviewed)}`);
  console.log(`  Issues found: ${chalk.yellow(result.summary.issuesFound)}`);

  if (result.summary.issuesFound > 0) {
    console.log(`    🔴 Critical: ${chalk.red(result.summary.bySeverity.CRITICAL)}`);
    console.log(`    🟡 High: ${chalk.yellow(result.summary.bySeverity.HIGH)}`);
    console.log(`    🟠 Medium: ${chalk.hex('#FFA500')(result.summary.bySeverity.MEDIUM)}`);
    console.log(`    ⚪ Low: ${chalk.gray(result.summary.bySeverity.LOW)}`);
    console.log('');
    console.log('  By category:');
    console.log(`    🔒 Security: ${chalk.cyan(result.summary.byCategory.SECURITY)}`);
    console.log(`    📊 Quality: ${chalk.cyan(result.summary.byCategory.QUALITY)}`);
    console.log(`    ✨ Style: ${chalk.cyan(result.summary.byCategory.STYLE)}`);
    console.log(`    ⚡ Performance: ${chalk.cyan(result.summary.byCategory.PERFORMANCE)}`);
    console.log(`    📝 Documentation: ${chalk.cyan(result.summary.byCategory.DOCUMENTATION)}`);
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
