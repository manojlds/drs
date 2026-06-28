import type { WorkflowNodeConfig } from '../config.js';
import type { WorkflowNodeResult, WorkflowTemplateContext } from './types.js';

/**
 * Boundary for side-effecting workflow node execution.
 *
 * Deterministic orchestration (dependency scheduling, waves, skip/condition
 * evaluation, result assembly) lives in the workflow runner/Temporal workflow.
 * Side effects (agents, actions, git, platform calls, file writes, artifact
 * operations, model calls) live behind this interface so the same node
 * execution can run either in-process or as a Temporal activity.
 *
 * `runNode` executes a single non-control node using `context` for template
 * rendering and returns the node's result. Skip/condition decisions are made
 * by the caller; `runNode` only executes nodes the caller has chosen to run.
 */
export interface NodeExecutor {
  runNode(
    nodeId: string,
    node: WorkflowNodeConfig,
    context: WorkflowTemplateContext
  ): Promise<WorkflowNodeResult>;
}
