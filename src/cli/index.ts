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
import { loadConfig } from '../lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJsonPath = join(__dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

const program = new Command();

function getDiffAnalyzerOverride(): boolean | undefined {
  if (process.argv.includes('--no-diff-analyzer')) {
    return false;
  }
  if (process.argv.includes('--diff-analyzer')) {
    return true;
  }
  return undefined;
}

program
  .name('drs')
  .description('Intelligent code review platform for GitLab and GitHub - Enterprise-grade analysis')
  .version(version);

program
  .command('review-local')
  .description('Review local git diff before pushing')
  .option('--staged', 'Review staged changes only (git diff --cached)')
  .option('--agents <agents>', 'Comma-separated list of review agents')
  .option('-o, --output <path>', 'Write review results to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--no-diff-analyzer', 'Disable diff analyzer')
  .option('--context-only', 'Run diff analyzer only and skip review agents')
  .option('--context-output <path>', 'Write diff context JSON to file')
  .option('--context-read <path>', 'Read diff context JSON from file and skip analyzer')
  .option('--debug', 'Print OpenCode configuration for debugging')
  .action(async (options) => {
    try {
      const diffAnalyzerOverride = getDiffAnalyzerOverride();
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
          enableDiffAnalyzer: diffAnalyzerOverride,
        },
      } as any);

      await reviewLocal(config, {
        staged: options.staged || false,
        outputPath: options.output,
        jsonOutput: options.json || false,
        contextOnly: options.contextOnly || false,
        contextOutputPath: options.contextOutput,
        contextReadPath: options.contextRead,
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
  .option('--post-comments', 'Post review comments to the MR (requires GITLAB_TOKEN)')
  .option(
    '--code-quality-report <path>',
    'Generate GitLab code quality report JSON file (default: gl-code-quality-report.json)'
  )
  .option('-o, --output <path>', 'Write review results to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--base-branch <branch>', 'Override base branch used for diff command hints')
  .option('--no-diff-analyzer', 'Disable diff analyzer')
  .option('--context-only', 'Run diff analyzer only and skip review agents/comments')
  .option('--context-output <path>', 'Write diff context JSON to file')
  .option('--context-read <path>', 'Read diff context JSON from file and skip analyzer')
  .option('--debug', 'Print OpenCode configuration for debugging')
  .action(async (options) => {
    try {
      const diffAnalyzerOverride = getDiffAnalyzerOverride();
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
          enableDiffAnalyzer: diffAnalyzerOverride,
        },
      } as any);

      await reviewMR(config, {
        projectId: options.project,
        mrIid: parseInt(options.mr, 10),
        postComments: options.postComments || false,
        codeQualityReport:
          options.codeQualityReport === true
            ? 'gl-code-quality-report.json'
            : options.codeQualityReport,
        outputPath: options.output,
        jsonOutput: options.json || false,
        baseBranch: options.baseBranch,
        contextOnly: options.contextOnly || false,
        contextOutputPath: options.contextOutput,
        contextReadPath: options.contextRead,
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
  .option('--post-comments', 'Post review comments to the PR (requires GITHUB_TOKEN)')
  .option('-o, --output <path>', 'Write review results to JSON file')
  .option('--json', 'Output results as JSON to console')
  .option('--base-branch <branch>', 'Override base branch used for diff command hints')
  .option('--no-diff-analyzer', 'Disable diff analyzer')
  .option('--context-only', 'Run diff analyzer only and skip review agents/comments')
  .option('--context-output <path>', 'Write diff context JSON to file')
  .option('--context-read <path>', 'Read diff context JSON from file and skip analyzer')
  .option('--debug', 'Print OpenCode configuration for debugging')
  .action(async (options) => {
    try {
      const diffAnalyzerOverride = getDiffAnalyzerOverride();
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
          enableDiffAnalyzer: diffAnalyzerOverride,
        },
      } as any);

      await reviewPR(config, {
        owner: options.owner,
        repo: options.repo,
        prNumber: parseInt(options.pr, 10),
        postComments: options.postComments || false,
        outputPath: options.output,
        jsonOutput: options.json || false,
        baseBranch: options.baseBranch,
        contextOnly: options.contextOnly || false,
        contextOutputPath: options.contextOutput,
        contextReadPath: options.contextRead,
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
  .option('--skip-repo-check', 'Skip repository and branch validation')
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
      const agents = listAgents(process.cwd());

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

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
