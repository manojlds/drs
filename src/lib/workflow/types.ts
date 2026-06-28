import type { AgentRunResult } from '../agent-result.js';

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
}

export interface WorkflowNodeResult {
  id: string;
  type: 'agent' | 'agents' | 'action' | 'control' | 'skipped';
  status?: 'success' | 'skipped';
  agent?: string;
  agents?: string[];
  action?: string;
  control?: string;
  decision?: string;
  target?: string;
  response?: string;
  responses?: AgentRunResult[];
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
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
  loop: Record<string, WorkflowLoopState>;
}
