import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { Connection, Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import type { DRSConfig } from '../lib/config.js';
import { getLogger } from '../lib/logger.js';
import { resolveWithinWorkingDir } from '../lib/path-utils.js';
import { saveWorkflowArtifact } from '../lib/workflow-artifacts.js';
import { compileWorkflowPlan, type CompiledWorkflowInput } from '../lib/workflow/compiled-plan.js';
import type { WorkflowExecutor } from '../lib/workflow/executor.js';
import { normalizeWorkflowBooleanLike } from '../lib/workflow/planning.js';
import type { WorkflowRunOptions, WorkflowRunResult } from '../lib/workflow/types.js';
import { resolveTemporalConfig } from './config.js';
import { deriveTemporalWorkflowId } from './workflow-id.js';
import type { TemporalManagedWorkspaceInput, TemporalWorkflowInput } from './types.js';

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

interface TemporalWorkflowTracePayload {
  schemaVersion: 1;
  executor: 'temporal';
  workflowName: string;
  temporal: {
    workflowId: string;
    runId: string;
    namespace: string;
    taskQueue: string;
  };
  startedAt: string;
  completedAt: string;
  inputs: Record<string, string>;
  nodes: WorkflowRunResult['nodes'];
  artifacts: WorkflowRunResult['artifacts'];
  loop: WorkflowRunResult['loop'];
  output: WorkflowRunResult['output'];
}

async function saveTemporalWorkflowTrace(
  workingDir: string,
  workflowName: string,
  startedAt: string,
  result: WorkflowRunResult,
  temporal: { namespace: string; taskQueue: string },
  handle: { workflowId: string; firstExecutionRunId: string },
  options: WorkflowRunOptions
): Promise<void> {
  const saved = await saveWorkflowArtifact<TemporalWorkflowTracePayload>(workingDir, {
    kind: 'trace',
    scope: {
      platform: 'temporal',
      projectId: workflowName,
      subject: 'workflow',
    },
    payload: {
      schemaVersion: 1,
      executor: 'temporal',
      workflowName,
      temporal: {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
        namespace: temporal.namespace,
        taskQueue: temporal.taskQueue,
      },
      startedAt,
      completedAt: new Date().toISOString(),
      inputs: result.inputs,
      nodes: result.nodes,
      artifacts: result.artifacts,
      loop: result.loop,
      output: result.output,
    },
  });

  if (!options.jsonOutput) {
    console.log(chalk.green(`\n✓ Temporal trace saved to ${saved.latestPath}`));
  }
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

async function resolveManagedWorkspaceInput(
  workingDir: string,
  temporal: ReturnType<typeof resolveTemporalConfig>
): Promise<TemporalManagedWorkspaceInput | undefined> {
  if (temporal.workspace.mode !== 'managed') {
    return undefined;
  }

  const git = simpleGit(workingDir);
  const configuredRepoUrl = process.env.DRS_TEMPORAL_WORKSPACE_REPO_URL;
  const repoUrl = configuredRepoUrl ?? String(await git.remote(['get-url', 'origin']));
  const ref = process.env.DRS_TEMPORAL_WORKSPACE_REF ?? (await git.revparse(['HEAD']));

  return {
    mode: 'managed',
    root: temporal.workspace.root,
    repoUrl: repoUrl.trim(),
    ref: ref.trim(),
  };
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
    const logger = getLogger();
    const startedAt = new Date().toISOString();

    const connection = await Connection.connect({ address: temporal.address });
    try {
      const client = new Client({ connection, namespace: temporal.namespace });
      const workflowId =
        options.workflowId ??
        deriveTemporalWorkflowId(temporal.workflowIdPrefix, workflowName, inputs);
      const workspace = await resolveManagedWorkspaceInput(workingDir, temporal);
      const workflowInput: TemporalWorkflowInput = {
        plan,
        inputs,
        workingDir,
        options: {
          debug: options.debug,
          thinkingLevel: options.thinkingLevel,
        },
        ...(workspace ? { workspace } : {}),
      };

      let handle: Awaited<ReturnType<typeof client.workflow.start>>;
      let isDuplicate = false;
      try {
        handle = await client.workflow.start('drsWorkflow', {
          taskQueue: temporal.taskQueue,
          workflowId,
          args: [workflowInput],
        });
      } catch (error) {
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          isDuplicate = true;
          handle = client.workflow.getHandle(workflowId) as Awaited<
            ReturnType<typeof client.workflow.start>
          >;
          logger.debug('Temporal workflow already running — joining existing run', {
            component: 'temporal-executor',
            workflow: workflowName,
            workflowId,
            namespace: temporal.namespace,
            taskQueue: temporal.taskQueue,
          });
        } else {
          throw error;
        }
      }
      const runId = handle.firstExecutionRunId ?? '';
      const logContext = {
        component: 'temporal-executor',
        workflow: workflowName,
        workflowId: handle.workflowId,
        runId,
        namespace: temporal.namespace,
        taskQueue: temporal.taskQueue,
        ...(isDuplicate ? { duplicate: true } : {}),
      };

      logger.debug(
        isDuplicate ? 'Temporal workflow already running' : 'Temporal workflow started',
        logContext
      );

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
            runId,
          },
        };
        if (options.jsonOutput) {
          console.log(formatWorkflowJson(result));
        } else {
          console.log(
            `Temporal workflow ${isDuplicate ? 'already running' : 'started'}: ${handle.workflowId}${runId ? ` (run ${runId})` : ''}`
          );
        }
        return result;
      }

      const result = await handle.result();
      logger.debug('Temporal workflow completed', logContext);

      if (options.trace) {
        await saveTemporalWorkflowTrace(
          workingDir,
          workflowName,
          startedAt,
          result,
          temporal,
          { workflowId: handle.workflowId, firstExecutionRunId: runId },
          options
        );
      }

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
    } finally {
      await connection.close();
    }
  }
}
