import type {
  DRSConfig,
  WorkflowConfig,
  WorkflowInputConfig,
  WorkflowNodeConfig,
} from '../config.js';
import { loadWorkflowSourceInfo } from '../config.js';
import {
  getWorkflowExecutionOrder,
  getWorkflowExecutionWaves,
  getWorkflowNodes,
  hasWorkflowControlNodes,
  splitWorkflowSegments,
} from './planning.js';
import { getWorkflowInputConfigType } from './input.js';

/**
 * Workflow node as it appears in a compiled plan.
 *
 * This is currently an API-facing alias for WorkflowNodeConfig so future plan
 * schema changes can evolve independently from raw workflow config types.
 */
export type CompiledWorkflowNode = WorkflowNodeConfig;

/**
 * A DRS workflow control-flow segment expressed as JSON-serializable data.
 *
 * - DAG segments list their node ids plus, when a control node routes into
 *   them, the set of active node ids that should actually execute (inactive
 *   node ids are skipped by the runner). Active ids are absent for plain DAG
 *   segments with no gating control node.
 * - Control segments record the controlling node id.
 */
export type CompiledWorkflowSegment =
  | { type: 'dag'; nodeIds: string[]; activeNodeIds?: string[] }
  | { type: 'control'; nodeId: string };

/**
 * Metadata for a single workflow input, normalized to a plain object so the
 * compiled plan is JSON-serializable even when the original input is declared
 * as a bare string.
 */
export interface CompiledWorkflowInput {
  type: 'string' | 'boolean' | 'number' | 'enum';
  value?: string;
  file?: string;
  default?: string | number | boolean;
  required?: boolean;
  values?: Array<string | number | boolean>;
  description?: string;
}

/**
 * A fully resolved, JSON-serializable description of a workflow ready to be
 * handed to an executor (local or Temporal). It carries everything needed to
 * schedule nodes without reloading repo config: normalized nodes, execution
 * order, waves, control-flow segments, input metadata, and the output key.
 *
 * Resolved input *values* are intentionally not part of the plan; they are
 * supplied separately at run time so the same plan can dispatch multiple runs
 * with different inputs.
 */
export interface CompiledWorkflowPlan {
  /** Schema version so executors can evolve the shape safely. */
  schemaVersion: 1;
  /** Workflow name as resolved from config.workflows. */
  workflowName: string;
  /** Optional human-readable description. */
  description?: string;
  /** Origin of the workflow definition: packaged or project. */
  source: 'packaged' | 'project';
  /** Project workflows overriding a packaged workflow of the same name. */
  overridesPackaged: boolean;
  /** Workflow-level output artifact key. May be undefined (last node output). */
  output?: string;
  /** Workflow input metadata keyed by input name. */
  inputs: Record<string, CompiledWorkflowInput>;
  /** Normalized nodes keyed by id, identical in shape to WorkflowNodeConfig. */
  nodes: Record<string, CompiledWorkflowNode>;
  /** Dependency-ordered node ids (topological). */
  executionOrder: string[];
  /** Wave grouping for parallel DAG execution. */
  waves: string[][];
  /** Control-flow segments for control-bearing workflows; empty for DAG-only. */
  segments: CompiledWorkflowSegment[];
  /** True when the workflow uses any control (loop/switch/end/passThrough) node. */
  hasControlNodes: boolean;
  /** Id of the last node in execution order, used when output is undefined. */
  lastNodeId: string;
}

/**
 * Subset of {@link WorkflowRunOptions} relevant to plan compilation. The
 * workingDir is used only to resolve workflow source info (packaged vs.
 * project) and does not become part of the serialized plan.
 */
export interface CompileWorkflowPlanOptions {
  workingDir?: string;
}

function normalizeWorkflowInput(input: WorkflowInputConfig): CompiledWorkflowInput {
  if (typeof input === 'string') {
    return { type: 'string', value: input };
  }
  return {
    type: getWorkflowInputConfigType(input),
    value: input.value,
    file: input.file,
    default: input.default,
    required: input.required,
    values: input.values,
    description: input.description,
  };
}

export function compileWorkflowPlan(
  config: DRSConfig,
  workflowName: string,
  options: CompileWorkflowPlanOptions = {}
): CompiledWorkflowPlan {
  const workflow: WorkflowConfig | undefined = config.workflows?.[workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }

  const workingDir = options.workingDir ?? process.cwd();
  const sourceInfo = loadWorkflowSourceInfo(workingDir)[workflowName] ?? {
    source: 'packaged' as const,
    overridesPackaged: false,
  };

  const nodes = getWorkflowNodes(workflowName, workflow);
  const executionOrder = getWorkflowExecutionOrder(nodes);
  const waves = getWorkflowExecutionWaves(nodes, executionOrder);
  const hasControlNodes = hasWorkflowControlNodes(nodes);

  const segments: CompiledWorkflowSegment[] = hasControlNodes
    ? splitWorkflowSegments(nodes, executionOrder).map((segment) =>
        segment.type === 'control'
          ? { type: 'control' as const, nodeId: segment.nodeId }
          : {
              type: 'dag' as const,
              nodeIds: segment.nodeIds,
              ...(segment.activeNodeIds
                ? { activeNodeIds: Array.from(segment.activeNodeIds) }
                : {}),
            }
      )
    : [];

  return {
    schemaVersion: 1,
    workflowName,
    description: workflow.description,
    source: sourceInfo.source,
    overridesPackaged: sourceInfo.overridesPackaged,
    output: workflow.output,
    inputs: Object.fromEntries(
      Object.entries(workflow.inputs ?? {}).map(([name, input]) => [
        name,
        normalizeWorkflowInput(input),
      ])
    ),
    nodes,
    executionOrder,
    waves,
    segments,
    hasControlNodes,
    lastNodeId: executionOrder[executionOrder.length - 1] ?? '',
  };
}
