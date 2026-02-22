/**
 * Core review execution logic shared between local and platform reviews
 *
 * This module contains the common agent execution logic to avoid duplication
 * between review-orchestrator.ts (local) and unified-review-executor.ts (platform).
 */

import chalk from 'chalk';
import type { DRSConfig, ReviewMode, ReviewSeverity } from './config.js';
import { getAgentNames } from './config.js';
import { buildReviewPrompt } from './context-loader.js';
import { parseReviewIssues } from './issue-parser.js';
import { parseReviewOutput } from './review-parser.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import type { ChangeSummary } from './change-summary.js';
import type { RuntimeClient } from '../opencode/client.js';
import { loadReviewAgents } from '../opencode/agent-loader.js';
import { createIssueFingerprint } from './comment-manager.js';
import { getLogger } from './logger.js';
import {
  aggregateAgentUsage,
  applyUsageMessage,
  createAgentUsageSummary,
  type AgentUsageSummary,
  type ReviewUsageSummary,
} from './review-usage.js';

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
  /** Token usage and cost details for the review run */
  usage?: ReviewUsageSummary;
}

export interface AgentResult {
  agentType: string;
  success: boolean;
  issues: ReviewIssue[];
  usage?: AgentUsageSummary;
}

const REVIEW_SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

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
  diffCommand?: string,
  compressionSummary?: string
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

${compressionSummary ? `${compressionSummary}\n\n` : ''}Output requirements:
- You MUST call the write_json_output tool with:
  - outputType: "review_output"
  - payload: the JSON object
  - After calling the tool, return only the JSON pointer returned by the tool
    (e.g. {"outputType":"review_output","outputPath":".drs/review-output.json"})
- Do not return raw JSON directly.
- Do not include markdown, code fences, or extra text.
- Follow this exact schema:
{
  "timestamp": "ISO-8601 timestamp or descriptive string",
  "summary": {
    "filesReviewed": ${files.length},
    "issuesFound": 0,
    "bySeverity": {
      "CRITICAL": 0,
      "HIGH": 0,
      "MEDIUM": 0,
      "LOW": 0
    },
    "byCategory": {
      "SECURITY": 0,
      "QUALITY": 0,
      "STYLE": 0,
      "PERFORMANCE": 0,
      "DOCUMENTATION": 0
    }
  },
  "issues": [
    {
      "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE" | "DOCUMENTATION",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": "Brief title",
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "Description of the problem",
      "solution": "How to fix it",
      "references": ["https://link1", "https://link2"],
      "agent": "security" | "quality" | "style" | "performance" | "documentation" | "unified"
    }
  ]
}

**Instructions:**
1. Analyze the diff content above to understand what lines were changed
2. Use the Read tool to examine the full file for additional context if needed
3. **IMPORTANT: Only report issues on lines that were actually changed or added (lines starting with + in the diff).** Do not report issues on unchanged code.
4. Analyze the changed code for issues in your specialty area
5. Populate summary counts based on the issues you report (use 0 when none).
6. Focus on the changes - only report issues for newly added or modified lines (lines with + prefix in the diff).`;
  }

  // No diff content available - fall back to git diff command
  const fallbackCommand = diffCommand ?? 'git diff HEAD~1 -- <file>';

  return `Review the following changed files from ${label}:

${fileList}

Output requirements:
- You MUST call the write_json_output tool with:
  - outputType: "review_output"
  - payload: the JSON object
  - After calling the tool, return only the JSON pointer returned by the tool
    (e.g. {"outputType":"review_output","outputPath":".drs/review-output.json"})
- Do not return raw JSON directly.
- Do not include markdown, code fences, or extra text.
- Follow this exact schema:
{
  "timestamp": "ISO-8601 timestamp or descriptive string",
  "summary": {
    "filesReviewed": ${files.length},
    "issuesFound": 0,
    "bySeverity": {
      "CRITICAL": 0,
      "HIGH": 0,
      "MEDIUM": 0,
      "LOW": 0
    },
    "byCategory": {
      "SECURITY": 0,
      "QUALITY": 0,
      "STYLE": 0,
      "PERFORMANCE": 0,
      "DOCUMENTATION": 0
    }
  },
  "issues": [
    {
      "category": "SECURITY" | "QUALITY" | "STYLE" | "PERFORMANCE" | "DOCUMENTATION",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "title": "Brief title",
      "file": "path/to/file.ts",
      "line": 42,
      "problem": "Description of the problem",
      "solution": "How to fix it",
      "references": ["https://link1", "https://link2"],
      "agent": "security" | "quality" | "style" | "performance" | "documentation" | "unified"
    }
  ]
}

**Instructions:**
1. First, use the Bash tool to run \`${fallbackCommand}\` to see what lines were actually changed
2. Use the Read tool to examine the full file for context
3. **IMPORTANT: Only report issues on lines that were actually changed or added.** Do not report issues on existing code that was not modified.
4. Analyze the changed code for issues in your specialty area
5. Populate summary counts based on the issues you report (use 0 when none).
6. Focus on the changes - only report issues for newly added or modified lines.`;
}

/**
 * Get information about configured review agents
 */
function getConfiguredAgentInfo(
  config: DRSConfig,
  workingDir: string
): Array<{ name: string; description: string }> {
  const configuredNames = getAgentNames(config);
  const allAgents = loadReviewAgents(workingDir, config);

  return configuredNames
    .map((name) => {
      const fullName = `review/${name}`;
      const agent = allAgents.find((a) => a.name === fullName);
      return {
        name,
        description: agent?.description ?? `${name} review agent`,
      };
    })
    .filter((a) => a !== null);
}

function validateConfiguredReviewAgents(config: DRSConfig, workingDir: string): void {
  const configuredNames = getAgentNames(config);
  const availableAgents = new Set(
    loadReviewAgents(workingDir, config)
      .filter((agent) => agent.name.startsWith('review/'))
      .map((agent) => agent.name.replace(/^review\//, ''))
  );

  const missingAgents = configuredNames.filter((name) => !availableAgents.has(name));
  if (missingAgents.length === 0) {
    return;
  }

  const availableList = Array.from(availableAgents).sort();
  throw new Error(
    `Unknown review agent(s) configured: ${missingAgents.join(', ')}. Available agents: ${availableList.join(', ')}`
  );
}

function resolveReviewMode(config: DRSConfig): ReviewMode {
  return config.review.mode ?? 'multi-agent';
}

function shouldEscalateHybrid(issues: ReviewIssue[], threshold: ReviewSeverity): boolean {
  return issues.some(
    (issue) => REVIEW_SEVERITY_ORDER[issue.severity] >= REVIEW_SEVERITY_ORDER[threshold]
  );
}

function mergeIssues(primary: ReviewIssue[], secondary: ReviewIssue[]): ReviewIssue[] {
  const seen = new Set<string>();
  const merged: ReviewIssue[] = [];

  for (const issue of [...primary, ...secondary]) {
    const fingerprint = createIssueFingerprint(issue);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    merged.push(issue);
  }

  return merged;
}

function summarizeRunUsage(agentResults: AgentResult[]): ReviewUsageSummary {
  const agentUsage = agentResults
    .map((result) => {
      const usage = result.usage ?? createAgentUsageSummary(result.agentType);
      return {
        ...usage,
        success: result.success,
      };
    })
    .sort((a, b) => a.agentType.localeCompare(b.agentType));

  return aggregateAgentUsage(agentUsage);
}

export async function runUnifiedReviewAgent(
  opencode: RuntimeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  additionalContext: Record<string, unknown> = {},
  workingDir: string = process.cwd(),
  debug = false
): Promise<AgentReviewResult> {
  const agentType = 'unified-reviewer';
  const agentName = `review/${agentType}`;

  console.log(chalk.bold('🎯 Selected Agents: unified-reviewer\n'));
  console.log(chalk.gray('Running unified review...\n'));

  let agentUsage = createAgentUsageSummary(agentType);

  try {
    const reviewPrompt = buildReviewPrompt(
      agentType,
      baseInstructions,
      reviewLabel,
      filteredFiles,
      workingDir,
      config
    );

    const logger = getLogger();

    if (debug) {
      console.log(chalk.gray('┌── DEBUG: Message sent to review agent'));
      console.log(chalk.gray(`│ Agent: ${agentName}`));
      console.log(chalk.gray('│ Prompt:'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log(reviewPrompt);
      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.gray(`└── End message for ${agentName}\n`));
    } else {
      logger.agentInput(agentType, reviewPrompt);
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
    let fullResponse = '';

    for await (const message of opencode.streamMessages(session.id)) {
      if (message.role === 'tool') {
        logger.toolOutput(message.toolName ?? 'unknown', agentType, message.content);
        continue;
      }

      if (message.role === 'assistant') {
        agentUsage = applyUsageMessage(agentUsage, message);

        if (!message.content.trim()) {
          continue;
        }
        fullResponse += message.content;
        if (debug) {
          console.log(chalk.gray(`┌── DEBUG: Full response from ${agentName}`));
          console.log(message.content);
          console.log(chalk.gray(`└── End response for ${agentName}\n`));
        } else {
          logger.agentMessage(agentType, message.content);
        }
      }
    }

    await opencode.closeSession(session.id);

    try {
      const reviewOutput = await parseReviewOutput(workingDir, debug, fullResponse);
      const parsedIssues = parseReviewIssues(JSON.stringify(reviewOutput), 'unified');
      if (parsedIssues.length > 0) {
        agentIssues.push(...parsedIssues);
        console.log(chalk.green(`✓ [unified] Found ${parsedIssues.length} issue(s)`));
      }
    } catch (parseError) {
      console.error(chalk.red('Failed to parse unified review output'));
      if (debug) {
        console.log(chalk.dim('Unified agent output:'), fullResponse);
      }
      const reason = parseError instanceof Error ? `: ${parseError.message}` : '';
      throw new Error(`Unified review agent did not return valid JSON output${reason}`);
    }

    const summary = calculateSummary(filteredFiles.length, agentIssues);
    const agentResults: AgentResult[] = [
      {
        agentType,
        success: true,
        issues: agentIssues,
        usage: {
          ...agentUsage,
          success: true,
        },
      },
    ];

    return {
      issues: agentIssues,
      summary,
      filesReviewed: filteredFiles.length,
      agentResults,
      usage: summarizeRunUsage(agentResults),
    };
  } catch (error) {
    console.error(chalk.red(`✗ unified-reviewer agent failed: ${error}`));
    const agentResults: AgentResult[] = [
      {
        agentType,
        success: false,
        issues: [],
        usage: {
          ...agentUsage,
          success: false,
        },
      },
    ];

    return {
      issues: [],
      summary: calculateSummary(filteredFiles.length, []),
      filesReviewed: filteredFiles.length,
      agentResults,
      usage: summarizeRunUsage(agentResults),
    };
  }
}

export async function runReviewAgents(
  opencode: RuntimeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  additionalContext: Record<string, unknown> = {},
  workingDir: string = process.cwd(),
  debug = false
): Promise<AgentReviewResult> {
  console.log(chalk.gray('Starting code analysis...\n'));

  validateConfiguredReviewAgents(config, workingDir);

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
  const agentResults: AgentResult[] = [];

  for (const agentType of agentNames) {
    const agentName = `review/${agentType}`;
    console.log(chalk.gray(`Running ${agentType} review...\n`));
    let agentUsage = createAgentUsageSummary(agentType);

    try {
      // Build prompt with global and agent-specific context
      const reviewPrompt = buildReviewPrompt(
        agentType,
        baseInstructions,
        reviewLabel,
        filteredFiles,
        workingDir,
        config
      );

      const logger = getLogger();

      if (debug) {
        console.log(chalk.gray('┌── DEBUG: Message sent to review agent'));
        console.log(chalk.gray(`│ Agent: ${agentName}`));
        console.log(chalk.gray('│ Prompt:'));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(reviewPrompt);
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.gray(`└── End message for ${agentName}\n`));
      } else {
        logger.agentInput(agentType, reviewPrompt);
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
      let fullResponse = '';

      // Collect results from this agent
      for await (const message of opencode.streamMessages(session.id)) {
        if (message.role === 'tool') {
          logger.toolOutput(message.toolName ?? 'unknown', agentType, message.content);
          continue;
        }

        if (message.role === 'assistant') {
          agentUsage = applyUsageMessage(agentUsage, message);

          if (!message.content.trim()) {
            continue;
          }
          fullResponse += message.content;
          if (debug) {
            console.log(chalk.gray(`┌── DEBUG: Full response from ${agentName}`));
            console.log(message.content);
            console.log(chalk.gray(`└── End response for ${agentName}\n`));
          } else {
            logger.agentMessage(agentType, message.content);
          }
        }
      }

      await opencode.closeSession(session.id);

      const reviewOutput = await parseReviewOutput(workingDir, debug, fullResponse);
      const parsedIssues = parseReviewIssues(JSON.stringify(reviewOutput), agentType);
      if (parsedIssues.length > 0) {
        agentIssues.push(...parsedIssues);
        console.log(chalk.green(`✓ [${agentType}] Found ${parsedIssues.length} issue(s)`));
      }
      agentResults.push({
        agentType,
        success: true,
        issues: agentIssues,
        usage: {
          ...agentUsage,
          success: true,
        },
      });
    } catch (error) {
      console.error(chalk.red(`✗ ${agentType} agent failed: ${error}`));
      agentResults.push({
        agentType,
        success: false,
        issues: [],
        usage: {
          ...agentUsage,
          success: false,
        },
      });
    }
  }

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
    usage: summarizeRunUsage(agentResults),
  };
}

export async function runReviewPipeline(
  opencode: RuntimeClient,
  config: DRSConfig,
  baseInstructions: string,
  reviewLabel: string,
  filteredFiles: string[],
  additionalContext: Record<string, unknown> = {},
  workingDir: string = process.cwd(),
  debug = false
): Promise<AgentReviewResult> {
  const mode = resolveReviewMode(config);

  if (mode === 'unified') {
    return runUnifiedReviewAgent(
      opencode,
      config,
      baseInstructions,
      reviewLabel,
      filteredFiles,
      additionalContext,
      workingDir,
      debug
    );
  }

  if (mode === 'multi-agent') {
    return runReviewAgents(
      opencode,
      config,
      baseInstructions,
      reviewLabel,
      filteredFiles,
      additionalContext,
      workingDir,
      debug
    );
  }

  const unifiedResult = await runUnifiedReviewAgent(
    opencode,
    config,
    baseInstructions,
    reviewLabel,
    filteredFiles,
    additionalContext,
    workingDir,
    debug
  );

  const unifiedSuccess = unifiedResult.agentResults.every((result) => result.success);
  const threshold = config.review.unified?.severityThreshold ?? 'HIGH';
  const shouldEscalate = unifiedSuccess
    ? shouldEscalateHybrid(unifiedResult.issues, threshold)
    : true;

  if (!shouldEscalate) {
    console.log(
      chalk.gray(`Hybrid mode: no issues at or above ${threshold}, skipping deep review.\n`)
    );
    return unifiedResult;
  }

  if (!unifiedSuccess) {
    console.log(chalk.yellow('Hybrid mode: unified review failed, falling back to deep review.\n'));
  } else {
    console.log(chalk.yellow('Hybrid mode: escalating to deep review agents.\n'));
  }

  const deepResult = await runReviewAgents(
    opencode,
    config,
    baseInstructions,
    reviewLabel,
    filteredFiles,
    additionalContext,
    workingDir,
    debug
  );

  const mergedIssues = mergeIssues(unifiedResult.issues, deepResult.issues);
  const summary = calculateSummary(filteredFiles.length, mergedIssues);

  const combinedAgentResults = [...unifiedResult.agentResults, ...deepResult.agentResults];

  return {
    issues: mergedIssues,
    summary,
    filesReviewed: filteredFiles.length,
    agentResults: combinedAgentResults,
    usage: summarizeRunUsage(combinedAgentResults),
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
  usage?: ReviewUsageSummary;
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

  if (result.usage) {
    console.log(
      `  Tokens (input/output): ${chalk.cyan(`${result.usage.total.input}/${result.usage.total.output}`)}`
    );
    console.log(`  Total tokens: ${chalk.cyan(result.usage.total.totalTokens)}`);
    console.log(`  Estimated cost: ${chalk.cyan(`$${result.usage.total.cost.toFixed(4)}`)}`);
    if (result.usage.total.totalTokens > 0 && result.usage.total.cost === 0) {
      console.log(
        chalk.gray(
          '  Cost is $0.0000 because model pricing is unknown or configured as free. Configure pricing.models to override.'
        )
      );
    }
  }

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
