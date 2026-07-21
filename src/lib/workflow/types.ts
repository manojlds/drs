import type { AgentRunResult } from '../agent-result.js';
import type { AgentWorkspaceChanges } from '../agent-permissions.js';
import type { AgentUsageSummary } from '../review-usage.js';

export interface WorkflowRunOptions {
  inputs?: Record<string, string>;
  inputFiles?: Record<string, string>;
  outputPath?: string;
  jsonOutput?: boolean;
  debug?: boolean;
  thinkingLevel?: string;
  workingDir?: string;
  trace?: boolean;
  wait?: boolean;
  idempotencyContext?: WorkflowActivityIdempotencyContext;
  /**
   * Explicit Temporal workflow ID. When set, the Temporal executor uses this
   * ID instead of deriving one, enabling deterministic deduplication from a
   * service layer. The local executor ignores this option.
   */
  workflowId?: string;
}

export interface WorkflowActivityIdempotencyContext {
  workflowId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  idempotencyKey: string;
}

export interface WorkflowNodeResult {
  id: string;
  type: 'agent' | 'agents' | 'action' | 'control' | 'skipped';
  status?: 'success' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  agent?: string;
  agents?: string[];
  action?: string;
  control?: string;
  decision?: string;
  target?: string;
  response?: string;
  responses?: AgentRunResult[];
  usage?: AgentUsageSummary;
  workspaceChanges?: AgentWorkspaceChanges;
  output?: unknown;
  outputs?: Record<string, unknown>;
  writes?: string;
}

export interface WorkflowLoopState {
  iteration: number;
  maxIterations: number;
  lastDecision?: 'loop' | 'exit';
}

export interface WorkflowRunResult {
  timestamp: string;
  workflow: string;
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
  loop: Record<string, WorkflowLoopState>;
  output?: unknown;
}

export interface WorkflowTemplateContext {
  startedAt?: string;
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
  loop: Record<string, WorkflowLoopState>;
}
