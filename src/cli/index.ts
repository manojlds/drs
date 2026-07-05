#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runAgent } from './run-agent.js';
import { listWorkflows, showWorkflow, showWorkflowGraph, validateWorkflows } from './workflow.js';
import type { WorkflowExecutor } from '../lib/workflow/executor.js';
import { loadConfig } from '../lib/config.js';
import { ConversationService } from '../lib/conversation.js';
import { configureLogger, type LogFormat } from '../lib/logger.js';
import { runTemporalWorker } from '../temporal/worker.js';
import { createWorkflowExecutor } from './workflow-executor-selection.js';
import { config as loadDotenv } from 'dotenv';
import {
  addTask,
  getTask,
  listTasks,
  normalizeTaskStatus,
  updateTask,
  validateTaskStore,
  type DrsTask,
} from '../lib/task-store.js';
import {
  createPrd,
  generateStories,
  getPrd,
  importStoriesToTasks,
  listPrds,
  listPrdVersions,
  revertPrdVersion,
  updatePrdMarkdown,
  updatePrdStatus,
  updateStoryReviewStatus,
  type PrdStatus,
  type StoryReviewStatus,
} from '../lib/factory-store.js';
import {
  getSkillStatuses,
  installBundledSkill,
  installFactorySkills,
  listBundledSkills,
  syncBundledSkills,
  type SkillStatus,
} from '../lib/skills.js';
import { getProjectSetupStatus, syncProjectSetup } from '../lib/project-setup.js';

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

function parseCsvOption(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, got ${value}.`);
  return parsed;
}

function printTasks(tasks: DrsTask[]): void {
  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }
  for (const task of tasks) {
    console.log(`${task.id.padEnd(8)} ${task.status.padEnd(14)} P${task.priority}  ${task.title}`);
  }
}

function printTask(task: DrsTask): void {
  console.log(chalk.bold(`${task.id}: ${task.title}`));
  console.log(`Status: ${task.status}`);
  console.log(`Priority: ${task.priority}`);
  if (task.description) console.log(`\n${task.description}`);
  if (task.acceptanceCriteria.length > 0) {
    console.log('\nAcceptance criteria:');
    for (const item of task.acceptanceCriteria) console.log(`- ${item}`);
  }
  if (task.dependsOn.length > 0) console.log(`\nDepends on: ${task.dependsOn.join(', ')}`);
}

function printSkillStatuses(statuses: SkillStatus[]): void {
  if (statuses.length === 0) {
    console.log('No bundled skills found.');
    return;
  }
  for (const status of statuses) {
    const state = !status.installed
      ? 'missing'
      : status.modified
        ? 'modified'
        : status.outdated
          ? 'outdated'
          : 'installed';
    console.log(`${status.name.padEnd(24)} ${state.padEnd(10)} ${status.installedPath}`);
  }
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
  .command('graph <name>')
  .description('Show workflow graph edges as text, JSON, or Mermaid')
  .option('--format <format>', 'Output format: text, json, or mermaid', 'text')
  .action((name: string, options) => {
    try {
      const format = String(options.format ?? 'text');
      if (!['text', 'json', 'mermaid'].includes(format)) {
        throw new Error('Invalid graph format. Expected one of: text, json, mermaid.');
      }
      const config = loadConfig(process.cwd());
      showWorkflowGraph(config, name, {
        format: format as 'text' | 'json' | 'mermaid',
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

program
  .command('chat')
  .description('Ask a question against the latest DRS review/workflow artifacts')
  .option('-p, --prompt <text>', 'Question to ask')
  .option('--factory', 'Use the Factory planning assistant and PRD/story context')
  .option('--prd <id>', 'Factory PRD id to ground the conversation')
  .option('--agent <id>', 'Agent id to use for the conversation')
  .option('--json', 'Output the conversation turn as JSON')
  .option('--debug', 'Print debug logs')
  .option('--log-format <format>', 'Log output format: human (default) or json', 'human')
  .action(async (options) => {
    try {
      configureLogger({
        level: options.debug ? 'debug' : 'error',
        format: (options.logFormat as LogFormat) ?? 'human',
        timestamps: options.logFormat === 'json',
      });

      const prompt = String(options.prompt ?? '').trim();
      if (!prompt) {
        throw new Error('Provide a question with --prompt.');
      }

      const config = loadConfig(process.cwd());
      const service = new ConversationService({ config, workingDir: process.cwd() });
      const conversation = await service.startConversation({
        agent: options.agent,
        subject: options.factory ? { kind: 'factory', prdId: options.prd } : undefined,
      });
      const result = await service.sendMessage({
        conversationId: conversation.id,
        message: prompt,
      });
      await service.closeConversation(conversation.id);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result.response.trim());
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

const taskCommand = new Command('task').description('Manage local DRS work-factory tasks');

taskCommand
  .command('list')
  .description('List local tasks')
  .option('--all', 'Include done/merged/cancelled tasks')
  .option('--json', 'Output tasks as JSON')
  .action(async (options) => {
    try {
      const tasks = await listTasks(process.cwd());
      const visible = options.all
        ? tasks
        : tasks.filter((task) => !['done', 'merged', 'cancelled'].includes(task.status));
      if (options.json) {
        console.log(JSON.stringify({ tasks: visible }, null, 2));
      } else {
        printTasks(visible);
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

taskCommand
  .command('show <id>')
  .description('Show one local task')
  .option('--json', 'Output task as JSON')
  .action(async (id: string, options) => {
    try {
      const task = await getTask(process.cwd(), id);
      if (options.json) console.log(JSON.stringify(task, null, 2));
      else printTask(task);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

taskCommand
  .command('add')
  .description('Add a local task')
  .option('--id <id>', 'Explicit task id')
  .requiredOption('-t, --title <title>', 'Task title')
  .option('-d, --description <description>', 'Task description')
  .option('-s, --status <status>', 'Initial task status', 'open')
  .option('-p, --priority <number>', 'Task priority', parseIntegerOption)
  .option('--acceptance <text>', 'Acceptance criterion', collectOption, [])
  .option('--depends-on <ids>', 'Comma-separated dependency task ids')
  .option('--workflow <name>', 'Preferred workflow name')
  .option('--branch <name>', 'Preferred branch name')
  .option('--json', 'Output created task as JSON')
  .action(async (options) => {
    try {
      const task = await addTask(process.cwd(), {
        id: options.id,
        title: options.title,
        description: options.description,
        status: normalizeTaskStatus(options.status),
        priority: options.priority,
        acceptanceCriteria: options.acceptance ?? [],
        dependsOn: parseCsvOption(options.dependsOn),
        workflow: options.workflow,
        branch: options.branch,
      });
      if (options.json) console.log(JSON.stringify(task, null, 2));
      else console.log(`Added ${task.id}: ${task.title}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

taskCommand
  .command('edit <id>')
  .description('Edit a local task')
  .option('-t, --title <title>', 'Task title')
  .option('-d, --description <description>', 'Task description')
  .option('-s, --status <status>', 'Task status')
  .option('-p, --priority <number>', 'Task priority', parseIntegerOption)
  .option('--acceptance <text>', 'Replace acceptance criteria; repeat for multiple', collectOption)
  .option('--depends-on <ids>', 'Replace dependencies with comma-separated task ids')
  .option('--workflow <name>', 'Preferred workflow name')
  .option('--branch <name>', 'Preferred branch name')
  .option('--json', 'Output updated task as JSON')
  .action(async (id: string, options) => {
    try {
      const task = await updateTask(process.cwd(), id, {
        title: options.title,
        description: options.description,
        status: options.status ? normalizeTaskStatus(options.status) : undefined,
        priority: options.priority,
        acceptanceCriteria: options.acceptance,
        dependsOn: options.dependsOn === undefined ? undefined : parseCsvOption(options.dependsOn),
        workflow: options.workflow,
        branch: options.branch,
      });
      if (options.json) console.log(JSON.stringify(task, null, 2));
      else console.log(`Updated ${task.id}: status=${task.status}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

taskCommand
  .command('validate')
  .description('Validate the local task store')
  .option('--json', 'Output validation result as JSON')
  .action(async (options) => {
    try {
      const result = await validateTaskStore(process.cwd());
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Task store valid (${result.count} task${result.count === 1 ? '' : 's'}).`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.addCommand(taskCommand);

const factoryCommand = new Command('factory').description('Plan PRDs and generate factory tasks');

factoryCommand
  .command('prd-list')
  .alias('list')
  .description('List factory PRDs')
  .option('--json', 'Output PRDs as JSON')
  .action(async (options) => {
    try {
      const prds = await listPrds(process.cwd());
      if (options.json) console.log(JSON.stringify({ prds }, null, 2));
      else if (prds.length === 0) console.log('No PRDs found.');
      else
        for (const prd of prds)
          console.log(`${prd.id.padEnd(28)} ${prd.status.padEnd(8)} ${prd.title}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('prd-create')
  .description('Create a factory PRD markdown artifact')
  .requiredOption('-t, --title <title>', 'PRD title')
  .option('-p, --prompt <prompt>', 'Original planning prompt')
  .option('-m, --markdown <markdown>', 'Initial PRD markdown')
  .option('--json', 'Output PRD as JSON')
  .action(async (options) => {
    try {
      const result = await createPrd(process.cwd(), {
        title: options.title,
        prompt: options.prompt,
        markdown: options.markdown,
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Created PRD ${result.prd.id}: ${result.prd.title}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('prd-show <id>')
  .description('Show a factory PRD with generated stories')
  .option('--json', 'Output PRD as JSON')
  .action(async (id: string, options) => {
    try {
      const result = await getPrd(process.cwd(), id);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(chalk.bold(`${result.prd.id}: ${result.prd.title}`));
        console.log(`Status: ${result.prd.status}`);
        console.log(`Stories: ${result.stories.length}`);
        console.log(`\n${result.markdown}`);
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('prd-update <id>')
  .description('Replace PRD markdown')
  .requiredOption('-m, --markdown <markdown>', 'PRD markdown')
  .option('--json', 'Output PRD as JSON')
  .action(async (id: string, options) => {
    try {
      const result = await updatePrdMarkdown(process.cwd(), id, options.markdown);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Updated PRD ${result.prd.id}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('prd-history <id>')
  .description('List internally versioned PRD markdown writes')
  .option('--json', 'Output versions as JSON')
  .action(async (id: string, options) => {
    try {
      const versions = await listPrdVersions(process.cwd(), id);
      if (options.json) console.log(JSON.stringify({ versions }, null, 2));
      else if (versions.length === 0) console.log('No PRD versions found.');
      else
        for (const version of versions)
          console.log(`${version.id.padEnd(22)} ${version.source.padEnd(8)} ${version.createdAt}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('prd-revert <id> <versionId>')
  .description('Revert PRD markdown to an earlier version')
  .option('--json', 'Output PRD as JSON')
  .action(async (id: string, versionId: string, options) => {
    try {
      const result = await revertPrdVersion(process.cwd(), id, versionId);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Reverted PRD ${result.prd.id} to ${versionId}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('prd-status <id> <status>')
  .description('Set PRD review/lifecycle status')
  .option('--json', 'Output PRD as JSON')
  .action(async (id: string, status: string, options) => {
    try {
      const result = await updatePrdStatus(process.cwd(), id, status as PrdStatus);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Updated PRD ${result.prd.id}: status=${result.prd.status}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('stories-generate <prdId>')
  .description('Generate reviewable stories from PRD markdown')
  .option('--json', 'Output stories as JSON')
  .action(async (prdId: string, options) => {
    try {
      const result = await generateStories(process.cwd(), prdId);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Generated ${result.stories.length} stories for ${result.prd.id}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('stories-import <prdId>')
  .description('Import generated PRD stories into the task backlog')
  .option('--json', 'Output imported tasks as JSON')
  .action(async (prdId: string, options) => {
    try {
      const tasks = await importStoriesToTasks(process.cwd(), prdId);
      if (options.json) console.log(JSON.stringify({ tasks }, null, 2));
      else console.log(`Imported ${tasks.length} tasks from ${prdId}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

factoryCommand
  .command('story-status <prdId> <storyId> <status>')
  .description('Set story review status')
  .option('--json', 'Output PRD as JSON')
  .action(async (prdId: string, storyId: string, status: string, options) => {
    try {
      const result = await updateStoryReviewStatus(
        process.cwd(),
        prdId,
        storyId,
        status as StoryReviewStatus
      );
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Updated story ${storyId}: status=${status}`);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.addCommand(factoryCommand);

const skillsCommand = new Command('skills').description('Manage project-installed DRS skills');

skillsCommand
  .command('list')
  .description('List bundled DRS skills')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const skills = listBundledSkills();
      if (options.json) console.log(JSON.stringify({ skills }, null, 2));
      else for (const skill of skills) console.log(skill);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

skillsCommand
  .command('status')
  .description('Show installed status for bundled DRS skills')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const statuses = getSkillStatuses(process.cwd());
      if (options.json) console.log(JSON.stringify({ skills: statuses }, null, 2));
      else printSkillStatuses(statuses);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

skillsCommand
  .command('install [name]')
  .description('Install a bundled DRS skill into .agents/skills')
  .option('--factory', 'Install Factory skills')
  .option('--all', 'Install all bundled skills')
  .option('--force', 'Overwrite existing skill files')
  .option('--json', 'Output as JSON')
  .action((name: string | undefined, options) => {
    try {
      let statuses: SkillStatus[];
      if (options.all) {
        statuses = listBundledSkills().map((skill) =>
          installBundledSkill(process.cwd(), skill, { force: options.force ?? false })
        );
      } else if (options.factory) {
        statuses = installFactorySkills(process.cwd(), { force: options.force ?? false });
      } else if (name) {
        statuses = [installBundledSkill(process.cwd(), name, { force: options.force ?? false })];
      } else {
        throw new Error('Provide a skill name, --factory, or --all.');
      }
      if (options.json) console.log(JSON.stringify({ skills: statuses }, null, 2));
      else printSkillStatuses(statuses);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

skillsCommand
  .command('sync')
  .description('Update DRS-managed installed skills when they have no local changes')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const statuses = syncBundledSkills(process.cwd());
      if (options.json) console.log(JSON.stringify({ skills: statuses }, null, 2));
      else printSkillStatuses(statuses);
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.addCommand(skillsCommand);

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
  .option('-y, --yes', 'Use non-interactive defaults')
  .option('--force', 'Overwrite existing project config')
  .action(async (options) => {
    try {
      const { initProject } = await import('./init.js');
      await initProject(process.cwd(), {
        yes: options.yes ?? false,
        force: options.force ?? false,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Check DRS project setup without modifying files')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const status = getProjectSetupStatus(process.cwd());
      if (options.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`Config: ${status.initialized ? 'present' : 'missing'} (${status.configPath})`);
        printSkillStatuses(status.skills);
        if (status.issues.length > 0) {
          console.log(`Issues: ${status.issues.join(', ')}`);
        } else {
          console.log('DRS project setup looks good.');
        }
      }
      process.exit(status.initialized ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Safely sync DRS-managed project assets')
  .option('--json', 'Output as JSON')
  .action((options) => {
    try {
      const status = syncProjectSetup(process.cwd());
      if (options.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`Config: ${status.initialized ? 'present' : 'missing'} (${status.configPath})`);
        printSkillStatuses(status.skills);
        if (status.issues.length > 0) console.log(`Issues: ${status.issues.join(', ')}`);
      }
      process.exit(status.initialized ? 0 : 1);
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
