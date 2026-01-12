/**
 * Comprehensive tests for model override functionality
 *
 * Tests the precedence order of model configuration:
 * 1. Per-agent model in DRS config
 * 2. Environment variable REVIEW_AGENT_<NAME>_MODEL
 * 3. defaultModel in DRS config
 * 4. Environment variable REVIEW_DEFAULT_MODEL
 * 5. (Falls through to opencode.jsonc, not tested here)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getModelOverrides,
  normalizeAgentConfig,
  getAgentNames,
  type DRSConfig,
} from './config.js';

describe('Model Override Precedence', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    delete process.env.REVIEW_DEFAULT_MODEL;
    delete process.env.REVIEW_AGENT_SECURITY_MODEL;
    delete process.env.REVIEW_AGENT_QUALITY_MODEL;
    delete process.env.REVIEW_AGENT_STYLE_MODEL;
    delete process.env.REVIEW_AGENT_PERFORMANCE_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createMockConfig = (overrides?: Partial<DRSConfig['review']>): DRSConfig => ({
    opencode: {},
    gitlab: { url: '', token: '' },
    github: { token: '' },
    review: {
      agents: ['security', 'quality', 'style', 'performance'],
      defaultModel: 'anthropic/claude-sonnet-4-5-20250929',
      ignorePatterns: [],
      ...overrides,
    },
  });

  describe('Test 1: Default model always set', () => {
    it('should return overrides based on defaultModel', () => {
      const config = createMockConfig();
      const overrides = getModelOverrides(config);

      // defaultModel is now required, so all agents get the default
      expect(overrides.security).toBe('anthropic/claude-sonnet-4-5-20250929');
      expect(overrides['review/security']).toBe('anthropic/claude-sonnet-4-5-20250929');
    });
  });

  describe('Test 2: DRS defaultModel only', () => {
    it('should apply defaultModel to all agents', () => {
      const config = createMockConfig({
        defaultModel: 'zhipuai/glm-4.7',
        agents: ['security', 'quality', 'style', 'performance'],
      });

      const overrides = getModelOverrides(config);

      expect(overrides).toEqual({
        security: 'zhipuai/glm-4.7',
        'review/security': 'zhipuai/glm-4.7',
        quality: 'zhipuai/glm-4.7',
        'review/quality': 'zhipuai/glm-4.7',
        style: 'zhipuai/glm-4.7',
        'review/style': 'zhipuai/glm-4.7',
        performance: 'zhipuai/glm-4.7',
        'review/performance': 'zhipuai/glm-4.7',
      });
    });
  });

  describe('Test 3: DRS per-agent model override', () => {
    it('should use per-agent model over defaultModel', () => {
      const config = createMockConfig({
        defaultModel: 'zhipuai/glm-4.7',
        agents: [
          { name: 'security', model: 'anthropic/claude-opus-4-5-20251101' },
          'quality',
          { name: 'style', model: 'anthropic/claude-sonnet-4-5-20250929' },
          'performance',
        ],
      });

      const overrides = getModelOverrides(config);

      expect(overrides).toEqual({
        security: 'anthropic/claude-opus-4-5-20251101',
        'review/security': 'anthropic/claude-opus-4-5-20251101',
        quality: 'zhipuai/glm-4.7',
        'review/quality': 'zhipuai/glm-4.7',
        style: 'anthropic/claude-sonnet-4-5-20250929',
        'review/style': 'anthropic/claude-sonnet-4-5-20250929',
        performance: 'zhipuai/glm-4.7',
        'review/performance': 'zhipuai/glm-4.7',
      });
    });
  });

  describe('Test 4: Environment REVIEW_DEFAULT_MODEL', () => {
    it('should use env default model for all agents', () => {
      process.env.REVIEW_DEFAULT_MODEL = 'provider/model-from-env';

      const config = createMockConfig({
        agents: ['security', 'quality'],
      });

      const overrides = getModelOverrides(config);

      expect(overrides).toEqual({
        security: 'provider/model-from-env',
        'review/security': 'provider/model-from-env',
        quality: 'provider/model-from-env',
        'review/quality': 'provider/model-from-env',
      });
    });

    it('should prefer config defaultModel over env REVIEW_DEFAULT_MODEL', () => {
      process.env.REVIEW_DEFAULT_MODEL = 'provider/env-model';

      const config = createMockConfig({
        defaultModel: 'zhipuai/config-model',
        agents: ['security'],
      });

      const overrides = getModelOverrides(config);

      expect(overrides.security).toBe('zhipuai/config-model');
    });
  });

  describe('Test 5: Environment REVIEW_AGENT_<NAME>_MODEL', () => {
    it('should use agent-specific env var', () => {
      process.env.REVIEW_AGENT_SECURITY_MODEL = 'provider/security-from-env';

      const config = createMockConfig({
        defaultModel: 'zhipuai/glm-4.7',
        agents: ['security', 'quality'],
      });

      const overrides = getModelOverrides(config);

      expect(overrides).toEqual({
        security: 'provider/security-from-env',
        'review/security': 'provider/security-from-env',
        quality: 'zhipuai/glm-4.7',
        'review/quality': 'zhipuai/glm-4.7',
      });
    });

    it('should handle agent names with special characters', () => {
      process.env.REVIEW_AGENT_CUSTOM_SECURITY_MODEL = 'provider/custom-model';

      const config = createMockConfig({
        agents: ['custom-security'],
        defaultModel: 'zhipuai/glm-4.7',
      });

      const overrides = getModelOverrides(config);

      // Env var takes precedence over defaultModel
      expect(overrides['custom-security']).toBe('provider/custom-model');
    });
  });

  describe('Test 6: Complete precedence chain', () => {
    it('should follow full precedence order', () => {
      // Set env vars (lowest priority among overrides)
      process.env.REVIEW_DEFAULT_MODEL = 'provider/default-env';
      process.env.REVIEW_AGENT_QUALITY_MODEL = 'provider/quality-env';

      const config = createMockConfig({
        defaultModel: 'zhipuai/default-config',
        agents: [{ name: 'security', model: 'anthropic/security-config' }, 'quality', 'style'],
      });

      const overrides = getModelOverrides(config);

      // Precedence verification:
      // security: per-agent config wins
      expect(overrides.security).toBe('anthropic/security-config');

      // quality: env agent var wins over config default
      expect(overrides.quality).toBe('provider/quality-env');

      // style: config default wins over env default
      expect(overrides.style).toBe('zhipuai/default-config');
    });
  });

  describe('Test 7: Mixed agent formats', () => {
    it('should handle mix of string and object agent configs', () => {
      const config = createMockConfig({
        defaultModel: 'zhipuai/glm-4.7',
        agents: [
          'security',
          { name: 'quality', model: 'anthropic/claude-opus-4-5-20251101' },
          'style',
          { name: 'performance' }, // object without model
        ],
      });

      const overrides = getModelOverrides(config);

      expect(overrides.security).toBe('zhipuai/glm-4.7');
      expect(overrides.quality).toBe('anthropic/claude-opus-4-5-20251101');
      expect(overrides.style).toBe('zhipuai/glm-4.7');
      expect(overrides.performance).toBe('zhipuai/glm-4.7');
    });
  });

  describe('Agent name normalization', () => {
    it('should normalize string agents', () => {
      const agents = ['security', 'quality'];
      const normalized = normalizeAgentConfig(agents);

      expect(normalized).toEqual([{ name: 'security' }, { name: 'quality' }]);
    });

    it('should preserve object agents', () => {
      const agents = [{ name: 'security', model: 'test/model' }, 'quality'];
      const normalized = normalizeAgentConfig(agents);

      expect(normalized).toEqual([{ name: 'security', model: 'test/model' }, { name: 'quality' }]);
    });
  });

  describe('Agent name extraction', () => {
    it('should extract agent names from mixed config', () => {
      const config = createMockConfig({
        agents: ['security', { name: 'quality', model: 'test/model' }, { name: 'style' }],
      });

      const names = getAgentNames(config);

      expect(names).toEqual(['security', 'quality', 'style']);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty agents array', () => {
      const config = createMockConfig({
        agents: [],
        defaultModel: 'zhipuai/glm-4.7',
      });

      const overrides = getModelOverrides(config);

      expect(overrides).toEqual({});
    });

    it('should apply defaultModel to agents without explicit model', () => {
      const config = createMockConfig({
        agents: [{ name: 'security' }, { name: 'quality' }],
        defaultModel: 'test/default-model',
      });

      const overrides = getModelOverrides(config);

      // defaultModel is now always applied
      expect(overrides.security).toBe('test/default-model');
      expect(overrides.quality).toBe('test/default-model');
    });

    it('should create both short and review/ prefixed keys', () => {
      const config = createMockConfig({
        defaultModel: 'test/model',
        agents: ['security'],
      });

      const overrides = getModelOverrides(config);

      expect(overrides.security).toBe('test/model');
      expect(overrides['review/security']).toBe('test/model');
    });
  });
});
