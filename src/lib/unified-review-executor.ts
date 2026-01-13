/**
 * Unified review executor for GitHub and GitLab
 *
 * This module provides a platform-agnostic way to execute code reviews
 * by using the PlatformClient interface. It handles platform-specific
 * features like posting comments and generating reports.
 *
 * Uses shared core logic from review-core.ts.
 */

import chalk from 'chalk';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { DRSConfig } from './config.js';
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
import { connectToOpenCode, filterIgnoredFiles } from './review-orchestrator.js';
import {
  buildBaseInstructions,
  runReviewAgents,
  displayReviewSummary,
  type FileWithDiff,
} from './review-core.js';
import type { PlatformClient, LineValidator, InlineCommentPosition } from './platform-client.js';
import { generateCodeQualityReport, formatCodeQualityReport } from './code-quality-report.js';
import { formatReviewJson, writeReviewJson, printReviewJson } from './json-output.js';

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
  /** Optional path to write JSON results file */
  outputPath?: string;
  /** Output results as JSON to console */
  jsonOutput?: boolean;
  /** Optional line validator for checking which lines can be commented */
  lineValidator?: LineValidator;
  /** Optional function to create inline comment position data */
  createInlinePosition?: (issue: ReviewIssue, platformData: any) => InlineCommentPosition;
  /** Working directory for file access */
  workingDir?: string;
  /** Debug mode - print OpenCode configuration */
  debug?: boolean;
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

  // Get list of changed files (excluding deleted files) with their diffs
  const changedFilesWithDiffs: FileWithDiff[] = allFiles
    .filter((file) => file.status !== 'removed')
    .map((file) => ({
      filename: file.filename,
      patch: file.patch,
    }));

  if (changedFilesWithDiffs.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return;
  }

  // Filter files but keep diff content
  const changedFileNames = changedFilesWithDiffs.map((f) => f.filename);
  const filteredFileNames = filterIgnoredFiles(changedFileNames, config);
  const filteredFilesWithDiffs = changedFilesWithDiffs.filter((f) =>
    filteredFileNames.includes(f.filename)
  );
  const filteredFiles = filteredFileNames;
  const ignoredCount = changedFileNames.length - filteredFiles.length;

  if (ignoredCount > 0) {
    console.log(chalk.gray(`Ignoring ${ignoredCount} file(s) based on patterns\n`));
  }

  if (filteredFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return;
  }

  // Connect to OpenCode
  const opencode = await connectToOpenCode(config, options.workingDir || process.cwd(), {
    debug: options.debug,
  });

  try {
    // Build instructions for platform review - pass actual diff content from platform
    const reviewLabel = `PR/MR #${prNumber}`;
    const baseInstructions = buildBaseInstructions(
      reviewLabel,
      filteredFilesWithDiffs,
      'git diff HEAD~1 -- <file>' // Fallback if no diff content
    );

    // Run agents using shared core logic
    const result = await runReviewAgents(
      opencode,
      config,
      baseInstructions,
      reviewLabel,
      filteredFiles,
      { prNumber }
    );

    // Display summary
    displayReviewSummary(result);

    // Post comments to platform if requested
    if (postComments) {
      await postReviewComments(
        platformClient,
        projectId,
        prNumber,
        result.summary,
        result.issues,
        pr.platformData,
        options.lineValidator,
        options.createInlinePosition
      );
    }

    // Generate code quality report if requested
    if (options.codeQualityReport) {
      await generateAndWriteCodeQualityReport(
        result.issues,
        options.codeQualityReport,
        options.workingDir || process.cwd()
      );
    }

    // Handle JSON output
    const wantsJsonOutput = options.jsonOutput || options.outputPath;

    if (wantsJsonOutput) {
      const jsonOutput = formatReviewJson(result.summary, result.issues, {
        source: `${options.prNumber}`,
        project: options.projectId,
        branch: {
          source: pr.sourceBranch,
          target: pr.targetBranch,
        },
      });

      if (options.outputPath) {
        await writeReviewJson(jsonOutput, options.outputPath, options.workingDir || process.cwd());
        console.log(chalk.green(`\n✓ Review results written to ${options.outputPath}\n`));
      }

      if (options.jsonOutput) {
        printReviewJson(jsonOutput);
      }
    }

    // Exit with error code if critical issues found
    if (result.summary.bySeverity.CRITICAL > 0) {
      console.log(chalk.red.bold('⚠️  Critical issues found!\n'));
      await opencode.shutdown();
      process.exit(1);
    } else if (result.summary.issuesFound === 0) {
      console.log(chalk.green('✓ No issues found! Code looks good.\n'));
    }
  } catch (error) {
    // Handle "all agents failed" error
    if (error instanceof Error && error.message === 'All review agents failed') {
      await opencode.shutdown();
      process.exit(1);
    }
    throw error;
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
