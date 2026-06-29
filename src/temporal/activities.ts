import { Context } from '@temporalio/activity';
import { loadConfig } from '../lib/config.js';
import { runWorkflowNodeLocally } from '../cli/workflow.js';
import { getLogger } from '../lib/logger.js';
import {
  type ArtifactInliningPolicy,
  isArtifactRef,
  shouldInline,
  LocalWorkflowArtifactStore,
} from '../lib/workflow/artifact-store.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from '../lib/workflow/types.js';
import type { ActivityIdempotencyContext, RunWorkflowNodeActivityInput } from './types.js';

export interface HydrateContextActivityInput {
  workingDir: string;
  context: WorkflowTemplateContext;
}

function serializedSize(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf-8');
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf-8');
}

function getCurrentActivityAttempt(): number | undefined {
  try {
    return Context.current().info.attempt;
  } catch {
    return undefined;
  }
}

export function resolveActivityIdempotencyContext(
  input: RunWorkflowNodeActivityInput
): ActivityIdempotencyContext | undefined {
  const scheduled = input.idempotencyContext;
  if (!scheduled) return undefined;

  return {
    workflowId: scheduled.workflowId,
    runId: scheduled.runId,
    nodeId: scheduled.nodeId,
    attempt: getCurrentActivityAttempt() ?? scheduled.attempt ?? 1,
    idempotencyKey: scheduled.idempotencyKey,
  };
}

/**
 * Run the activity: executes one node locally, then offloads large outputs
 * to the artifact store so Temporal history only carries refs.
 */
export async function runWorkflowNodeActivity(
  input: RunWorkflowNodeActivityInput
): Promise<WorkflowNodeResult> {
  const config = loadConfig(input.workingDir);
  const idempotencyContext = resolveActivityIdempotencyContext(input);
  const startedAt = Date.now();
  const logContext = {
    component: 'temporal-activity',
    workflowId: idempotencyContext?.workflowId,
    runId: idempotencyContext?.runId,
    nodeId: input.nodeId,
    attempt: idempotencyContext?.attempt,
    action: input.node.action,
    agent: input.node.agent,
  };
  const logger = getLogger();

  logger.debug('Temporal activity started', logContext);

  // Hydrate artifact refs in the node context so template rendering can
  // access actual artifact values. The workflow passes hydrated artifacts,
  // but hydrating here makes the activity resilient when called directly.
  const store = new LocalWorkflowArtifactStore(input.workingDir, input.nodeId);
  try {
    await hydrateContext(input.context.artifacts, store);

    const result = await runWorkflowNodeLocally(
      config,
      input.nodeId,
      input.node,
      {
        debug: input.options?.debug,
        thinkingLevel: input.options?.thinkingLevel,
        idempotencyContext,
        workingDir: input.workingDir,
        jsonOutput: true,
        trace: false,
      },
      input.workingDir,
      input.context
    );

    const finalResult = input.offloadArtifacts
      ? await offloadNodeResult(result, input.nodeId, store, {
          mode: 'ref-large-values',
          inlineMaxBytes: input.artifactInlineMaxBytes ?? 64 * 1024,
        })
      : result;

    logger.debug('Temporal activity completed', logContext, {
      durationMs: Date.now() - startedAt,
      status: finalResult.status ?? 'success',
    });

    return finalResult;
  } catch (error) {
    logger.error('Temporal activity failed', logContext, {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function offloadNodeResult(
  result: WorkflowNodeResult,
  nodeId: string,
  store: LocalWorkflowArtifactStore,
  policy: ArtifactInliningPolicy
): Promise<WorkflowNodeResult> {
  const offloaded = { ...result };

  for (const field of ['output', 'response'] as const) {
    const value = offloaded[field];
    if (value !== undefined && value !== null && !isArtifactRef(value)) {
      if (!shouldInline(serializedSize(value), policy)) {
        const ref = await store.put(`${nodeId}-${field}`, value);
        (offloaded as Record<string, unknown>)[field] = ref;
      }
    }
  }

  if (offloaded.outputs) {
    const newOutputs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(offloaded.outputs)) {
      if (
        value !== undefined &&
        value !== null &&
        !isArtifactRef(value) &&
        !shouldInline(serializedSize(value), policy)
      ) {
        const ref = await store.put(`${nodeId}-outputs-${name}`, value);
        newOutputs[name] = ref;
      } else {
        newOutputs[name] = value;
      }
    }
    offloaded.outputs = newOutputs;
  }

  if (offloaded.responses && Array.isArray(offloaded.responses)) {
    const offloadedResponses = await Promise.all(
      offloaded.responses.map(async (entry, index) => {
        if (entry === null || entry === undefined || isArtifactRef(entry)) return entry;
        if (shouldInline(serializedSize(entry), policy)) return entry;
        const ref = await store.put(`${nodeId}-responses-${index}`, entry);
        return ref;
      })
    );
    (offloaded as unknown as Record<string, unknown>).responses = offloadedResponses;
  }

  return offloaded;
}

/**
 * Hydrate artifact refs within a template context. Called by the Temporal
 * workflow before each wave so node template rendering can access prior
 * artifact values. Returns a new context because activities receive a
 * deserialized copy of the workflow's input; mutations do not propagate back.
 */
export async function hydrateContextActivity(
  input: HydrateContextActivityInput
): Promise<WorkflowTemplateContext> {
  const store = new LocalWorkflowArtifactStore(input.workingDir, 'temporal');
  const hydratedArtifacts: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input.context.artifacts)) {
    if (isArtifactRef(value)) {
      hydratedArtifacts[key] = await store.get(value);
    } else {
      hydratedArtifacts[key] = value;
    }
  }

  return {
    ...input.context,
    artifacts: hydratedArtifacts,
  };
}

/**
 * Hydrate artifact refs within a template context before rendering node
 * templates in the worker process. Called by activities that need to read
 * prior artifact values.
 */
export async function hydrateContext(
  context: Record<string, unknown>,
  store: LocalWorkflowArtifactStore
): Promise<void> {
  for (const [key, value] of Object.entries(context)) {
    if (isArtifactRef(value)) {
      context[key] = await store.get(value);
    }
  }
}
