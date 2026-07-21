import type { AgentUsageSummary } from './review-usage.js';
import type { AgentWorkspaceChanges } from './agent-permissions.js';

export interface AgentRunResult {
  timestamp: string;
  agent: string;
  response: string;
  usage: AgentUsageSummary;
  workspaceChanges?: AgentWorkspaceChanges;
}
