import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from './activities.js';
import {
  createSkippedWorkflowNodeResult,
  getWorkflowNodeSkipReason,
} from '../lib/workflow/planning.js';
import type { WorkflowNodeConfig } from '../lib/config.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from '../lib/workflow/types.js';
import type { TemporalWorkflowInput, TemporalWorkflowResult } from './types.js';

const { runWorkflowNodeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
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

export async function drsWorkflow(input: TemporalWorkflowInput): Promise<TemporalWorkflowResult> {
  const { plan } = input;
  if (plan.hasControlNodes) {
    throw new Error(
      'Temporal executor MVP supports DAG-only workflows. Control-flow workflows are Phase 5.'
    );
  }

  const nodes: Record<string, WorkflowNodeResult> = {};
  const artifacts: Record<string, unknown> = {};
  const loop: Record<string, never> = {};
  const context: WorkflowTemplateContext = {
    inputs: input.inputs,
    nodes,
    artifacts,
    loop,
  };

  for (const wave of plan.waves) {
    const results = await Promise.all(
      wave.map(async (nodeId) => {
        const node = plan.nodes[nodeId];
        if (!node) {
          throw new Error(`Workflow references unknown node "${nodeId}".`);
        }

        const skipReason = getWorkflowNodeSkipReason(node, context);
        if (skipReason) {
          return { nodeId, node, result: createSkippedWorkflowNodeResult(nodeId) };
        }

        const result = await runWorkflowNodeActivity({
          workingDir: input.workingDir,
          nodeId,
          node,
          context,
          options: input.options,
        });
        return { nodeId, node, result };
      })
    );

    for (const { nodeId, node, result } of results) {
      recordWorkflowNodeResult(nodeId, node, result, nodes, artifacts);
    }
  }

  const lastNode = plan.nodes[plan.lastNodeId];
  const outputKey = plan.output ?? lastNode?.output ?? plan.lastNodeId;
  return {
    timestamp: workflowInfo().startTime.toISOString(),
    workflow: plan.workflowName,
    inputs: input.inputs,
    nodes,
    artifacts,
    loop: {},
    output: artifacts[outputKey],
  };
}
