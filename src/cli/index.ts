#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { reviewLocal } from './review-local.js';
import { reviewMR } from './review-mr.js';
import { reviewPR } from './review-pr.js';
import { loadConfig } from '../lib/config.js';

const program = new Command();

program
  .name('drs')
  .description('Intelligent code review platform for GitLab and GitHub - Enterprise-grade analysis')
  .version('1.0.0');

program
  .command('review-local')
  .description('Review local git diff before pushing')
  .option('--staged', 'Review staged changes only (git diff --cached)')
  .option('--agents <agents>', 'Comma-separated list of review agents (default: security,quality)')
  .option('--format <format>', 'Output format: terminal, json, markdown', 'terminal')
  .option('--verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
        },
        output: {
          format: options.format,
          verbosity: options.verbose ? 'detailed' : 'normal',
        },
      } as any);

      await reviewLocal(config, {
        staged: options.staged || false,
      });
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
  .option('--verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
        },
        output: {
          verbosity: options.verbose ? 'detailed' : 'normal',
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
      });
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
  .option('--verbose', 'Verbose output')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd(), {
        review: {
          agents: options.agents
            ? options.agents.split(',').map((a: string) => a.trim())
            : undefined,
        },
        output: {
          verbosity: options.verbose ? 'detailed' : 'normal',
        },
      } as any);

      await reviewPR(config, {
        owner: options.owner,
        repo: options.repo,
        prNumber: parseInt(options.pr, 10),
        postComments: options.postComments || false,
      });
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
