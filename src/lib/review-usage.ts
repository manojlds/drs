export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface AgentUsageSummary {
  agentType: string;
  model?: string;
  success?: boolean;
  turns: number;
  usage: UsageSummary;
}

export interface ReviewUsageSummary {
  total: UsageSummary;
  agents: AgentUsageSummary[];
}

export function createEmptyUsageSummary(): UsageSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

export function createEmptyReviewUsageSummary(): ReviewUsageSummary {
  return {
    total: createEmptyUsageSummary(),
    agents: [],
  };
}

export function addUsageSummary(base: UsageSummary, delta: Partial<UsageSummary>): UsageSummary {
  const input = base.input + (delta.input ?? 0);
  const output = base.output + (delta.output ?? 0);
  const cacheRead = base.cacheRead + (delta.cacheRead ?? 0);
  const cacheWrite = base.cacheWrite + (delta.cacheWrite ?? 0);
  const totalTokens =
    base.totalTokens +
    (delta.totalTokens ??
      (delta.input ?? 0) + (delta.output ?? 0) + (delta.cacheRead ?? 0) + (delta.cacheWrite ?? 0));
  const cost = base.cost + (delta.cost ?? 0);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

export function aggregateAgentUsage(agents: AgentUsageSummary[]): ReviewUsageSummary {
  const total = agents.reduce(
    (acc, agent) => addUsageSummary(acc, agent.usage),
    createEmptyUsageSummary()
  );

  return {
    total,
    agents,
  };
}

export function formatModelIdentifier(provider?: string, model?: string): string | undefined {
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return model;
}
