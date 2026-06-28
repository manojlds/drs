import { mkdir, readFile, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { Connection, Client } from '@temporalio/client';
import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import { resolveWithinWorkingDir } from '../lib/path-utils.js';
import { compileWorkflowPlan, type CompiledWorkflowInput } from '../lib/workflow/compiled-plan.js';
import type { WorkflowExecutor } from '../lib/workflow/executor.js';
import { normalizeWorkflowBooleanLike } from '../lib/workflow/planning.js';
import type { WorkflowRunOptions, WorkflowRunResult } from '../lib/workflow/types.js';
import { resolveTemporalConfig } from './config.js';
import type { TemporalWorkflowInput } from './types.js';

async function writeWorkflowFile(
  workingDir: string,
  outputPath: string,
  content: string
): Promise<void> {
  const resolved = resolveWithinWorkingDir(workingDir, outputPath, 'write');
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf-8');
}

function formatWorkflowJson(result: WorkflowRunResult): string {
  return JSON.stringify(result, null, 2);
}

function validateResolvedWorkflowInput(
  key: string,
  input: CompiledWorkflowInput,
  value: string
): void {
  if (input.required === true && value.trim() === '') {
    throw new Error(`Workflow input "${key}" is required.`);
  }

  if (input.type === 'boolean') {
    if (normalizeWorkflowBooleanLike(value) === undefined) {
      throw new Error(`Workflow input "${key}" must be a boolean value.`);
    }
    return;
  }

  if (input.type === 'number') {
    if (value.trim() === '' || !Number.isFinite(Number(value))) {
      throw new Error(`Workflow input "${key}" must be a number.`);
    }
    return;
  }

  if (input.type === 'enum') {
    const allowedValues = input.values?.map(String) ?? [];
    if (allowedValues.length === 0) {
      throw new Error(`Workflow input "${key}" with type enum must define values.`);
    }
    if (!allowedValues.includes(value)) {
      throw new Error(`Workflow input "${key}" must be one of: ${allowedValues.join(', ')}.`);
    }
    return;
  }

  if (input.type !== 'string') {
    throw new Error(`Workflow input "${key}" has unsupported type "${input.type}".`);
  }
}

async function resolveCompiledPlanInputs(
  inputs: Record<string, CompiledWorkflowInput>,
  options: WorkflowRunOptions,
  workingDir: string
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};

  for (const [key, input] of Object.entries(inputs)) {
    const hasValue = input.value !== undefined || input.default !== undefined;
    const hasFile = input.file !== undefined;
    if (hasValue && hasFile) {
      throw new Error(`Workflow input "${key}" cannot define both value/default and file.`);
    }
    if (hasValue) {
      values[key] = String(input.value ?? input.default ?? '');
    } else if (hasFile) {
      const inputPath = resolveWithinWorkingDir(workingDir, input.file ?? '', 'read');
      values[key] = await readFile(inputPath, 'utf-8');
    } else {
      values[key] = '';
    }
  }

  for (const [key, value] of Object.entries(options.inputs ?? {})) {
    values[key] = value;
  }

  for (const [key, filePath] of Object.entries(options.inputFiles ?? {})) {
    const resolvedPath = resolveWithinWorkingDir(workingDir, filePath, 'read');
    values[key] = await readFile(resolvedPath, 'utf-8');
  }

  for (const [key, input] of Object.entries(inputs)) {
    validateResolvedWorkflowInput(key, input, values[key] ?? '');
  }

  return values;
}

export class TemporalWorkflowExecutor implements WorkflowExecutor {
  async run(
    config: DRSConfig,
    workflowName: string,
    options: WorkflowRunOptions = {}
  ): Promise<WorkflowRunResult> {
    const workingDir = options.workingDir ?? process.cwd();
    const temporal = resolveTemporalConfig(config);
    const plan = compileWorkflowPlan(config, workflowName, { workingDir });
    const inputs = await resolveCompiledPlanInputs(plan.inputs, options, workingDir);

    const connection = await Connection.connect({ address: temporal.address });
    const client = new Client({ connection, namespace: temporal.namespace });
    const workflowId = `${temporal.workflowIdPrefix}-${workflowName}-${randomUUID()}`;
    const workflowInput: TemporalWorkflowInput = {
      plan,
      inputs,
      workingDir,
      options: {
        debug: options.debug,
        thinkingLevel: options.thinkingLevel,
      },
    };

    const handle = await client.workflow.start('drsWorkflow', {
      taskQueue: temporal.taskQueue,
      workflowId,
      args: [workflowInput],
    });

    if (options.wait === false) {
      const result: WorkflowRunResult = {
        timestamp: new Date().toISOString(),
        workflow: workflowName,
        inputs,
        nodes: {},
        artifacts: {},
        loop: {},
        output: {
          workflowId: handle.workflowId,
          runId: handle.firstExecutionRunId,
        },
      };
      if (options.jsonOutput) {
        console.log(formatWorkflowJson(result));
      } else {
        console.log(
          `Temporal workflow started: ${handle.workflowId} (run ${handle.firstExecutionRunId})`
        );
      }
      return result;
    }

    const result = await handle.result();

    if (options.outputPath) {
      await writeWorkflowFile(workingDir, options.outputPath, formatWorkflowJson(result));
      if (!options.jsonOutput) {
        console.log(chalk.green(`\n✓ Workflow output saved to ${options.outputPath}`));
      }
    }

    if (options.jsonOutput) {
      console.log(formatWorkflowJson(result));
    } else if (typeof result.output === 'string' && result.output.trim()) {
      console.log(`\n${result.output}`);
    }

    return result;
  }
}
