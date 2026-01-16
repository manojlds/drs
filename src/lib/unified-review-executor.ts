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
import simpleGit from 'simple-git';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  getDescriberModelOverride,
  getModelOverrides,
  getUnifiedModelOverride,
  type DRSConfig,
} from './config.js';
import type { calculateSummary } from './comment-formatter.js';
import { formatSummaryComment, formatIssueComment, type ReviewIssue } from './comment-formatter.js';
import type { ChangeSummary } from './change-summary.js';
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
  runReviewPipeline,
  displayReviewSummary,
  type FileWithDiff,
} from './review-core.js';
import { buildDescribeInstructions } from './describe-core.js';
import { compressFilesWithDiffs, formatCompressionSummary } from './context-compression.js';
import type {
  PlatformClient,
  LineValidator,
  InlineCommentPosition,
  PullRequest,
} from './platform-client.js';
import { generateCodeQualityReport, formatCodeQualityReport } from './code-quality-report.js';
import {
  displayDescription,
  normalizeDescription,
  postDescription,
  type Description,
  type Platform,
} from './description-formatter.js';
import { parseDescribeOutput } from './describe-parser.js';
import { formatReviewJson, writeReviewJson, printReviewJson } from './json-output.js';
import type { OpencodeClient } from '../opencode/client.js';

interface RepoInfo {
  host?: string;
  repoPath?: string;
  remoteUrl?: string;
}

function normalizeRepoPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function parseRemoteUrl(remoteUrl: string): RepoInfo | null {
  if (!remoteUrl) return null;

  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return { host: sshMatch[1], repoPath: sshMatch[2], remoteUrl: trimmed };
  }

  if (
    trimmed.startsWith('ssh://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) {
    try {
      const url = new URL(trimmed);
      return {
        host: url.hostname,
        repoPath: url.pathname.replace(/^\/+/, ''),
        remoteUrl: trimmed,
      };
    } catch {
      return null;
    }
  }

  return null;
}

function getExpectedRepoInfo(pr: any, projectId: string): RepoInfo | null {
  const data = pr?.platformData;

  if (data?.base?.repo?.full_name) {
    const hostUrl = data.base.repo.html_url || data.base.repo.clone_url || data.base.repo.ssh_url;
    const hostInfo = hostUrl ? parseRemoteUrl(hostUrl) : null;
    return {
      host: hostInfo?.host || 'github.com',
      repoPath: data.base.repo.full_name,
    };
  }

  if (typeof projectId === 'string' && projectId.includes('/')) {
    return { repoPath: projectId };
  }

  if (typeof data?.web_url === 'string') {
    const info = parseRemoteUrl(data.web_url);
    if (info?.repoPath) {
      const pathWithoutSuffix = info.repoPath.replace(/\/-\/.*$/, '');
      return { host: info.host, repoPath: pathWithoutSuffix };
    }
  }

  return null;
}

type BaseBranchResolution = {
  baseBranch?: string;
  resolvedBaseBranch?: string;
  diffCommand: string;
  source?: string;
};

function normalizeBaseBranch(baseBranch?: string): string | undefined {
  if (!baseBranch) return undefined;
  return baseBranch.startsWith('origin/') ? baseBranch : `origin/${baseBranch}`;
}

function resolveBaseBranch(cliBaseBranch?: string, targetBranch?: string): BaseBranchResolution {
  if (cliBaseBranch) {
    const resolved = normalizeBaseBranch(cliBaseBranch);
    return {
      baseBranch: cliBaseBranch,
      resolvedBaseBranch: resolved,
      diffCommand: `git diff ${resolved}...HEAD -- <file>`,
      source: 'cli',
    };
  }

  if (process.env.DRS_BASE_BRANCH) {
    const resolved = normalizeBaseBranch(process.env.DRS_BASE_BRANCH);
    return {
      baseBranch: process.env.DRS_BASE_BRANCH,
      resolvedBaseBranch: resolved,
      diffCommand: `git diff ${resolved}...HEAD -- <file>`,
      source: 'env:DRS_BASE_BRANCH',
    };
  }

  if (process.env.GITHUB_BASE_REF) {
    const resolved = normalizeBaseBranch(process.env.GITHUB_BASE_REF);
    return {
      baseBranch: process.env.GITHUB_BASE_REF,
      resolvedBaseBranch: resolved,
      diffCommand: `git diff ${resolved}...HEAD -- <file>`,
      source: 'env:GITHUB_BASE_REF',
    };
  }

  if (process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) {
    const resolved = normalizeBaseBranch(process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME);
    return {
      baseBranch: process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
      resolvedBaseBranch: resolved,
      diffCommand: `git diff ${resolved}...HEAD -- <file>`,
      source: 'env:CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
    };
  }

  if (targetBranch) {
    const resolved = normalizeBaseBranch(targetBranch);
    return {
      baseBranch: targetBranch,
      resolvedBaseBranch: resolved,
      diffCommand: `git diff ${resolved}...HEAD -- <file>`,
      source: 'pr:targetBranch',
    };
  }

  return {
    diffCommand: 'git diff HEAD~1 -- <file>',
  };
}

export async function enforceRepoBranchMatch(
  workingDir: string,
  projectId: string,
  pr: PullRequest
): Promise<void> {
  const git = simpleGit({ baseDir: workingDir });
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not a git repository. Run review from the PR/MR repository checkout.');
  }

  const branchSummary = await git.branch();
  const currentBranch = branchSummary.current;
  const headSha = (await git.revparse(['HEAD'])).trim();

  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin') || remotes[0];
  const remoteUrl = origin?.refs?.fetch || origin?.refs?.push;
  if (!remoteUrl) {
    throw new Error('No git remotes found. Cannot validate repository match for PR/MR.');
  }

  const localRepo = parseRemoteUrl(remoteUrl);
  if (!localRepo?.repoPath) {
    throw new Error(`Unable to parse git remote URL: ${remoteUrl}`);
  }

  const expectedRepo = getExpectedRepoInfo(pr, projectId);
  if (!expectedRepo?.repoPath) {
    throw new Error('Unable to determine expected repository from PR/MR data.');
  }

  const localRepoPath = normalizeRepoPath(localRepo.repoPath);
  const expectedRepoPath = normalizeRepoPath(expectedRepo.repoPath);
  const hostMismatch =
    expectedRepo.host &&
    localRepo.host &&
    expectedRepo.host.toLowerCase() !== localRepo.host.toLowerCase();
  const repoMismatch = localRepoPath !== expectedRepoPath;

  if (hostMismatch || repoMismatch) {
    throw new Error(
      `Repository mismatch for PR/MR review.\n` +
        `Local repo: ${localRepo.host ? `${localRepo.host}/` : ''}${localRepoPath}\n` +
        `Expected: ${expectedRepo.host ? `${expectedRepo.host}/` : ''}${expectedRepoPath}\n` +
        `Run the review from the PR/MR repository checkout.`
    );
  }

  const expectedBranch = pr.sourceBranch;
  const branchMatches = currentBranch === expectedBranch;
  const shaMatches = pr.headSha ? headSha === pr.headSha : false;

  if (!branchMatches && !shaMatches) {
    throw new Error(
      `Branch mismatch for PR/MR review.\n` +
        `Local branch: ${currentBranch || '(unknown)'}\n` +
        `Expected branch: ${expectedBranch}\n` +
        `Check out the PR/MR source branch before running the review.`
    );
  }
}

function detectPlatform(pr: PullRequest): Platform {
  const platformData = pr.platformData as Record<string, unknown> | undefined;
  if (platformData && ('iid' in platformData || 'diff_refs' in platformData)) {
    return 'MR';
  }
  return 'PR';
}

async function runDescribeIfEnabled(
  opencode: OpencodeClient,
  config: DRSConfig,
  platformClient: PlatformClient,
  projectId: string,
  pr: PullRequest,
  files: FileWithDiff[],
  shouldPostDescription: boolean,
  workingDir: string,
  debug?: boolean
): Promise<Description | null> {
  console.log(chalk.bold.blue('\n🔍 Generating PR/MR Description\n'));

  const label = `${detectPlatform(pr)} #${pr.number}`;
  const compression = compressFilesWithDiffs(files, config.contextCompression);
  const compressionSummary = formatCompressionSummary(compression);

  if (compressionSummary) {
    console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
  }

  const instructions = buildDescribeInstructions(label, compression.files, compressionSummary);

  if (debug) {
    console.log(chalk.yellow('\n=== Describe Agent Instructions ==='));
    console.log(instructions);
    console.log(chalk.yellow('=== End Instructions ===\n'));
  }

  const session = await opencode.createSession({
    agent: 'describe/pr-describer',
    message: instructions,
  });

  let fullResponse = '';
  for await (const message of opencode.streamMessages(session.id)) {
    if (message.role === 'assistant') {
      fullResponse += message.content;
    }
  }

  let descriptionPayload: Description;
  try {
    descriptionPayload = (await parseDescribeOutput(
      workingDir,
      debug,
      fullResponse
    )) as Description;
  } catch (parseError) {
    console.error(chalk.red('Failed to parse agent output as JSON'));
    console.log(chalk.dim('Agent output:'), fullResponse);
    const reason = parseError instanceof Error ? `: ${parseError.message}` : '';
    throw new Error(`Describe agent did not return valid JSON output${reason}`);
  }

  const description = normalizeDescription(descriptionPayload);
  const platform = detectPlatform(pr);
  displayDescription(description, platform);

  if (shouldPostDescription) {
    await postDescription(platformClient, projectId, pr.number, description, platform);
  }

  return description;
}

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
  /** Override base branch used for diff command hints */
  baseBranch?: string;
  /** Optional line validator for checking which lines can be commented */
  lineValidator?: LineValidator;
  /** Optional function to create inline comment position data */
  createInlinePosition?: (issue: ReviewIssue, platformData: any) => InlineCommentPosition;
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

  console.log(chalk.bold.cyan('\n📋 DRS | Code Review Analysis\n'));

  // Fetch PR/MR details
  console.log(chalk.gray(`Fetching PR/MR #${prNumber}...\n`));

  const pr = await platformClient.getPullRequest(projectId, prNumber);

  await enforceRepoBranchMatch(options.workingDir || process.cwd(), projectId, pr);

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
  const opencode = await connectToOpenCode(config, options.workingDir || process.cwd(), {
    debug: options.debug,
    modelOverrides,
  });

  try {
    const filesForDescribe: FileWithDiff[] = allFiles.map((file) => ({
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
    const fallbackDiffCommand = baseBranchResolution.diffCommand;
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
export async function postReviewComments(
  platformClient: PlatformClient,
  projectId: string,
  prNumber: number,
  summary: ReturnType<typeof calculateSummary>,
  issues: ReviewIssue[],
  changeSummary: ChangeSummary | undefined,
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
  const summaryComment = formatSummaryComment(summary, issues, BOT_COMMENT_ID, changeSummary);

  if (existingSummary) {
    await platformClient.updateComment(projectId, prNumber, existingSummary.id, summaryComment);
    console.log(chalk.green('✓ Updated existing review summary'));
  } else {
    await platformClient.createComment(projectId, prNumber, summaryComment);
    console.log(chalk.green('✓ Posted new review summary'));
  }

  // Prepare issues for posting: filter to CRITICAL/HIGH, deduplicate, validate lines
  const criticalHighCount = issues.filter(
    (i) => i.severity === 'CRITICAL' || i.severity === 'HIGH'
  ).length;

  const prepared = prepareIssuesForPosting(issues, allComments, (issue) => {
    if (!issue.line || !lineValidator) return false;
    return lineValidator.isValidLine(issue.file, issue.line);
  });

  // Log diagnostic info about inline comment filtering
  if (criticalHighCount > 0) {
    console.log(chalk.gray(`Inline comments: ${criticalHighCount} CRITICAL/HIGH issue(s) found\n`));

    if (prepared.deduplicatedCount > 0) {
      console.log(chalk.gray(`  - ${prepared.deduplicatedCount} already commented (skipped)\n`));
    }

    const issuesWithoutLines = issues.filter(
      (i) =>
        (i.severity === 'CRITICAL' || i.severity === 'HIGH') &&
        (i.line === undefined || i.line === null)
    ).length;
    if (issuesWithoutLines > 0) {
      console.log(chalk.gray(`  - ${issuesWithoutLines} without line numbers (skipped)\n`));
    }

    const filteredByValidator =
      criticalHighCount -
      prepared.deduplicatedCount -
      issuesWithoutLines -
      prepared.inlineIssues.length;
    if (filteredByValidator > 0) {
      console.log(chalk.gray(`  - ${filteredByValidator} on lines not in diff (skipped)\n`));
    }

    if (prepared.inlineIssues.length > 0) {
      console.log(
        chalk.gray(`  → ${prepared.inlineIssues.length} will be posted as inline comments\n`)
      );
    } else {
      console.log(chalk.yellow(`  → No inline comments to post (all filtered)\n`));
    }
  } else {
    console.log(
      chalk.gray(`No CRITICAL/HIGH issues - skipping inline comments (only summary posted)\n`)
    );
  }

  // Post inline comments for new CRITICAL/HIGH issues
  if (!createInlinePosition) {
    console.log(chalk.yellow(`⚠ Inline comments disabled (no position builder configured)\n`));
  }

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
