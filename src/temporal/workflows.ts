import { proxyActivities, workflowInfo } from '@temporalio/workflow';
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
import { getTemporalNodeRetryMode } from './retry-policy.js';
import type {
  ScheduledActivityIdempotencyContext,
  TemporalWorkflowInput,
  TemporalWorkflowResult,
} from './types.js';

const { runWorkflowNodeActivity, hydrateContextActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
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

async function hydrateTemporalContext(
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<void> {
  const hydrated = await hydrateContextActivity({
    workingDir,
    context,
  });
  Object.assign(context.artifacts, hydrated.artifacts);
}

async function runTemporalDagNodes(
  input: TemporalWorkflowInput,
  nodeIds: string[],
  activeNodeIds: Set<string> | undefined,
  context: WorkflowTemplateContext
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
      throw new Error('Workflow control runner could not make progress in a DAG segment.');
    }

    await hydrateTemporalContext(input.workingDir, context);
    const results = await Promise.all(
      runnable.map(async (nodeId) => {
        const node = plan.nodes[nodeId];
        if (!node) {
          throw new Error(`Workflow references unknown node "${nodeId}".`);
        }

        const skipReason = getWorkflowNodeSkipReason(node, context);
        if (skipReason) {
          return { nodeId, node, result: createSkippedWorkflowNodeResult(nodeId) };
        }

        const result = await runTemporalWorkflowNodeActivity(input, nodeId, node, context);
        return { nodeId, node, result };
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
  context: WorkflowTemplateContext
): Promise<void> {
  const { plan } = input;
  const segments = toWorkflowSegments(plan.segments);
  let segmentIndex = 0;

  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex];
    if (segment.type === 'dag') {
      await runTemporalDagNodes(input, segment.nodeIds, segment.activeNodeIds, context);
      segmentIndex += 1;
      continue;
    }

    const node = plan.nodes[segment.nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${segment.nodeId}".`);
    }

    await hydrateTemporalContext(input.workingDir, context);
    const skipReason = getWorkflowNodeSkipReason(node, context);
    const { result, nextNodeId, ended } = skipReason
      ? { result: createSkippedWorkflowNodeResult(segment.nodeId) }
      : runControlWorkflowNode(segment.nodeId, node, context);
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
  context: WorkflowTemplateContext
): Promise<void> {
  for (const wave of input.plan.waves) {
    await runTemporalDagNodes(input, wave, undefined, context);
  }
}

export async function drsWorkflow(input: TemporalWorkflowInput): Promise<TemporalWorkflowResult> {
  const { plan } = input;
  const nodes: Record<string, WorkflowNodeResult> = {};
  const artifacts: Record<string, unknown> = {};
  const context: WorkflowTemplateContext = {
    inputs: input.inputs,
    nodes,
    artifacts,
    loop: {},
  };

  if (plan.hasControlNodes) {
    await runTemporalControlWorkflow(input, context);
  } else {
    await runTemporalDagWorkflow(input, context);
  }

  const lastNode = plan.nodes[plan.lastNodeId];
  const outputKey = plan.output ?? lastNode?.output ?? plan.lastNodeId;
  return {
    timestamp: workflowInfo().startTime.toISOString(),
    workflow: plan.workflowName,
    inputs: input.inputs,
    nodes,
    artifacts,
    loop: context.loop,
    output: artifacts[outputKey],
  };
}
