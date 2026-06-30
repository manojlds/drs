import {
  defineQuery,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import {
  computeActiveWorkflowNodes,
  createSkippedWorkflowNodeResult,
  findWorkflowSegmentIndex,
  getNodeNeeds,
  getWorkflowNodeSkipReason,
  runControlWorkflowNode,
  type WorkflowSegment,
} from '../lib/workflow/planning.js';
import type { WorkflowNodeConfig } from '../lib/config.js';
import type { CompiledWorkflowSegment } from '../lib/workflow/compiled-plan.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from '../lib/workflow/types.js';
import { isArtifactRef, type TemporalArtifactRef } from '../lib/workflow/artifact-store.js';
import { getTemporalNodeRetryMode, TEMPORAL_RETRYABLE_ACTIVITY_POLICY } from './retry-policy.js';
import type {
  ScheduledActivityIdempotencyContext,
  TemporalWorkflowArtifactsQueryResult,
  TemporalWorkflowInput,
  TemporalWorkflowStatusQueryResult,
  TemporalWorkflowResult,
} from './types.js';

export const workflowStatusQuery =
  defineQuery<TemporalWorkflowStatusQueryResult>('drsWorkflowStatus');
export const workflowLoopStateQuery =
  defineQuery<WorkflowTemplateContext['loop']>('drsWorkflowLoopState');
export const workflowArtifactsQuery =
  defineQuery<TemporalWorkflowArtifactsQueryResult>('drsWorkflowArtifacts');

const { runWorkflowNodeActivity, resolveArtifactRefsActivity, prepareWorkspaceActivity } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: '30 minutes',
    // Bound total time across all retries so a persistently failing activity
    // fails the workflow instead of retrying indefinitely. 3 hours comfortably
    // allows 5 attempts at up to 30 minutes each plus backoff.
    scheduleToCloseTimeout: '3 hours',
    retry: TEMPORAL_RETRYABLE_ACTIVITY_POLICY,
  });

const { runWorkflowNodeActivity: runWorkflowNodeNoRetryActivity } = proxyActivities<
  typeof activities
>({
  startToCloseTimeout: '30 minutes',
  retry: {
    maximumAttempts: 1,
  },
});

function recordNodeArtifact(
  nodeId: string,
  node: WorkflowNodeConfig,
  result: WorkflowNodeResult,
  artifacts: Record<string, unknown>
): void {
  const artifactValue = result.output ?? result.response ?? result.responses;
  artifacts[nodeId] = artifactValue;
  if (node.output) {
    artifacts[node.output] = artifactValue;
  }
  if (result.outputs) {
    for (const [name, value] of Object.entries(result.outputs)) {
      artifacts[name] = value;
    }
  }
}

function recordWorkflowNodeResult(
  nodeId: string,
  node: WorkflowNodeConfig,
  result: WorkflowNodeResult,
  nodes: Record<string, WorkflowNodeResult>,
  artifacts: Record<string, unknown>
): void {
  result.status ??= 'success';
  nodes[nodeId] = result;
  if (result.status !== 'skipped') {
    recordNodeArtifact(nodeId, node, result, artifacts);
  }
}

function buildWorkflowStatusSnapshot(
  input: TemporalWorkflowInput,
  context: WorkflowTemplateContext,
  runningNodeIds: Set<string>,
  isCancelled: boolean
): TemporalWorkflowStatusQueryResult {
  const nodes: TemporalWorkflowStatusQueryResult['nodes'] = {};

  for (const [nodeId, node] of Object.entries(input.plan.nodes)) {
    const result = context.nodes[nodeId];
    nodes[nodeId] = {
      id: nodeId,
      status: runningNodeIds.has(nodeId) ? 'running' : (result?.status ?? 'pending'),
      action: node.action,
      agent: node.agent,
      control: node.control,
    };
  }

  const info = workflowInfo();
  return {
    workflow: input.plan.workflowName,
    workflowId: info.workflowId,
    runId: info.runId,
    cancelled: isCancelled,
    nodes,
    runningNodeIds: [...runningNodeIds],
    completedNodeIds: Object.keys(context.nodes),
  };
}

function buildArtifactsSnapshot(
  context: WorkflowTemplateContext
): TemporalWorkflowArtifactsQueryResult {
  const artifactRefs: TemporalWorkflowArtifactsQueryResult['artifactRefs'] = {};

  for (const [key, value] of Object.entries(context.artifacts)) {
    if (isArtifactRef(value)) {
      artifactRefs[key] = value;
    }
  }

  return {
    artifactKeys: Object.keys(context.artifacts),
    artifactRefs,
  };
}

function createActivityIdempotencyContext(nodeId: string): ScheduledActivityIdempotencyContext {
  const info = workflowInfo();
  return {
    workflowId: info.workflowId,
    runId: info.runId,
    nodeId,
    idempotencyKey: `${info.workflowId}:${info.runId}:${nodeId}`,
  };
}

async function runTemporalWorkflowNodeActivity(
  input: TemporalWorkflowInput,
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const activityInput = {
    workingDir: input.workingDir,
    nodeId,
    node,
    context,
    options: input.options,
    idempotencyContext: createActivityIdempotencyContext(nodeId),
    offloadArtifacts: true,
  };

  if (getTemporalNodeRetryMode(node) === 'no-retry') {
    return runWorkflowNodeNoRetryActivity(activityInput);
  }

  return runWorkflowNodeActivity(activityInput);
}

/**
 * Extract artifact keys referenced by a template/expression string.
 *
 * Scans for `{{artifacts.KEY}}` template references and bare `artifacts.KEY`
 * path references, collecting only the first path segment after `artifacts.`
 * (the key in `context.artifacts`). Subsequent dotted segments are sub-paths
 * within the resolved value and are resolved at evaluation time.
 */
function extractArtifactKeysFromExpression(expression: string, keys: Set<string>): void {
  for (const match of expression.matchAll(/\{\{\s*artifacts\.([A-Za-z0-9_-]+)/g)) {
    keys.add(match[1] ?? '');
  }
  const stripped = expression.replace(/\{\{[^}]+\}\}/g, '');
  for (const match of stripped.matchAll(/(?:^|[^A-Za-z0-9_.])artifacts\.([A-Za-z0-9_-]+)/g)) {
    keys.add(match[1] ?? '');
  }
  keys.delete('');
}

/**
 * Resolve only the artifact refs needed for upcoming control-flow evaluation.
 *
 * Returns a shallow-copy evaluation context with the requested keys resolved.
 * The original `context.artifacts` is never mutated, so large values that are
 * not needed for branching stay as refs in workflow state and never enter
 * Temporal event history. Activities self-hydrate from their own deserialized
 * copy, so node execution is unaffected.
 */
async function resolveEvaluationArtifacts(
  input: TemporalWorkflowInput,
  context: WorkflowTemplateContext,
  keys: Set<string>
): Promise<WorkflowTemplateContext> {
  if (keys.size === 0) return context;

  const refsToResolve: Record<string, TemporalArtifactRef> = {};
  for (const key of keys) {
    const value = context.artifacts[key];
    if (isArtifactRef(value)) {
      refsToResolve[key] = value;
    }
  }

  if (Object.keys(refsToResolve).length === 0) return context;

  const resolved = await resolveArtifactRefsActivity({
    workingDir: input.workingDir,
    refs: refsToResolve,
  });

  return {
    ...context,
    artifacts: { ...context.artifacts, ...resolved },
  };
}

/**
 * Build an evaluation context for a set of runnable DAG nodes by resolving
 * only the artifact refs referenced by their `if` conditions.
 */
async function resolveDagEvaluationContext(
  input: TemporalWorkflowInput,
  context: WorkflowTemplateContext,
  runnableNodeIds: string[]
): Promise<WorkflowTemplateContext> {
  const keys = new Set<string>();
  for (const nodeId of runnableNodeIds) {
    const node = input.plan.nodes[nodeId];
    if (node?.if) {
      extractArtifactKeysFromExpression(node.if, keys);
    }
  }
  return resolveEvaluationArtifacts(input, context, keys);
}

/**
 * Build an evaluation context for a control node by resolving only the
 * artifact refs referenced by its `if`, `value` (switch), or `maxIterations`
 * (loop) expressions.
 */
async function resolveControlEvaluationContext(
  input: TemporalWorkflowInput,
  context: WorkflowTemplateContext,
  node: WorkflowNodeConfig
): Promise<WorkflowTemplateContext> {
  const keys = new Set<string>();
  if (node.if) {
    extractArtifactKeysFromExpression(node.if, keys);
  }
  if (node.control === 'switch' && node.value) {
    extractArtifactKeysFromExpression(node.value, keys);
  }
  if (node.control === 'loop' && typeof node.maxIterations === 'string') {
    extractArtifactKeysFromExpression(node.maxIterations, keys);
  }
  return resolveEvaluationArtifacts(input, context, keys);
}

async function runTemporalDagNodes(
  input: TemporalWorkflowInput,
  nodeIds: string[],
  activeNodeIds: Set<string> | undefined,
  context: WorkflowTemplateContext,
  runningNodeIds: Set<string>
): Promise<void> {
  const { plan } = input;
  const completed = new Set<string>();
  const segmentNodeIds = new Set(nodeIds);

  if (activeNodeIds) {
    for (const nodeId of nodeIds) {
      if (!activeNodeIds.has(nodeId)) {
        completed.add(nodeId);
        context.nodes[nodeId] ??= createSkippedWorkflowNodeResult(nodeId);
      }
    }
  }

  while (completed.size < nodeIds.length) {
    const runnable = nodeIds.filter((nodeId) => {
      if (completed.has(nodeId)) return false;
      const node = plan.nodes[nodeId];
      if (!node) return false;
      return getNodeNeeds(node).every(
        (dependency) => completed.has(dependency) || !segmentNodeIds.has(dependency)
      );
    });

    if (runnable.length === 0) {
      const incomplete = nodeIds.filter((nodeId) => !completed.has(nodeId));
      throw new Error(
        `Workflow control runner could not make progress in a DAG segment. Pending nodes: ${incomplete.join(', ')}.`
      );
    }

    const evalContext = await resolveDagEvaluationContext(input, context, runnable);
    const results = await Promise.all(
      runnable.map(async (nodeId) => {
        const node = plan.nodes[nodeId];
        if (!node) {
          throw new Error(`Workflow references unknown node "${nodeId}".`);
        }

        const skipReason = getWorkflowNodeSkipReason(node, evalContext);
        if (skipReason) {
          return { nodeId, node, result: createSkippedWorkflowNodeResult(nodeId) };
        }

        runningNodeIds.add(nodeId);
        try {
          const result = await runTemporalWorkflowNodeActivity(input, nodeId, node, context);
          return { nodeId, node, result };
        } finally {
          runningNodeIds.delete(nodeId);
        }
      })
    );

    for (const { nodeId, node, result } of results) {
      completed.add(nodeId);
      recordWorkflowNodeResult(nodeId, node, result, context.nodes, context.artifacts);
    }
  }
}

function toWorkflowSegments(compiledSegments: CompiledWorkflowSegment[]): WorkflowSegment[] {
  return compiledSegments.map((segment) =>
    segment.type === 'control'
      ? { type: 'control', nodeId: segment.nodeId }
      : {
          type: 'dag',
          nodeIds: [...segment.nodeIds],
          ...(segment.activeNodeIds ? { activeNodeIds: new Set(segment.activeNodeIds) } : {}),
        }
  );
}

async function runTemporalControlWorkflow(
  input: TemporalWorkflowInput,
  context: WorkflowTemplateContext,
  runningNodeIds: Set<string>
): Promise<void> {
  const { plan } = input;
  const segments = toWorkflowSegments(plan.segments);
  let segmentIndex = 0;

  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex];
    if (segment.type === 'dag') {
      await runTemporalDagNodes(
        input,
        segment.nodeIds,
        segment.activeNodeIds,
        context,
        runningNodeIds
      );
      segmentIndex += 1;
      continue;
    }

    const node = plan.nodes[segment.nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${segment.nodeId}".`);
    }

    const evalContext = await resolveControlEvaluationContext(input, context, node);
    const skipReason = getWorkflowNodeSkipReason(node, evalContext);
    const { result, nextNodeId, ended } = skipReason
      ? { result: createSkippedWorkflowNodeResult(segment.nodeId) }
      : runControlWorkflowNode(segment.nodeId, node, evalContext);
    recordWorkflowNodeResult(segment.nodeId, node, result, context.nodes, context.artifacts);

    if (ended) {
      return;
    }

    if (!nextNodeId) {
      segmentIndex += 1;
      continue;
    }

    const targetIndex = findWorkflowSegmentIndex(segments, nextNodeId);
    if (targetIndex < 0) {
      throw new Error(
        `Workflow control node "${segment.nodeId}" targets unknown node "${nextNodeId}".`
      );
    }
    if (node.control !== 'loop' && targetIndex <= segmentIndex) {
      throw new Error(
        `Workflow control node "${segment.nodeId}" cannot jump backward to "${nextNodeId}". Use control: loop with maxIterations for repeated execution.`
      );
    }

    const targetSegment = segments[targetIndex];
    if (targetSegment.type === 'dag') {
      targetSegment.activeNodeIds = computeActiveWorkflowNodes(
        plan.nodes,
        targetSegment.nodeIds,
        nextNodeId,
        !(node.control === 'loop' && nextNodeId === node.target)
      );
    }
    segmentIndex = targetIndex;
  }
}

async function runTemporalDagWorkflow(
  input: TemporalWorkflowInput,
  context: WorkflowTemplateContext,
  runningNodeIds: Set<string>
): Promise<void> {
  for (const wave of input.plan.waves) {
    await runTemporalDagNodes(input, wave, undefined, context, runningNodeIds);
  }
}

export async function drsWorkflow(input: TemporalWorkflowInput): Promise<TemporalWorkflowResult> {
  const { plan } = input;
  const info = workflowInfo();
  const executionInput = input.workspace
    ? {
        ...input,
        workingDir: (
          await prepareWorkspaceActivity({
            workspace: input.workspace,
            workflowId: info.workflowId,
            runId: info.runId,
          })
        ).workingDir,
      }
    : input;
  const nodes: Record<string, WorkflowNodeResult> = {};
  const artifacts: Record<string, unknown> = {};
  const runningNodeIds = new Set<string>();
  let isCancelled = false;
  const context: WorkflowTemplateContext = {
    inputs: input.inputs,
    nodes,
    artifacts,
    loop: {},
  };

  setHandler(workflowStatusQuery, () =>
    buildWorkflowStatusSnapshot(input, context, runningNodeIds, isCancelled)
  );
  setHandler(workflowLoopStateQuery, () => context.loop);
  setHandler(workflowArtifactsQuery, () => buildArtifactsSnapshot(context));

  try {
    if (plan.hasControlNodes) {
      await runTemporalControlWorkflow(executionInput, context, runningNodeIds);
    } else {
      await runTemporalDagWorkflow(executionInput, context, runningNodeIds);
    }
  } catch (error) {
    if (isCancellation(error)) {
      isCancelled = true;
      runningNodeIds.clear();
    }
    throw error;
  }

  const lastNode = plan.nodes[plan.lastNodeId];
  const outputKey = plan.output ?? lastNode?.output ?? plan.lastNodeId;
  return {
    // Deterministic timestamp: derive from workflowInfo().runStartTime (set by
    // the Temporal server and replayed) instead of new Date(), which would be a
    // determinism violation in workflow code.
    timestamp: info.runStartTime.toISOString(),
    workflow: plan.workflowName,
    inputs: input.inputs,
    nodes,
    artifacts,
    loop: context.loop,
    output: artifacts[outputKey],
  };
}
