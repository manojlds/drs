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
}

export type TemporalWorkflowResult = WorkflowRunResult;
