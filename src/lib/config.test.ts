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
      } as any,
    });

    expect(config.review.agents).toEqual(['security']);
  });

  it('should load agents from config file when no override provided', () => {
    const config = loadConfig(process.cwd());

    // Should load whatever is configured in the project's .drs/drs.config.yaml
    expect(config.review.agents).toBeDefined();
    expect(Array.isArray(config.review.agents)).toBe(true);
    expect(config.review.agents.length).toBeGreaterThan(0);

    // Verify each agent is a string (simple format) or object (detailed format)
    config.review.agents.forEach((agent) => {
      const isValid = typeof agent === 'string' ||
                     (typeof agent === 'object' && 'name' in agent);
      expect(isValid).toBe(true);
    });
  });
});
