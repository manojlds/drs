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
import {
  getDescriberModelOverride,
  getModelOverrides,
  getUnifiedModelOverride,
  type DRSConfig,
} from './config.js';
import type { ReviewIssue } from './comment-formatter.js';
import { connectToOpenCode, filterIgnoredFiles } from './review-orchestrator.js';
import { buildBaseInstructions, runReviewPipeline, displayReviewSummary } from './review-core.js';
import type { PlatformClient, LineValidator, InlineCommentPosition } from './platform-client.js';
import { generateCodeQualityReport, formatCodeQualityReport } from './code-quality-report.js';
import { formatReviewJson, writeReviewJson, printReviewJson } from './json-output.js';
import {
  enforceRepoBranchMatch,
  resolveBaseBranch,
  getCanonicalDiffCommand,
} from './repository-validator.js';
import { postReviewComments } from './comment-poster.js';
import { runDescribeIfEnabled } from './description-executor.js';
import { postErrorComment, removeErrorComment } from './error-comment-poster.js';

// Re-export functions for backward compatibility
export { enforceRepoBranchMatch } from './repository-validator.js';
export { postReviewComments } from './comment-poster.js';

export interface UnifiedReviewOptions {
  /** Platform client (GitHub or GitLab adapter) */
  platformClient: PlatformClient;
  /** Project ID (e.g., "owner/repo" for GitHub, project ID for GitLab) */
  projectId: string;
  /** PR/MR number */
  prNumber: number;
  /** Whether to post comments to the platform */
  postComments: boolean;
  /** Whether to post an error comment if the review fails */
  postErrorComment?: boolean;
  /** Optional path to output GitLab code quality report JSON */
  codeQualityReport?: string;
  /** Optional path to write JSON results file */
  outputPath?: string;
  /** Output results as JSON to console */
  jsonOutput?: boolean;
  /** Override base branch used for diff command hints */
  baseBranch?: string;
  /** Optional line validator for checking which lines can be commented */
  lineValidator?: LineValidator;
  /** Optional function to create inline comment position data */
  createInlinePosition?: (issue: ReviewIssue, platformData: unknown) => InlineCommentPosition;
  /** Working directory for file access */
  workingDir?: string;
  /** Generate PR/MR description during review */
  describe?: boolean;
  /** Post generated description during review */
  postDescription?: boolean;
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

  // Track OpenCode instance for cleanup
  let opencode: Awaited<ReturnType<typeof connectToOpenCode>> | null = null;

  try {
    console.log(chalk.bold.cyan('\n📋 DRS | Code Review Analysis\n'));

    // Fetch PR/MR details
    console.log(chalk.gray(`Fetching PR/MR #${prNumber}...\n`));

    const pr = await platformClient.getPullRequest(projectId, prNumber);

    await enforceRepoBranchMatch(options.workingDir || process.cwd(), projectId, pr, {
      skipRepoCheck: config.review.skipRepoCheck,
      skipBranchCheck: config.review.skipBranchCheck,
    });

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
    const changedFileNames = allFiles
      .filter((file) => file.status !== 'removed')
      .map((file) => file.filename);

    if (changedFileNames.length === 0) {
      console.log(chalk.yellow('✓ No files to review after filtering\n'));
      return;
    }

    // Filter files by ignore patterns
    const filteredFileNames = filterIgnoredFiles(changedFileNames, config);
    const filteredFiles = filteredFileNames;
    const ignoredCount = changedFileNames.length - filteredFiles.length;

    if (ignoredCount > 0) {
      console.log(chalk.gray(`Ignoring ${ignoredCount} file(s) based on patterns\n`));
    }

    if (filteredFiles.length === 0) {
      console.log(chalk.yellow('✓ No files to review after filtering\n'));
      return;
    }

    const reviewOverrides = {
      ...getModelOverrides(config),
      ...getUnifiedModelOverride(config),
    };
    const describeEnabled = options.describe ?? config.review.describe?.enabled ?? false;
    const postDescriptionEnabled =
      options.postDescription ?? config.review.describe?.postDescription ?? false;

    const describeOverrides = describeEnabled ? getDescriberModelOverride(config) : {};
    const modelOverrides = { ...reviewOverrides, ...describeOverrides };

    // Connect to OpenCode
    opencode = await connectToOpenCode(config, options.workingDir || process.cwd(), {
      debug: options.debug,
      modelOverrides,
    });
    const filesForDescribe = allFiles.map((file) => ({
      filename: file.filename,
      patch: file.patch,
    }));
    if (describeEnabled) {
      await runDescribeIfEnabled(
        opencode,
        config,
        platformClient,
        projectId,
        pr,
        filesForDescribe,
        postDescriptionEnabled,
        options.workingDir || process.cwd(),
        options.debug
      );
    }

    // Build instructions for platform review - pass actual diff content from platform
    const reviewLabel = `PR/MR #${prNumber}`;
    const baseBranchResolution = resolveBaseBranch(options.baseBranch, pr.targetBranch);
    const fallbackDiffCommand = getCanonicalDiffCommand(pr, baseBranchResolution);
    const filesForInstructions = filteredFiles.map((filename) => ({ filename }));
    let baseInstructions = buildBaseInstructions(
      reviewLabel,
      filesForInstructions,
      fallbackDiffCommand
    );
    if (baseBranchResolution.resolvedBaseBranch) {
      baseInstructions = `${baseInstructions}\n\nBase branch resolved to: ${baseBranchResolution.resolvedBaseBranch} (${baseBranchResolution.source})`;
    }
    // Run agents using shared core logic
    const result = await runReviewPipeline(
      opencode,
      config,
      baseInstructions,
      reviewLabel,
      filteredFiles,
      { prNumber },
      options.workingDir || process.cwd(),
      options.debug || false
    );

    // Display summary
    displayReviewSummary(result);

    // Post comments to platform if requested
    if (postComments) {
      // Remove any previous error comment on successful review
      await removeErrorComment(platformClient, projectId, prNumber);

      await postReviewComments(
        platformClient,
        projectId,
        prNumber,
        result.summary,
        result.issues,
        result.changeSummary,
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
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Post error comment if enabled
    if (options.postErrorComment) {
      try {
        await postErrorComment(platformClient, projectId, prNumber, errorMessage);
      } catch (postError) {
        const postErrorMessage = postError instanceof Error ? postError.message : String(postError);
        console.warn(chalk.yellow(`Could not post error comment: ${postErrorMessage}`));
      }
    }

    // Handle "all agents failed" error
    if (error instanceof Error && error.message === 'All review agents failed') {
      if (opencode) {
        await opencode.shutdown();
      }
      process.exit(1);
    }
    throw error;
  } finally {
    // Shutdown OpenCode if it was initialized
    if (opencode) {
      await opencode.shutdown();
    }
  }
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
