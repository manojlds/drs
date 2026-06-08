#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { postCommentsFromJson } from './post-comments.js';
import { showChanges } from './show-changes.js';
import { runAgent } from './run-agent.js';
import { runWorkflow } from './workflow.js';
import { loadConfig } from '../lib/config.js';
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

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseKeyValueOptions(
  values: string[] | undefined,
  optionName: string
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const value of values ?? []) {
    const separatorIndex = value.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`${optionName} must use key=value format.`);
    }
    parsed[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1);
  }
  return parsed;
}

const program = new Command();

program
  .name('drs')
  .description('Automated AI code reviews for GitHub pull requests and GitLab merge requests')
  .version(version);

program
  .command('run-agent <agentId>')
  .alias('run')
  .description('Run any configured agent by fully qualified ID')
  .option('-p, --prompt <text>', 'Prompt text to send to the agent')
  .option('-f, --file <path>', 'Read prompt text from a file')
  .option('--stdin', 'Read prompt text from standard input')
  .option('--model <model>', 'Model override for this run')
  .option('-o, --output <path>', 'Write agent response to a file')
  .option('--json', 'Output result as JSON to console')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .option(
    '--reasoning-effort <level>',
    'Reasoning effort level: off, minimal, low, medium, high, xhigh'
  )
  .option('--ultrathink', 'Enable maximum reasoning effort (alias for --reasoning-effort high)')
  .action(async (agentId, options) => {
    try {
      configureLogger({
        level: options.debug ? 'debug' : 'error',
        format: (options.logFormat as LogFormat) || 'human',
        timestamps: options.logFormat === 'json',
      });

      const config = loadConfig(process.cwd());
      const thinkingLevel = options.ultrathink ? 'high' : options.reasoningEffort;

      await runAgent(config, agentId, {
        prompt: options.prompt,
        file: options.file,
        stdin: options.stdin,
        model: options.model,
        outputPath: options.output,
        jsonOutput: options.json,
        debug: options.debug || false,
        thinkingLevel,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

const workflowCommand = new Command('workflow').description('Run configured workflows');

workflowCommand
  .command('run [name]')
  .description('Run a workflow by name, or workflow.default when omitted')
  .option('-i, --input <key=value>', 'Set workflow input value', collectOption, [])
  .option('--input-file <key=path>', 'Read workflow input value from a file', collectOption, [])
  .option('-o, --output <path>', 'Write workflow result JSON to a file')
  .option('--json', 'Output workflow result as JSON to console')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .option(
    '--reasoning-effort <level>',
    'Reasoning effort level: off, minimal, low, medium, high, xhigh'
  )
  .option('--ultrathink', 'Enable maximum reasoning effort (alias for --reasoning-effort high)')
  .action(async (name: string | undefined, options) => {
    try {
      configureLogger({
        level: options.debug ? 'debug' : 'error',
        format: (options.logFormat as LogFormat) || 'human',
        timestamps: options.logFormat === 'json',
      });

      const config = loadConfig(process.cwd());
      const thinkingLevel = options.ultrathink ? 'high' : options.reasoningEffort;
      const workflowName = name ?? config.workflow?.default;
      if (!workflowName) {
        throw new Error('Provide a workflow name or set workflow.default in .drs/drs.config.yaml.');
      }

      await runWorkflow(config, workflowName, {
        inputs: parseKeyValueOptions(options.input, '--input'),
        inputFiles: parseKeyValueOptions(options.inputFile, '--input-file'),
        outputPath: options.output,
        jsonOutput: options.json,
        debug: options.debug || false,
        thinkingLevel,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.addCommand(workflowCommand);

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
  .option('--fix-in-cursor', 'Add Fix in Cursor deeplinks to posted review comments')
  .option('--skip-fix-in-cursor', 'Do not add Fix in Cursor deeplinks to posted comments')
  .action(async (options) => {
    try {
      const config = loadConfig(process.cwd());

      await postCommentsFromJson({
        config,
        inputPath: options.input,
        projectId: options.project,
        mrIid: options.mr ? parseInt(options.mr, 10) : undefined,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.pr ? parseInt(options.pr, 10) : undefined,
        skipRepoCheck: options.skipRepoCheck || false,
        skipBranchCheck: options.skipBranchCheck || false,
        fixInCursor: options.fixInCursor,
        skipFixInCursor: options.skipFixInCursor,
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
  .description('List available agents')
  .action(async () => {
    try {
      const { listAgents } = await import('../runtime/agent-loader.js');
      const config = loadConfig(process.cwd());
      const agents = listAgents(process.cwd(), config);

      console.log(chalk.bold('\n📋 Available Agents:\n'));

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
const isJsonOutput = process.argv.includes('--json');
const isRunAgentCommand = process.argv[2] === 'run-agent' || process.argv[2] === 'run';
if (process.argv.length > 2 && !isHelpOrVersion && !isJsonOutput && !isRunAgentCommand) {
  printBanner();
}

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
