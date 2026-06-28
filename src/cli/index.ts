#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runAgent } from './run-agent.js';
import { listWorkflows, showWorkflow, validateWorkflows } from './workflow.js';
import type { WorkflowExecutor } from '../lib/workflow/executor.js';
import { loadConfig } from '../lib/config.js';
import { configureLogger, type LogFormat } from '../lib/logger.js';
import { runTemporalWorker } from '../temporal/worker.js';
import { createWorkflowExecutor } from './workflow-executor-selection.js';
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
  const title = '  DRS - Workflow Runtime';
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
  .description('Workflow-first AI code maintenance for reviews, docs, and repository upkeep')
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
        format: (options.logFormat as LogFormat) ?? 'human',
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
        debug: options.debug ?? false,
        thinkingLevel,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

const workflowCommand = new Command('workflow').description('Run configured maintenance workflows');

workflowCommand
  .command('run [name]')
  .description('Run a workflow by name, or workflow.default when omitted')
  .option('-i, --input <key=value>', 'Set workflow input value', collectOption, [])
  .option('--input-file <key=path>', 'Read workflow input value from a file', collectOption, [])
  .option('-o, --output <path>', 'Write workflow result JSON to a file')
  .option('--json', 'Output workflow result as JSON to console')
  .option('--executor <executor>', 'Workflow executor: local or temporal', 'local')
  .option('--no-wait', 'Dispatch Temporal workflow and return immediately')
  .option('--debug', 'Print Pi runtime configuration for debugging')
  .option('--trace', 'Collect agent traces and save as trace artifact + HTML viewer')
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
        format: (options.logFormat as LogFormat) ?? 'human',
        timestamps: options.logFormat === 'json',
      });

      const config = loadConfig(process.cwd());
      const thinkingLevel = options.ultrathink ? 'high' : options.reasoningEffort;
      const workflowName = name ?? config.workflow?.default;
      if (!workflowName) {
        throw new Error('Provide a workflow name or set workflow.default in .drs/drs.config.yaml.');
      }

      const executor: WorkflowExecutor = createWorkflowExecutor(
        String(options.executor ?? 'local'),
        options.wait !== false
      );
      await executor.run(config, workflowName, {
        inputs: parseKeyValueOptions(options.input, '--input'),
        inputFiles: parseKeyValueOptions(options.inputFile, '--input-file'),
        outputPath: options.output,
        jsonOutput: options.json,
        debug: options.debug ?? false,
        trace: options.trace ?? false,
        thinkingLevel,
        wait: options.wait !== false,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

workflowCommand
  .command('list')
  .description('List available workflows (packaged and project-defined)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const config = loadConfig(process.cwd());
      listWorkflows(config, {
        json: options.json ?? false,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

workflowCommand
  .command('show <name>')
  .alias('get')
  .description('Show workflow details, including inputs and nodes')
  .option('--json', 'Output as JSON')
  .action((name: string, options) => {
    try {
      const config = loadConfig(process.cwd());
      showWorkflow(config, name, {
        json: options.json ?? false,
        workingDir: process.cwd(),
      });
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

workflowCommand
  .command('validate [name]')
  .description('Validate workflow definitions without running them')
  .option('--json', 'Output as JSON')
  .action((name: string | undefined, options) => {
    try {
      const config = loadConfig(process.cwd());
      const results = validateWorkflows(config, name, {
        json: options.json ?? false,
        workingDir: process.cwd(),
      });
      if (results.some((result) => !result.valid)) {
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

const temporalCommand = new Command('temporal').description('Run Temporal workflow workers');

temporalCommand
  .command('worker')
  .description('Run a Temporal worker for DRS workflows')
  .option('--debug', 'Print debug logs')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .action(async (options) => {
    try {
      configureLogger({
        level: options.debug ? 'debug' : 'error',
        format: (options.logFormat as LogFormat) ?? 'human',
        timestamps: options.logFormat === 'json',
      });
      const config = loadConfig(process.cwd());
      await runTemporalWorker(config);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.addCommand(workflowCommand);
program.addCommand(temporalCommand);

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
