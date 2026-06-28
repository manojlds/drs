import type { WorkflowNodeConfig } from '../lib/config.js';
import type { CompiledWorkflowPlan } from '../lib/workflow/compiled-plan.js';
import type {
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowTemplateContext,
} from '../lib/workflow/types.js';

export interface TemporalConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  workflowIdPrefix: string;
}

export interface TemporalWorkflowInput {
  plan: CompiledWorkflowPlan;
  inputs: Record<string, string>;
  workingDir: string;
  options?: Pick<WorkflowRunOptions, 'debug' | 'thinkingLevel'>;
}

export interface RunWorkflowNodeActivityInput {
  workingDir: string;
  nodeId: string;
  node: WorkflowNodeConfig;
  context: WorkflowTemplateContext;
  options?: Pick<WorkflowRunOptions, 'debug' | 'thinkingLevel'>;
  /**
   * When true, the activity constructs a LocalWorkflowArtifactStore for the
   * worker's working directory and offloads large node outputs as refs so
   * they stay out of Temporal event history.
   */
  offloadArtifacts?: boolean;
  /**
   * Inline size threshold in bytes. Values larger than this become refs when
   * offloadArtifacts is true. Defaults to 64KB.
   */
  artifactInlineMaxBytes?: number;
}

export type TemporalWorkflowResult = WorkflowRunResult;
