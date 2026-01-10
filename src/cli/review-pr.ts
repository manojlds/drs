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
  console.log(chalk.gray(`Fetching PR #${options.prNumber} from ${options.owner}/${options.repo}...\n`));

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
  const changedFiles = files
    .filter(file => file.status !== 'removed')
    .map(file => file.filename);

  // Build a map of file -> valid line numbers (lines that are in the diff)
  const validLinesMap = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch && file.status !== 'removed') {
      const validLines = parseValidLinesFromPatch(file.patch);
      validLinesMap.set(file.filename, validLines);
    }
  }

  // Connect to OpenCode (or start in-process if serverUrl is empty)
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  const opencode = await createOpencodeClientInstance({
    baseUrl: config.opencode.serverUrl || undefined,
    directory: process.cwd(), // Give agents access to working directory to read files
  });

  // Directly invoke each specialized review agent
  console.log(chalk.gray('Starting code analysis...\n'));

  const issues: ReviewIssue[] = [];

  // Create review message for specialized agents
  const reviewPrompt = `Review the following files from PR #${options.prNumber}:

${changedFiles.map(f => `- ${f}`).join('\n')}

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

  // Invoke each configured review agent
  for (const agentType of config.review.agents) {
    const agentName = `review/${agentType}`;
    console.log(chalk.gray(`Running ${agentType} review...\n`));

    try {
      const session = await opencode.createSession({
        agent: agentName,
        message: reviewPrompt,
        context: {
          files: changedFiles,
          prNumber: options.prNumber,
        },
      });

      // Collect results from this agent
      let messageCount = 0;
      for await (const message of opencode.streamMessages(session.id)) {
        messageCount++;
        console.log(chalk.gray(`[${agentType}] Received message ${messageCount} (role: ${message.role})`));

        if (message.role === 'assistant') {
          // Log full agent response for debugging
          console.log(chalk.gray(`\n[${agentType} Response]:`));
          console.log(message.content);
          console.log(chalk.gray(`[End ${agentType} Response]\n`));

          // Parse issues from response
          const parsedIssues = parseReviewIssues(message.content);
          if (parsedIssues.length > 0) {
            issues.push(...parsedIssues);
            console.log(chalk.green(`✓ [${agentType}] Found ${parsedIssues.length} issue(s)\n`));
          } else {
            console.log(chalk.yellow(`⚠ [${agentType}] No issues parsed from response\n`));
          }
        }
      }

      console.log(chalk.gray(`[${agentType}] Finished. Total messages: ${messageCount}\n`));

      await opencode.closeSession(session.id);
    } catch (error) {
      console.error(chalk.yellow(`Warning: ${agentType} agent failed: ${error}`));
    }
  }

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
    console.log(chalk.gray('Posting review comments to GitHub...\n'));

    // Post comprehensive summary comment with all issues
    const summaryComment = formatSummaryComment(summary, issues);
    await github.createPRComment(options.owner, options.repo, options.prNumber, summaryComment);
    console.log(chalk.green('✓ Posted review summary to PR'));

    // Post inline comments for Critical and High severity issues only
    // This provides line-specific context for important issues while avoiding rate limits
    const criticalAndHigh = issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH');

    if (criticalAndHigh.length > 0 && pr.head.sha) {
      // Filter to only issues on lines that are in the diff
      const validInlineIssues = criticalAndHigh.filter(issue => {
        if (!issue.line) return false;
        const validLines = validLinesMap.get(issue.file);
        return validLines && validLines.has(issue.line);
      });

      if (validInlineIssues.length > 0) {
        console.log(chalk.gray(`\nPosting ${validInlineIssues.length} inline comment(s) for Critical/High issues...\n`));

        for (let i = 0; i < validInlineIssues.length; i++) {
          const issue = validInlineIssues[i];

          try {
            await github.createPRReviewComment(
              options.owner,
              options.repo,
              options.prNumber,
              formatIssueComment(issue),
              pr.head.sha,
              issue.file,
              issue.line!
            );
            console.log(chalk.gray(`  ✓ Posted inline comment for ${issue.file}:${issue.line}`));

            // Add delay between posts to avoid rate limits (only if not the last one)
            if (i < validInlineIssues.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (error: any) {
            console.warn(chalk.yellow(`  ⚠ Could not post inline comment for ${issue.file}:${issue.line} - ${error.message}`));
          }
        }

        console.log(chalk.green('\n✓ Finished posting inline comments\n'));
      }

      // Log skipped issues
      const skippedCount = criticalAndHigh.length - validInlineIssues.length;
      if (skippedCount > 0) {
        console.log(chalk.gray(`(Skipped ${skippedCount} inline comment(s) for lines not in the diff - they're in the summary)\n`));
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
  await opencode.shutdown();
}
