import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('Config', () => {
  it('should not overwrite default agents when undefined is passed', () => {
    const config = loadConfig(process.cwd(), {
      review: {
        agents: undefined,
      },
    } as any);

    // Should keep default agents, not overwrite with undefined
    expect(config.review.agents).toBeDefined();
    expect(Array.isArray(config.review.agents)).toBe(true);
    expect(config.review.agents.length).toBeGreaterThan(0);
  });

  it('should override agents when explicitly provided', () => {
    const config = loadConfig(process.cwd(), {
      review: {
        agents: ['security'],
      },
    });

    expect(config.review.agents).toEqual(['security']);
  });

  it('should use default agents when no override provided', () => {
    const config = loadConfig(process.cwd());

    expect(config.review.agents).toEqual(['security', 'quality', 'style', 'performance']);
  });
});
