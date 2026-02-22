import { describe, expect, it } from 'vitest';
import {
  addUsageSummary,
  aggregateAgentUsage,
  applyUsageMessage,
  createAgentUsageSummary,
  createEmptyUsageSummary,
  formatModelIdentifier,
} from './review-usage.js';

describe('review-usage', () => {
  it('adds usage values with sensible defaults', () => {
    const base = createEmptyUsageSummary();
    const total = addUsageSummary(base, {
      input: 10,
      output: 2,
      cacheRead: 3,
      cost: 0.5,
    });

    expect(total).toEqual({
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 15,
      cost: 0.5,
    });
  });

  it('aggregates per-agent usage into run totals', () => {
    const result = aggregateAgentUsage([
      {
        agentType: 'security',
        turns: 1,
        usage: {
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110,
          cost: 0.01,
        },
      },
      {
        agentType: 'quality',
        turns: 1,
        usage: {
          input: 200,
          output: 20,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 225,
          cost: 0.02,
        },
      },
    ]);

    expect(result.total).toEqual({
      input: 300,
      output: 30,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 335,
      cost: 0.03,
    });
    expect(result.agents).toHaveLength(2);
  });

  it('applies usage messages and tracks turns/model', () => {
    const base = createAgentUsageSummary('describe/pr-describer');

    const next = applyUsageMessage(base, {
      provider: 'opencode',
      model: 'glm-5-free',
      usage: {
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 60,
        cost: 0.002,
      },
    });

    expect(next.turns).toBe(1);
    expect(next.model).toBe('opencode/glm-5-free');
    expect(next.usage.totalTokens).toBe(60);
    expect(next.usage.cost).toBe(0.002);
  });

  it('formats provider/model identifiers', () => {
    expect(formatModelIdentifier('opencode', 'glm-5-free')).toBe('opencode/glm-5-free');
    expect(formatModelIdentifier(undefined, 'gpt-4o')).toBe('gpt-4o');
    expect(formatModelIdentifier(undefined, undefined)).toBeUndefined();
  });
});
