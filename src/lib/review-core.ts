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
 * Line range with context explanation
 */
export interface LineRange {
  start: number;
  end: number;
  reason: string;
}

/**
 * Enriched context for a single file
 */
export interface FileContext {
  filename: string;
  filePurpose: string;
  changeDescription: string;
  scopeContext: string;
  dependencies: string[];
  concerns: string[];
  relatedLineRanges: LineRange[];
}

/**
 * Diff analyzer output
 */
export interface DiffAnalysis {
  changeSummary: ChangeSummary;
  recommendedAgents: string[];
  fileContexts: FileContext[];
  overallConcerns: string[];
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

/**
 * Run the diff analyzer agent to get enriched context
 *
 * @param opencode - OpenCode client
 * @param config - DRS configuration
 * @param baseInstructions - Base instructions containing the diff
 * @param reviewLabel - Label for the review
 * @param filteredFiles - List of files to review
 * @param workingDir - Working directory for agent discovery
 * @param additionalContext - Additional context for the agent
 * @param debug - Whether to print debug information
 * @returns Parsed diff analysis or null if analysis fails
 */
export async function analyzeDiffContext(
  opencode: OpencodeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  workingDir: string,
  additionalContext: Record<string, any> = {},
  debug?: boolean
): Promise<DiffAnalysis | null> {
  console.log(chalk.gray('Analyzing diff context...\n'));

  try {
    // Get info about configured agents
    const agentInfo = getConfiguredAgentInfo(config, workingDir);
    const agentList = agentInfo.map((a) => `- **${a.name}**: ${a.description}`).join('\n');

    const analyzerPrompt = `${baseInstructions}

**Your Task**: Analyze the diff above and provide enriched context for the review agents.

## Available Review Agents

The following review agents are configured and available:

${agentList}

Your job is to analyze the diff and recommend which of these agents should review the changes based on what was modified.

Use the Read, Grep, and Bash tools as needed to gather complete context about:
- What each file does
- How the changes fit into the broader codebase
- Dependencies and related code
- Potential concerns for each type of review

Then output your analysis in the required JSON format. In the "recommendedAgents" field, only include agent names from the list above that are relevant to the changes.`;

    // Debug: Print diff analyzer input
    if (debug) {
      console.log(chalk.cyan('\n🔍 DEBUG: Diff Analyzer Input'));
      console.log(chalk.cyan('─'.repeat(80)));
      console.log(analyzerPrompt);
      console.log(chalk.cyan('─'.repeat(80) + '\n'));
    }

    const session = await opencode.createSession({
      agent: 'review/diff-analyzer',
      message: analyzerPrompt,
      context: {
        ...additionalContext,
        files: filteredFiles,
      },
    });

    let analysisJson = '';

    // Collect output from diff analyzer
    for await (const message of opencode.streamMessages(session.id)) {
      if (message.role === 'assistant') {
        const snippet = renderAgentMessage(message.content);
        if (snippet) {
          console.log(chalk.gray(`[diff-analyzer] ${snippet}\n`));
        }
        // Look for JSON in the message content
        const jsonMatch = message.content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          analysisJson = jsonMatch[1];
          break; // Exit early once we have the JSON
        }
      }
    }

    await opencode.closeSession(session.id);

    if (!analysisJson) {
      console.log(chalk.yellow('⚠️  Diff analyzer did not produce JSON output, skipping analysis'));
      return null;
    }

    // Debug: Print diff analyzer output
    if (debug) {
      console.log(chalk.cyan('\n🔍 DEBUG: Diff Analyzer Output (JSON)'));
      console.log(chalk.cyan('─'.repeat(80)));
      console.log(analysisJson);
      console.log(chalk.cyan('─'.repeat(80) + '\n'));
    }

    // Parse the JSON
    const analysis: DiffAnalysis = JSON.parse(analysisJson);

    console.log(chalk.green('✓ Diff analysis complete'));
    console.log(chalk.gray(`  Change type: ${analysis.changeSummary.type}`));
    console.log(chalk.gray(`  Complexity: ${analysis.changeSummary.complexity}`));
    console.log(chalk.gray(`  Risk level: ${analysis.changeSummary.riskLevel}`));
    console.log(chalk.gray(`  Recommended agents: ${analysis.recommendedAgents.join(', ')}\n`));

    return analysis;
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Diff analyzer failed: ${error}`));
    console.log(chalk.gray('Continuing with standard review process...\n'));
    return null;
  }
}

/**
 * Run all configured review agents in parallel
 *
 * This is the core agent execution logic shared between local and platform reviews.
 *
 * @param diffAnalysis - Optional diff analysis from analyzer agent
 * @param debug - Whether to print debug information
 */
export async function runReviewAgents(
  opencode: OpencodeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  additionalContext: Record<string, any> = {},
  diffAnalysis?: DiffAnalysis | null,
  workingDir: string = process.cwd(),
  debug?: boolean
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

  // Use recommended agents from analysis if available, otherwise use configured agents
  let agentNames = getAgentNames(config);
  if (diffAnalysis && diffAnalysis.recommendedAgents.length > 0) {
    // Filter configured agents to only run recommended ones
    const recommended = new Set(diffAnalysis.recommendedAgents);
    agentNames = agentNames.filter((name) => recommended.has(name));

    if (agentNames.length < getAgentNames(config).length) {
      const skipped = getAgentNames(config).filter((name) => !recommended.has(name));
      console.log(chalk.gray(`Skipping agents based on analysis: ${skipped.join(', ')}\n`));
    }
  }

  console.log(chalk.bold(`🎯 Selected Agents: ${agentNames.join(', ') || 'None'}\n`));
  const agentPromises = agentNames.map(async (agentType) => {
    const agentName = `review/${agentType}`;
    console.log(chalk.gray(`Running ${agentType} review...\n`));

    try {
      // Build prompt with global and agent-specific context
      let reviewPrompt = buildReviewPrompt(agentType, baseInstructions, reviewLabel, filteredFiles);

      // Add enriched context from diff analysis if available
      if (diffAnalysis) {
        reviewPrompt += `\n\n## Enriched Context from Diff Analysis\n\n`;
        reviewPrompt += `**Change Summary**: ${diffAnalysis.changeSummary.description}\n`;
        reviewPrompt += `**Change Type**: ${diffAnalysis.changeSummary.type}\n`;
        reviewPrompt += `**Complexity**: ${diffAnalysis.changeSummary.complexity}\n`;
        reviewPrompt += `**Risk Level**: ${diffAnalysis.changeSummary.riskLevel}\n`;

        if (diffAnalysis.changeSummary.subsystems.length > 0) {
          reviewPrompt += `**Affected Subsystems**: ${diffAnalysis.changeSummary.subsystems.join(', ')}\n`;
        }

        if (diffAnalysis.overallConcerns.length > 0) {
          reviewPrompt += `\n**Overall Concerns to Review**:\n`;
          diffAnalysis.overallConcerns.forEach((concern) => {
            reviewPrompt += `- ${concern}\n`;
          });
        }

        reviewPrompt += `\n### File-Specific Context\n\n`;
        diffAnalysis.fileContexts.forEach((fileCtx) => {
          reviewPrompt += `**${fileCtx.filename}**:\n`;
          reviewPrompt += `- Purpose: ${fileCtx.filePurpose}\n`;
          reviewPrompt += `- Change: ${fileCtx.changeDescription}\n`;
          reviewPrompt += `- Scope: ${fileCtx.scopeContext}\n`;

          if (fileCtx.dependencies.length > 0) {
            reviewPrompt += `- Dependencies: ${fileCtx.dependencies.join(', ')}\n`;
          }

          if (fileCtx.concerns.length > 0) {
            reviewPrompt += `- Focus Areas:\n`;
            fileCtx.concerns.forEach((concern) => {
              reviewPrompt += `  - ${concern}\n`;
            });
          }

          reviewPrompt += `\n`;
        });
      }

      const session = await opencode.createSession({
        agent: agentName,
        message: reviewPrompt,
        context: {
          ...additionalContext,
          files: filteredFiles,
          diffAnalysis: diffAnalysis || undefined,
        },
      });

      const agentIssues: ReviewIssue[] = [];

      // Collect results from this agent
      for await (const message of opencode.streamMessages(session.id)) {
        // Debug: Print agent messages
        if (debug) {
          console.log(chalk.cyan(`\n🔍 DEBUG: [${agentType}] Message from agent`));
          console.log(chalk.cyan('─'.repeat(80)));
          console.log(chalk.gray(`Role: ${message.role}`));
          console.log(chalk.gray(`Timestamp: ${message.timestamp.toISOString()}`));
          console.log(chalk.white(message.content));
          console.log(chalk.cyan('─'.repeat(80) + '\n'));
        }

        if (message.role === 'assistant') {
          const snippet = renderAgentMessage(message.content);
          if (snippet) {
            console.log(chalk.gray(`[${agentType}] ${snippet}\n`));
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
    changeSummary: diffAnalysis?.changeSummary,
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
