#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { reviewLocal } from './review-local.js';
import { reviewMR } from './review-mr.js';
import { reviewPR } from './review-pr.js';
import { postCommentsFromJson } from './post-comments.js';
import { showChanges } from './show-changes.js';
import { describePR } from './describe-pr.js';
import { describeMR } from './describe-mr.js';
import { loadConfig, type DRSConfig, type ReviewMode } from '../lib/config.js';
import { configureLogger, type LogFormat } from '../lib/logger.js';
import { config as loadDotenv } from 'dotenv';

// Load environment variables from .env in current working directory (if present)
loadDotenv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJsonPath = join(__dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

function printBanner() {
  const bannerWidth = 42;
  const title = '  DRS - Diff Review System';
  const versionText = `  Version: ${version}`;
  const titlePadding = ' '.repeat(bannerWidth - title.length);
  const versionPadding = ' '.repeat(bannerWidth - versionText.length);

  console.log('');
  console.log(chalk.bold.cyan(`  ╭${'─'.repeat(bannerWidth)}╮`));
  console.log(
    chalk.bold.cyan('  │') + chalk.bold.white(title) + titlePadding + chalk.bold.cyan('│')
  );
  console.log(
    chalk.bold.cyan('  │') + chalk.gray(versionText) + versionPadding + chalk.bold.cyan('│')
  );
  console.log(chalk.bold.cyan(`  ╰${'─'.repeat(bannerWidth)}╯`));
  console.log('');
}

const program = new Command();

program
  .name('drs')
  .description('Intelligent code review platform for GitLab and GitHub - Enterprise-grade analysis')
  .version(version);

program
  .command('review-local')
  .description('Review local git diff before pushing')
  .option('--staged', 'Review staged changes only (git diff --cached)')
  .option('--agents <agents>', 'Comma-separated list of review agents')
  .option('--review-mode <mode>', 'Review mode (multi-agent, unified, hybrid)')
  .option('--unified-model <model>', 'Model override for unified review agent')
  .option(
    '--unified-threshold <severity>',
    'Severity threshold for hybrid escalation (LOW, MEDIUM, HIGH, CRITICAL)'
  )
  .option('-o, --output <path>', 'Write review results to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .action(async (options) => {
    try {
      // Configure logger based on options
      configureLogger({
        level: options.debug ? 'debug' : 'info',
        format: (options.logFormat as LogFormat) || 'human',
        timestamps: options.logFormat === 'json',
      });

      const unifiedOverride =
        options.unifiedModel || options.unifiedThreshold
          ? {
              model: options.unifiedModel,
              severityThreshold: options.unifiedThreshold,
            }
          : undefined;
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
          mode: options.reviewMode as ReviewMode | undefined,
          unified: unifiedOverride,
        } as Partial<DRSConfig['review']>,
      } as Partial<DRSConfig>);

      await reviewLocal(config, {
        staged: options.staged || false,
        outputPath: options.output,
        jsonOutput: options.json || false,
        debug: options.debug || false,
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('review-mr')
  .description('Review a GitLab merge request')
  .requiredOption('--mr <iid>', 'Merge request IID (number)')
  .requiredOption('--project <id>', 'Project ID or path (e.g., "my-org/my-repo" or "123")')
  .option('--agents <agents>', 'Comma-separated list of review agents')
  .option('--review-mode <mode>', 'Review mode (multi-agent, unified, hybrid)')
  .option('--unified-model <model>', 'Model override for unified review agent')
  .option(
    '--unified-threshold <severity>',
    'Severity threshold for hybrid escalation (LOW, MEDIUM, HIGH, CRITICAL)'
  )
  .option('--post-comments', 'Post review comments to the MR (requires GITLAB_TOKEN)')
  .option('--post-error-comment', 'Post a comment if the review fails (requires GITLAB_TOKEN)')
  .option('--describe', 'Generate PR/MR description during review')
  .option('--skip-describe', 'Skip PR/MR description during review')
  .option('--post-description', 'Post generated description to the MR (requires GITLAB_TOKEN)')
  .option('--skip-post-description', 'Do not post generated description to the MR')
  .option(
    '--code-quality-report <path>',
    'Generate GitLab code quality report JSON file (default: gl-code-quality-report.json)'
  )
  .option('-o, --output <path>', 'Write review results to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--base-branch <branch>', 'Override base branch used for diff command hints')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .action(async (options) => {
    try {
      // Configure logger based on options
      configureLogger({
        level: options.debug ? 'debug' : 'info',
        format: (options.logFormat as LogFormat) || 'human',
        timestamps: options.logFormat === 'json',
      });

      const unifiedOverride =
        options.unifiedModel || options.unifiedThreshold
          ? {
              model: options.unifiedModel,
              severityThreshold: options.unifiedThreshold,
            }
          : undefined;
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
          mode: options.reviewMode as ReviewMode | undefined,
          unified: unifiedOverride,
        } as Partial<DRSConfig['review']>,
      } as Partial<DRSConfig>);

      await reviewMR(config, {
        projectId: options.project,
        mrIid: parseInt(options.mr, 10),
        postComments: options.postComments || false,
        postErrorComment: options.postErrorComment || (config.review.postErrorComment ?? false),
        codeQualityReport:
          options.codeQualityReport === true
            ? 'gl-code-quality-report.json'
            : options.codeQualityReport,
        outputPath: options.output,
        jsonOutput: options.json || false,
        baseBranch: options.baseBranch,
        describe:
          options.describe === true
            ? true
            : options.skipDescribe === true
              ? false
              : (config.review.describe?.enabled ?? false),
        postDescription:
          options.postDescription === true
            ? true
            : options.skipPostDescription === true
              ? false
              : (config.review.describe?.postDescription ?? false),
        debug: options.debug || false,
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('review-pr')
  .description('Review a GitHub pull request')
  .requiredOption('--pr <number>', 'Pull request number')
  .requiredOption('--owner <owner>', 'Repository owner (e.g., "octocat")')
  .requiredOption('--repo <repo>', 'Repository name (e.g., "hello-world")')
  .option('--agents <agents>', 'Comma-separated list of review agents')
  .option('--review-mode <mode>', 'Review mode (multi-agent, unified, hybrid)')
  .option('--unified-model <model>', 'Model override for unified review agent')
  .option(
    '--unified-threshold <severity>',
    'Severity threshold for hybrid escalation (LOW, MEDIUM, HIGH, CRITICAL)'
  )
  .option('--post-comments', 'Post review comments to the PR (requires GITHUB_TOKEN)')
  .option('--post-error-comment', 'Post a comment if the review fails (requires GITHUB_TOKEN)')
  .option('--describe', 'Generate PR/MR description during review')
  .option('--skip-describe', 'Skip PR/MR description during review')
  .option('--post-description', 'Post generated description to the PR (requires GITHUB_TOKEN)')
  .option('--skip-post-description', 'Do not post generated description to the PR')
  .option('-o, --output <path>', 'Write review results to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--base-branch <branch>', 'Override base branch used for diff command hints')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .action(async (options) => {
    try {
      // Configure logger based on options
      configureLogger({
        level: options.debug ? 'debug' : 'info',
        format: (options.logFormat as LogFormat) || 'human',
        timestamps: options.logFormat === 'json',
      });

      const unifiedOverride =
        options.unifiedModel || options.unifiedThreshold
          ? {
              model: options.unifiedModel,
              severityThreshold: options.unifiedThreshold,
            }
          : undefined;
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
          mode: options.reviewMode as ReviewMode | undefined,
          unified: unifiedOverride,
        } as Partial<DRSConfig['review']>,
      } as Partial<DRSConfig>);

      await reviewPR(config, {
        owner: options.owner,
        repo: options.repo,
        prNumber: parseInt(options.pr, 10),
        postComments: options.postComments || false,
        postErrorComment: options.postErrorComment || (config.review.postErrorComment ?? false),
        outputPath: options.output,
        jsonOutput: options.json || false,
        baseBranch: options.baseBranch,
        describe:
          options.describe === true
            ? true
            : options.skipDescribe === true
              ? false
              : (config.review.describe?.enabled ?? false),
        postDescription:
          options.postDescription === true
            ? true
            : options.skipPostDescription === true
              ? false
              : (config.review.describe?.postDescription ?? false),
        debug: options.debug || false,
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('describe-pr')
  .description('Generate comprehensive description for a GitHub pull request')
  .requiredOption('--pr <number>', 'Pull request number')
  .requiredOption('--owner <owner>', 'Repository owner (e.g., "octocat")')
  .requiredOption('--repo <repo>', 'Repository name (e.g., "hello-world")')
  .option('--post-description', 'Post generated description to the PR (requires GITHUB_TOKEN)')
  .option('-o, --output <path>', 'Write description to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd());

      await describePR(config, {
        owner: options.owner,
        repo: options.repo,
        prNumber: parseInt(options.pr, 10),
        postDescription: options.postDescription || false,
        outputPath: options.output,
        jsonOutput: options.json || false,
        debug: options.debug || false,
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('describe-mr')
  .description('Generate comprehensive description for a GitLab merge request')
  .requiredOption('--mr <iid>', 'Merge request IID (number)')
  .requiredOption('--project <id>', 'Project ID or path (e.g., "my-org/my-repo" or "123")')
  .option('--post-description', 'Post generated description to the MR (requires GITLAB_TOKEN)')
  .option('-o, --output <path>', 'Write description to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd());

      await describeMR(config, {
        projectId: options.project,
        mrIid: parseInt(options.mr, 10),
        postDescription: options.postDescription || false,
        outputPath: options.output,
        jsonOutput: options.json || false,
        debug: options.debug || false,
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('post-comments')
  .description('Post review comments from a saved review JSON file')
  .requiredOption('-i, --input <path>', 'Path to review JSON file')
  .option('--project <id>', 'GitLab project ID or path (e.g., "my-org/my-repo" or "123")')
  .option('--mr <iid>', 'GitLab merge request IID (number)')
  .option('--owner <owner>', 'GitHub repository owner (e.g., "octocat")')
  .option('--repo <repo>', 'GitHub repository name (e.g., "hello-world")')
  .option('--pr <number>', 'GitHub pull request number')
  .option('--skip-repo-check', 'Skip repository validation')
  .option('--skip-branch-check', 'Skip branch validation')
  .action(async (options) => {
    try {
      await postCommentsFromJson({
        inputPath: options.input,
        projectId: options.project,
        mrIid: options.mr ? parseInt(options.mr, 10) : undefined,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.pr ? parseInt(options.pr, 10) : undefined,
        skipRepoCheck: options.skipRepoCheck || false,
        skipBranchCheck: options.skipBranchCheck || false,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('show-changes')
  .description('Show the diff context passed to agents for a PR/MR')
  .option('--project <id>', 'GitLab project ID or path (e.g., "my-org/my-repo" or "123")')
  .option('--mr <iid>', 'GitLab merge request IID (number)')
  .option('--owner <owner>', 'GitHub repository owner (e.g., "octocat")')
  .option('--repo <repo>', 'GitHub repository name (e.g., "hello-world")')
  .option('--pr <number>', 'GitHub pull request number')
  .option('--file <path>', 'Filter output to a single file path')
  .option('--base-branch <branch>', 'Override base branch used for diff command hints')
  .option('--json', 'Output as JSON instead of raw instructions')
  .option('-o, --output <path>', 'Write output to a file')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd());
      await showChanges(config, {
        projectId: options.project,
        mrIid: options.mr ? parseInt(options.mr, 10) : undefined,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.pr ? parseInt(options.pr, 10) : undefined,
        file: options.file,
        baseBranch: options.baseBranch,
        jsonOutput: options.json || false,
        outputPath: options.output,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('list-agents')
  .description('List available review agents')
  .action(async () => {
    try {
      const { listAgents } = await import('../opencode/agent-loader.js');
      const config = loadConfig(process.cwd());
      const agents = listAgents(process.cwd(), config);

      console.log(chalk.bold('\n📋 Available Review Agents:\n'));

      for (const agent of agents) {
        console.log(chalk.cyan(`  • ${agent}`));
      }

      console.log('');
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Initialize DRS configuration in current project')
  .action(async () => {
    try {
      const { initProject } = await import('./init.js');
      await initProject(process.cwd());
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Print banner if a command is being executed
const isHelpOrVersion = process.argv.some((arg) =>
  ['--version', '-V', '--help', '-h', 'help'].includes(arg)
);
if (process.argv.length > 2 && !isHelpOrVersion) {
  printBanner();
}

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
