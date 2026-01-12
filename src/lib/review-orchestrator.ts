import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import { shouldIgnoreFile, getModelOverrides, getAgentNames } from './config.js';
import { createOpencodeClientInstance, type OpencodeClient } from '../opencode/client.js';
import { parseReviewIssues } from './issue-parser.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import { buildReviewPrompt } from './context-loader.js';

/**
 * Source information for a review (platform-agnostic)
 */
export interface ReviewSource {
  /** Human-readable name for logging (e.g., "PR #123", "MR !456", "Local diff") */
  name: string;
  /** List of changed file paths */
  files: string[];
  /** Additional context to pass to review agents */
  context: Record<string, any>;
  /** Working directory for the review (defaults to process.cwd()) */
  workingDir?: string;
  /** Debug mode - print OpenCode configuration */
  debug?: boolean;
}

/**
 * Result of a review execution
 */
export interface ReviewResult {
  /** All issues found by review agents */
  issues: ReviewIssue[];
  /** Calculated summary statistics */
  summary: ReturnType<typeof calculateSummary>;
  /** Number of files actually reviewed (after filtering) */
  filesReviewed: number;
}

/**
 * Filter files based on ignore patterns in config
 */
export function filterIgnoredFiles(files: string[], config: DRSConfig): string[] {
  return files.filter((file) => !shouldIgnoreFile(file, config));
}

export interface ConnectOptions {
  debug?: boolean;
}

/**
 * Connect to OpenCode server (or start in-process)
 */
export async function connectToOpenCode(
  config: DRSConfig,
  workingDir?: string,
  options?: ConnectOptions
): Promise<OpencodeClient> {
  console.log(chalk.gray('Connecting to OpenCode server...\n'));

  try {
    // Get model overrides from DRS config
    const modelOverrides = getModelOverrides(config);

    return await createOpencodeClientInstance({
      baseUrl: config.opencode.serverUrl || undefined,
      directory: workingDir || process.cwd(),
      modelOverrides,
      provider: config.opencode.provider,
      debug: options?.debug,
    });
  } catch (error) {
    console.error(chalk.red('✗ Failed to connect to OpenCode server'));
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
    console.log(
      chalk.yellow('Please ensure OpenCode server is running or check your configuration.\n')
    );
    throw error;
  }
}

/**
 * Execute a code review using OpenCode agents
 *
 * This is the core review orchestrator that handles:
 * - File filtering (ignore patterns)
 * - OpenCode connection
 * - Agent execution and streaming
 * - Issue parsing and collection
 * - Summary calculation
 *
 * Platform-specific logic (GitHub/GitLab/local) should:
 * 1. Fetch changed files from their source
 * 2. Call this function with a ReviewSource
 * 3. Handle posting results to their platform
 */
export async function executeReview(
  config: DRSConfig,
  source: ReviewSource
): Promise<ReviewResult> {
  console.log(chalk.gray(`Found ${source.files.length} changed file(s)\n`));

  // Filter files based on ignore patterns
  const filteredFiles = filterIgnoredFiles(source.files, config);
  const ignoredCount = source.files.length - filteredFiles.length;

  if (ignoredCount > 0) {
    console.log(chalk.gray(`Ignoring ${ignoredCount} file(s) based on patterns\n`));
  }

  if (filteredFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return {
      issues: [],
      summary: calculateSummary(0, []),
      filesReviewed: 0,
    };
  }

  console.log(chalk.gray(`Reviewing ${filteredFiles.length} file(s)\n`));

  // Connect to OpenCode
  const opencode = await connectToOpenCode(config, source.workingDir, { debug: source.debug });

  try {
    // Execute review
    console.log(chalk.gray('Starting code analysis...\n'));

    const issues: ReviewIssue[] = [];

    const baseInstructions = `Review the following files from ${source.name}:

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

    const agentNames = getAgentNames(config);
    const agentPromises = agentNames.map(async (agentType) => {
      const agentName = `review/${agentType}`;
      console.log(chalk.gray(`Running ${agentType} review...\n`));

      try {
        const reviewPrompt = buildReviewPrompt(
          agentType,
          baseInstructions,
          source.name,
          filteredFiles
        );

        const session = await opencode.createSession({
          agent: agentName,
          message: reviewPrompt,
          context: {
            ...source.context,
            files: filteredFiles,
          },
        });

        const agentIssues: ReviewIssue[] = [];

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

    const agentResults = await Promise.all(agentPromises);

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

    agentResults.forEach((result) => issues.push(...result.issues));

    const summary = calculateSummary(filteredFiles.length, issues);

    return {
      issues,
      summary,
      filesReviewed: filteredFiles.length,
    };
  } finally {
    // Always shut down OpenCode client
    await opencode.shutdown();
  }
}

/**
 * Display review summary to terminal (common formatting)
 */
export function displayReviewSummary(result: ReviewResult): void {
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
export function hasBlockingIssues(result: ReviewResult): boolean {
  return result.summary.bySeverity.CRITICAL > 0 || result.summary.bySeverity.HIGH > 0;
}
