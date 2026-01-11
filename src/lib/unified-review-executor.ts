/**
 * Unified review executor for GitHub and GitLab
 *
 * This module provides a platform-agnostic way to execute code reviews
 * by using the PlatformClient interface.
 */

import chalk from 'chalk';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { DRSConfig } from './config.js';
import { getAgentNames } from './config.js';
import { buildReviewPrompt } from './context-loader.js';
import { parseReviewIssues } from './issue-parser.js';
import {
  formatSummaryComment,
  formatIssueComment,
  calculateSummary,
  type ReviewIssue,
} from './comment-formatter.js';
import {
  BOT_COMMENT_ID,
  createIssueFingerprint,
  findExistingSummaryComment,
  prepareIssuesForPosting,
  type PlatformComment,
} from './comment-manager.js';
import {
  connectToOpenCode,
  displayReviewSummary,
  filterIgnoredFiles,
} from './review-orchestrator.js';
import type { PlatformClient, LineValidator, InlineCommentPosition } from './platform-client.js';
import { generateCodeQualityReport, formatCodeQualityReport } from './code-quality-report.js';

export interface UnifiedReviewOptions {
  /** Platform client (GitHub or GitLab adapter) */
  platformClient: PlatformClient;
  /** Project ID (e.g., "owner/repo" for GitHub, project ID for GitLab) */
  projectId: string;
  /** PR/MR number */
  prNumber: number;
  /** Whether to post comments to the platform */
  postComments: boolean;
  /** Optional path to output GitLab code quality report JSON */
  codeQualityReport?: string;
  /** Optional line validator for checking which lines can be commented */
  lineValidator?: LineValidator;
  /** Optional function to create inline comment position data */
  createInlinePosition?: (issue: ReviewIssue, platformData: any) => InlineCommentPosition;
  /** Working directory for file access */
  workingDir?: string;
}

/**
 * Execute a unified code review for any platform
 */
export async function executeUnifiedReview(
  config: DRSConfig,
  options: UnifiedReviewOptions
): Promise<void> {
  const { platformClient, projectId, prNumber, postComments } = options;

  console.log(chalk.bold.cyan('\n📋 DRS | Code Review Analysis\n'));

  // Fetch PR/MR details
  console.log(chalk.gray(`Fetching PR/MR #${prNumber}...\n`));

  const pr = await platformClient.getPullRequest(projectId, prNumber);
  const allFiles = await platformClient.getChangedFiles(projectId, prNumber);

  console.log(chalk.bold(`PR/MR: ${pr.title}`));
  console.log(chalk.gray(`Author: ${pr.author}`));
  console.log(chalk.gray(`Branch: ${pr.sourceBranch} → ${pr.targetBranch}`));
  console.log(chalk.gray(`Files changed: ${allFiles.length}\n`));

  if (allFiles.length === 0) {
    console.log(chalk.yellow('✓ No changes to review\n'));
    return;
  }

  // Get list of changed files (excluding deleted files)
  const changedFiles = allFiles
    .filter((file) => file.status !== 'removed')
    .map((file) => file.filename);

  if (changedFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return;
  }

  const filteredFiles = filterIgnoredFiles(changedFiles, config);
  const ignoredCount = changedFiles.length - filteredFiles.length;

  if (ignoredCount > 0) {
    console.log(chalk.gray(`Ignoring ${ignoredCount} file(s) based on patterns\n`));
  }

  if (filteredFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return;
  }

  // Connect to OpenCode
  const opencode = await connectToOpenCode(config, options.workingDir || process.cwd());

  try {
    // Execute review
    console.log(chalk.gray('Starting code analysis...\n'));

    const issues: ReviewIssue[] = [];

    // Base instructions for review agents
    const baseInstructions = `Review the following files from PR/MR #${prNumber}:

${filteredFiles.map((f) => `- ${f}`).join('\n')}

**Instructions:**
1. Use the Read tool to examine each changed file
2. Analyze the code for issues in your specialty area
3. Output your findings in this JSON format:

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

Be thorough and identify all issues. Include line numbers when possible.`;

    // Invoke all configured review agents in parallel for faster execution
    const agentNames = getAgentNames(config);
    const agentPromises = agentNames.map(async (agentType) => {
      const agentName = `review/${agentType}`;
      console.log(chalk.gray(`Running ${agentType} review...\n`));

      try {
        // Build prompt with global and agent-specific context
        const reviewPrompt = buildReviewPrompt(
          agentType,
          baseInstructions,
          prNumber,
          filteredFiles
        );

        const session = await opencode.createSession({
          agent: agentName,
          message: reviewPrompt,
          context: {
            files: filteredFiles,
            prNumber,
          },
        });

        const agentIssues: ReviewIssue[] = [];

        // Collect results from this agent
        for await (const message of opencode.streamMessages(session.id)) {
          if (message.role === 'assistant') {
            // Parse issues from response
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

    // Wait for all agents to complete in parallel
    const agentResults = await Promise.all(agentPromises);

    // Check if all agents failed
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
      await opencode.shutdown();
      process.exit(1);
    }

    if (failedAgents.length > 0) {
      console.log(
        chalk.yellow(
          `\n⚠️  ${failedAgents.length} of ${agentResults.length} agents failed: ${failedAgents.map((r) => r.agentType).join(', ')}\n`
        )
      );
    }

    // Flatten all issues from successful agents
    agentResults.forEach((result) => issues.push(...result.issues));

    // Display summary
    const summary = calculateSummary(filteredFiles.length, issues);
    displayReviewSummary({ issues, summary, filesReviewed: filteredFiles.length });

    // Post comments to platform if requested
    if (postComments) {
      await postReviewComments(
        platformClient,
        projectId,
        prNumber,
        summary,
        issues,
        pr.platformData,
        options.lineValidator,
        options.createInlinePosition
      );
    }

    // Generate code quality report if requested
    if (options.codeQualityReport) {
      await generateAndWriteCodeQualityReport(
        issues,
        options.codeQualityReport,
        options.workingDir || process.cwd()
      );
    }

    // Exit with error code if critical issues found
    if (summary.bySeverity.CRITICAL > 0) {
      console.log(chalk.red.bold('⚠️  Critical issues found!\n'));
      await opencode.shutdown();
      process.exit(1);
    } else if (summary.issuesFound === 0) {
      console.log(chalk.green('✓ No issues found! Code looks good.\n'));
    }
  } finally {
    // Shutdown OpenCode
    await opencode.shutdown();
  }
}

/**
 * Post review comments to the platform
 */
async function postReviewComments(
  platformClient: PlatformClient,
  projectId: string,
  prNumber: number,
  summary: ReturnType<typeof calculateSummary>,
  issues: ReviewIssue[],
  platformData: any,
  lineValidator?: LineValidator,
  createInlinePosition?: (issue: ReviewIssue, platformData: any) => InlineCommentPosition
): Promise<void> {
  console.log(chalk.gray('Fetching existing comments...\n'));

  // Fetch existing comments to prevent duplicates
  const [existingComments, existingInlineComments] = await Promise.all([
    platformClient.getComments(projectId, prNumber),
    platformClient.getInlineComments(projectId, prNumber),
  ]);

  // Find our existing summary comment
  const allComments: PlatformComment[] = [
    ...existingComments.map((c) => ({ id: c.id, body: c.body })),
    ...existingInlineComments.map((c) => ({ id: c.id, body: c.body })),
  ];

  const existingSummary = findExistingSummaryComment(
    existingComments.map((c) => ({ id: c.id, body: c.body }))
  );

  // Post or update summary comment
  console.log(chalk.gray('Posting review summary...\n'));
  const summaryComment = formatSummaryComment(summary, issues, BOT_COMMENT_ID);

  if (existingSummary) {
    await platformClient.updateComment(projectId, prNumber, existingSummary.id, summaryComment);
    console.log(chalk.green('✓ Updated existing review summary'));
  } else {
    await platformClient.createComment(projectId, prNumber, summaryComment);
    console.log(chalk.green('✓ Posted new review summary'));
  }

  // Prepare issues for posting: filter to CRITICAL/HIGH, deduplicate, validate lines
  const prepared = prepareIssuesForPosting(issues, allComments, (issue) => {
    if (!issue.line || !lineValidator) return false;
    return lineValidator.isValidLine(issue.file, issue.line);
  });

  if (prepared.deduplicatedCount > 0) {
    console.log(
      chalk.gray(`Skipped ${prepared.deduplicatedCount} duplicate issue(s) already commented\n`)
    );
  }

  // Post inline comments for new CRITICAL/HIGH issues
  if (prepared.inlineIssues.length > 0 && createInlinePosition) {
    const inlineComments = prepared.inlineIssues.map((issue) => ({
      body: formatIssueComment(issue, createIssueFingerprint(issue)),
      position: createInlinePosition(issue, platformData),
    }));

    await platformClient.createBulkInlineComments(projectId, prNumber, inlineComments);
  }

  // Add ai-reviewed label
  await platformClient.addLabels(projectId, prNumber, ['ai-reviewed']);

  console.log(chalk.green('✓ Review posted\n'));
}

/**
 * Generate and write GitLab code quality report
 */
async function generateAndWriteCodeQualityReport(
  issues: ReviewIssue[],
  reportPath: string,
  workingDir: string
): Promise<void> {
  console.log(chalk.gray('Generating code quality report...\n'));

  const report = generateCodeQualityReport(issues);
  const jsonContent = formatCodeQualityReport(report);

  const fullPath = resolve(workingDir, reportPath);
  await writeFile(fullPath, jsonContent, 'utf-8');

  console.log(chalk.green(`✓ Code quality report written to ${reportPath}`));
  console.log(chalk.gray(`  Total issues: ${report.length}\n`));
}
