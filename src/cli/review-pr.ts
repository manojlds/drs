import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { createGitHubClient } from '../github/client.js';
import { createOpencodeClientInstance } from '../opencode/client.js';
import {
  formatSummaryComment,
  formatIssueComment,
  calculateSummary,
  type ReviewIssue,
} from '../gitlab/comment-formatter.js';
import { parseReviewIssues } from '../lib/issue-parser.js';
import { buildReviewPrompt } from '../lib/context-loader.js';
import { filterIgnoredFiles } from '../lib/review-orchestrator.js';
import {
  BOT_COMMENT_ID,
  createIssueFingerprint,
  findExistingSummaryComment,
  prepareIssuesForPosting,
  type PlatformComment,
} from '../lib/comment-manager.js';

export interface ReviewPROptions {
  owner: string;
  repo: string;
  prNumber: number;
  postComments: boolean;
}

/**
 * Parse a GitHub diff patch to extract valid line numbers for review comments
 * GitHub only allows comments on lines that are in the diff (added, removed, or context)
 */
function parseValidLinesFromPatch(patch: string): Set<number> {
  const validLines = new Set<number>();
  const lines = patch.split('\n');
  let currentLine = 0;

  for (const line of lines) {
    // Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip empty lines or lines without proper diff prefix
    if (!line || line.length === 0) continue;

    const prefix = line[0];
    if (prefix === '+') {
      // Added line - can comment on this
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === ' ') {
      // Context line - can comment on this
      validLines.add(currentLine);
      currentLine++;
    } else if (prefix === '-') {
      // Removed line - cannot comment on "new" version, skip
      continue;
    }
  }

  return validLines;
}

/**
 * Review a GitHub pull request
 */
export async function reviewPR(config: DRSConfig, options: ReviewPROptions): Promise<void> {
  console.log(chalk.bold.cyan('\n📋 DRS | GitHub PR Analysis\n'));

  // Initialize GitHub client
  const github = createGitHubClient();

  // Fetch PR details
  console.log(
    chalk.gray(`Fetching PR #${options.prNumber} from ${options.owner}/${options.repo}...\n`)
  );

  const pr = await github.getPullRequest(options.owner, options.repo, options.prNumber);
  const files = await github.getPRFiles(options.owner, options.repo, options.prNumber);

  console.log(chalk.bold(`PR: ${pr.title}`));
  console.log(chalk.gray(`Author: ${pr.user?.login || 'Unknown'}`));
  console.log(chalk.gray(`Branch: ${pr.head.ref} → ${pr.base.ref}`));
  console.log(chalk.gray(`Files changed: ${files.length}\n`));

  if (files.length === 0) {
    console.log(chalk.yellow('✓ No changes to review\n'));
    return;
  }

  // Get list of changed files (excluding deleted files)
  const allChangedFiles = files
    .filter((file) => file.status !== 'removed')
    .map((file) => file.filename);

  // Filter files based on ignore patterns
  const changedFiles = filterIgnoredFiles(allChangedFiles, config);
  const ignoredCount = allChangedFiles.length - changedFiles.length;

  if (ignoredCount > 0) {
    console.log(
      chalk.gray(
        `Ignoring ${ignoredCount} file(s) based on patterns (${config.review.ignorePatterns.join(', ')})\n`
      )
    );
  }

  if (changedFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return;
  }

  // Build a map of file -> valid line numbers (lines that are in the diff)
  const validLinesMap = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch && file.status !== 'removed' && changedFiles.includes(file.filename)) {
      const validLines = parseValidLinesFromPatch(file.patch);
      validLinesMap.set(file.filename, validLines);
    }
  }

  // Connect to OpenCode (or start in-process if serverUrl is empty)
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  let opencode;
  try {
    opencode = await createOpencodeClientInstance({
      baseUrl: config.opencode.serverUrl || undefined,
      directory: process.cwd(), // Give agents access to working directory to read files
    });
  } catch (error) {
    console.error(chalk.red('✗ Failed to connect to OpenCode server'));
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
    console.log(
      chalk.yellow('Please ensure OpenCode server is running or check your configuration.\n')
    );
    process.exit(1);
  }

  // Directly invoke each specialized review agent
  console.log(chalk.gray('Starting code analysis...\n'));

  const issues: ReviewIssue[] = [];

  // Base instructions for review agents (used if no override)
  const baseInstructions = `Review the following files from PR #${options.prNumber}:

${changedFiles.map((f) => `- ${f}`).join('\n')}

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
  const agentPromises = config.review.agents.map(async (agentType) => {
    const agentName = `review/${agentType}`;
    console.log(chalk.gray(`Running ${agentType} review...\n`));

    try {
      // Build prompt with global and agent-specific context
      const reviewPrompt = buildReviewPrompt(
        agentType,
        baseInstructions,
        options.prNumber,
        changedFiles
      );

      const session = await opencode.createSession({
        agent: agentName,
        message: reviewPrompt,
        context: {
          files: changedFiles,
          prNumber: options.prNumber,
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
      return agentIssues;
    } catch (error) {
      console.error(chalk.yellow(`Warning: ${agentType} agent failed: ${error}`));
      return [];
    }
  });

  // Wait for all agents to complete in parallel
  const agentResults = await Promise.all(agentPromises);

  // Flatten all issues from all agents
  agentResults.forEach((agentIssues) => issues.push(...agentIssues));

  // Display and post summary
  const summary = calculateSummary(changedFiles.length, issues);

  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📊 Review Summary'));
  console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(`  Files reviewed: ${chalk.cyan(summary.filesReviewed)}`);
  console.log(`  Issues found: ${chalk.yellow(summary.issuesFound)}`);

  if (summary.issuesFound > 0) {
    console.log(`    🔴 Critical: ${chalk.red(summary.bySeverity.CRITICAL)}`);
    console.log(`    🟡 High: ${chalk.yellow(summary.bySeverity.HIGH)}`);
    console.log(`    🟠 Medium: ${chalk.hex('#FFA500')(summary.bySeverity.MEDIUM)}`);
    console.log(`    ⚪ Low: ${chalk.gray(summary.bySeverity.LOW)}`);
  }

  console.log('');

  // Post comments to GitHub if requested
  if (options.postComments) {
    console.log(chalk.gray('Fetching existing comments from PR...\n'));

    // Fetch existing comments to prevent duplicates (parallel for better performance)
    const [existingPRComments, existingReviewComments] = await Promise.all([
      github.listPRComments(options.owner, options.repo, options.prNumber),
      github.listPRReviewComments(options.owner, options.repo, options.prNumber),
    ]);

    // Find our existing summary comment using the hidden marker
    // This works with both personal access tokens and GitHub Apps
    const existingSummary = findExistingSummaryComment(
      existingPRComments.map((c) => ({ id: c.id, body: c.body || '' }))
    );

    // Post or update summary comment
    console.log(chalk.gray('Posting review summary to GitHub...\n'));
    const summaryComment = formatSummaryComment(summary, issues, BOT_COMMENT_ID);

    if (existingSummary) {
      await github.updateComment(
        options.owner,
        options.repo,
        Number(existingSummary.id),
        summaryComment
      );
      console.log(chalk.green('✓ Updated existing review summary'));
    } else {
      await github.createPRComment(options.owner, options.repo, options.prNumber, summaryComment);
      console.log(chalk.green('✓ Posted new review summary to PR'));
    }

    // Prepare issues for posting: filter to CRITICAL/HIGH, deduplicate, validate lines
    const allExistingComments: PlatformComment[] = [
      ...existingPRComments.map((c) => ({ id: c.id, body: c.body || '' })),
      ...existingReviewComments.map((c) => ({ id: c.id, body: c.body || '' })),
    ];

    const prepared = prepareIssuesForPosting(issues, allExistingComments, (issue) => {
      if (!issue.line) return false;
      const validLines = validLinesMap.get(issue.file);
      return validLines !== undefined && validLines.has(issue.line);
    });

    if (prepared.deduplicatedCount > 0) {
      console.log(
        chalk.gray(`Skipped ${prepared.deduplicatedCount} duplicate issue(s) already commented\n`)
      );
    }

    if (prepared.inlineIssues.length > 0 && pr.head.sha) {
      console.log(
        chalk.gray(
          `\nPosting ${prepared.inlineIssues.length} new inline comment(s) using bulk review API...\n`
        )
      );

      // Use bulk review API to post all inline comments at once
      const reviewComments = prepared.inlineIssues.map((issue) => ({
        path: issue.file,
        line: issue.line!,
        body: formatIssueComment(issue, createIssueFingerprint(issue)),
      }));

      try {
        await github.createPRReview(
          options.owner,
          options.repo,
          options.prNumber,
          pr.head.sha,
          `Found ${prepared.inlineIssues.length} critical/high priority issue(s) that need attention.`,
          'COMMENT',
          reviewComments
        );
        console.log(
          chalk.green(
            `✓ Posted ${prepared.inlineIssues.length} inline comment(s) in a single review`
          )
        );
      } catch (error: any) {
        console.warn(chalk.yellow(`⚠ Could not post bulk review: ${error.message}`));
        console.log(chalk.gray('Falling back to individual comment posting...\n'));

        // Fallback to individual comments if bulk fails
        for (const issue of prepared.inlineIssues) {
          try {
            await github.createPRReviewComment(
              options.owner,
              options.repo,
              options.prNumber,
              formatIssueComment(issue, createIssueFingerprint(issue)),
              pr.head.sha,
              issue.file,
              issue.line!
            );
            console.log(chalk.gray(`  ✓ Posted inline comment for ${issue.file}:${issue.line}`));
          } catch (err: any) {
            console.warn(
              chalk.yellow(
                `  ⚠ Could not post inline comment for ${issue.file}:${issue.line} - ${err.message}`
              )
            );
          }
        }
      }
    }

    // Add ai-reviewed label
    await github.addLabels(options.owner, options.repo, options.prNumber, ['ai-reviewed']);

    console.log(chalk.green('✓ Review posted to GitHub PR\n'));
  }

  // Exit with error code if critical issues found
  if (summary.bySeverity.CRITICAL > 0) {
    console.log(chalk.red.bold('⚠️  Critical issues found!\n'));
    process.exit(1);
  } else if (summary.issuesFound === 0) {
    console.log(chalk.green('✓ No issues found! PR looks good.\n'));
  }

  // Shutdown in-process OpenCode server if applicable
  await opencode?.shutdown();
}
