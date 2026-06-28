import type { AgentUsageSummary } from './review-usage.js';

export interface AgentRunResult {
  timestamp: string;
  agent: string;
  response: string;
  usage: AgentUsageSummary;
}
