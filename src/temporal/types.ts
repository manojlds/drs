import type { WorkflowNodeConfig } from '../lib/config.js';
import type { CompiledWorkflowPlan } from '../lib/workflow/compiled-plan.js';
import type {
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowTemplateContext,
  WorkflowActivityIdempotencyContext,
} from '../lib/workflow/types.js';
import type { TemporalArtifactRef } from '../lib/workflow/artifact-store.js';

export interface TemporalConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  workflowIdPrefix: string;
  workspace: TemporalWorkspaceConfig;
}

export interface TemporalWorkspaceConfig {
  mode: 'local' | 'managed';
  root: string;
}

export interface TemporalManagedWorkspaceInput {
  mode: 'managed';
  root: string;
  repoUrl: string;
  ref: string;
}

export interface TemporalWorkflowInput {
  plan: CompiledWorkflowPlan;
  inputs: Record<string, string>;
  workingDir: string;
  options?: Pick<WorkflowRunOptions, 'debug' | 'thinkingLevel'>;
  workspace?: TemporalManagedWorkspaceInput;
}

export interface PrepareWorkspaceActivityInput {
  workspace: TemporalManagedWorkspaceInput;
  workflowId: string;
  runId: string;
}

export interface PrepareWorkspaceActivityResult {
  workingDir: string;
}

export interface ResolveArtifactRefsActivityInput {
  workingDir: string;
  refs: Record<string, TemporalArtifactRef>;
}

export type ActivityIdempotencyContext = WorkflowActivityIdempotencyContext;

export type ScheduledActivityIdempotencyContext = Omit<ActivityIdempotencyContext, 'attempt'> & {
  attempt?: number;
};

export interface RunWorkflowNodeActivityInput {
  workingDir: string;
  nodeId: string;
  node: WorkflowNodeConfig;
  context: WorkflowTemplateContext;
  options?: Pick<WorkflowRunOptions, 'debug' | 'thinkingLevel'>;
  idempotencyContext?: ScheduledActivityIdempotencyContext;
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

export type TemporalWorkflowNodeQueryStatus = 'pending' | 'running' | 'success' | 'skipped';

export interface TemporalWorkflowNodeStatusSnapshot {
  id: string;
  status: TemporalWorkflowNodeQueryStatus;
  action?: string;
  agent?: string;
  control?: string;
}

export interface TemporalWorkflowStatusQueryResult {
  workflow: string;
  workflowId: string;
  runId: string;
  cancelled: boolean;
  nodes: Record<string, TemporalWorkflowNodeStatusSnapshot>;
  runningNodeIds: string[];
  completedNodeIds: string[];
}

export interface TemporalWorkflowArtifactsQueryResult {
  artifactKeys: string[];
  artifactRefs: Record<string, TemporalArtifactRef>;
}

export type TemporalWorkflowResult = WorkflowRunResult;
