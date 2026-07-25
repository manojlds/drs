import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDescriberModelOverride,
  getModelOverrides,
  getReviewAgentId,
  getUnifiedModelOverride,
  normalizeSingleAgentConfig,
  resolveAgentRunConfig,
  resolveAgentSkills,
  resolveAgentThinkingLevel,
  type DRSConfig,
} from './config.js';

describe('agent model and skill configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DRS_DEFAULT_MODEL;
    delete process.env.REVIEW_DEFAULT_MODEL;
    delete process.env.DRS_AGENT_REVIEW_SECURITY_MODEL;
    delete process.env.REVIEW_AGENT_REVIEW_SECURITY_MODEL;
    delete process.env.REVIEW_AGENT_REVIEW_QUALITY_MODEL;
    delete process.env.REVIEW_UNIFIED_MODEL;
    delete process.env.DESCRIBE_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createConfig(overrides: Partial<DRSConfig> = {}): DRSConfig {
    return {
      pi: {},
      agents: {
        default: {
          model: 'provider/default-model',
          skills: [],
        },
      },
      gitlab: { url: '', token: '' },
      github: { token: '' },
      review: {
        agent: 'review/security',
        ignorePatterns: [],
      },
      ...overrides,
    };
  }

  it('applies agents.default.model to fully qualified review agents', () => {
    const overrides = getModelOverrides(createConfig());

    expect(overrides).toEqual({
      'review/security': 'provider/default-model',
    });
  });

  it('uses per-agent review config before namespace and global defaults', () => {
    const config = createConfig({
      agents: {
        default: { model: 'provider/default-model' },
        namespaces: {
          review: { model: 'provider/review-default' },
        },
      },
      review: {
        agent: { name: 'review/security', model: 'provider/security-model' },
        ignorePatterns: [],
      },
    });

    expect(getModelOverrides(config)).toEqual({
      'review/security': 'provider/security-model',
    });
  });

  it('uses exact generic agent override before namespace and global defaults', () => {
    const config = createConfig({
      agents: {
        default: { model: 'provider/default-model' },
        namespaces: {
          review: { model: 'provider/review-default' },
        },
        overrides: {
          'review/quality': { model: 'provider/quality-model' },
        },
      },
      review: {
        agent: 'review/quality',
        ignorePatterns: [],
      },
    });

    expect(getModelOverrides(config)).toEqual({
      'review/quality': 'provider/quality-model',
    });
  });

  it('uses fully qualified generic per-agent environment variable', () => {
    process.env.DRS_AGENT_REVIEW_SECURITY_MODEL = 'provider/security-env';

    const config = createConfig({
      review: {
        agent: 'review/security',
        ignorePatterns: [],
      },
    });

    expect(getModelOverrides(config)).toEqual({
      'review/security': 'provider/security-env',
    });
  });

  it('keeps REVIEW_AGENT per-agent environment variables as compatibility aliases', () => {
    process.env.REVIEW_AGENT_REVIEW_SECURITY_MODEL = 'provider/security-env';

    expect(
      getModelOverrides(
        createConfig({
          review: {
            agent: 'review/security',
            ignorePatterns: [],
          },
        })
      )
    ).toEqual({
      'review/security': 'provider/security-env',
    });
  });

  it('normalizes a scalar agent config without changing its id', () => {
    expect(normalizeSingleAgentConfig('review/security')).toEqual({ name: 'review/security' });
    expect(
      normalizeSingleAgentConfig({ name: 'review/quality', model: 'provider/quality' })
    ).toEqual({
      name: 'review/quality',
      model: 'provider/quality',
    });
  });

  it('extracts a fully qualified review agent id', () => {
    const config = createConfig({
      review: {
        agent: { name: 'review/security' },
        ignorePatterns: [],
      },
    });

    expect(getReviewAgentId(config)).toBe('review/security');
  });

  it('rejects short or non-review ids in review.agent', () => {
    expect(() =>
      getReviewAgentId(
        createConfig({
          review: { agent: 'security', ignorePatterns: [] },
        })
      )
    ).toThrow('review/security');

    expect(() =>
      getReviewAgentId(
        createConfig({
          review: { agent: 'task/docs-updater', ignorePatterns: [] },
        })
      )
    ).toThrow('"review" namespace');
  });

  it('rejects unsafe path components in agent ids', () => {
    expect(() =>
      getReviewAgentId(
        createConfig({
          review: { agent: 'review/..', ignorePatterns: [] },
        })
      )
    ).toThrow('path components');

    expect(() => resolveAgentSkills(createConfig(), 'review/.')).toThrow('path components');
  });

  it('keeps explicit unified reviewer override as an exact id override', () => {
    const config = createConfig({
      review: {
        agent: 'review/unified-reviewer',
        ignorePatterns: [],
        unified: { model: 'provider/unified-config' },
      },
    });

    expect(getUnifiedModelOverride(config)).toEqual({
      'review/unified-reviewer': 'provider/unified-config',
    });
  });

  it('resolves describer model from describe config or generic defaults', () => {
    expect(
      getDescriberModelOverride(
        createConfig({
          describe: { model: 'provider/describe-model' },
        })
      )
    ).toEqual({ 'describe/pr-describer': 'provider/describe-model' });

    expect(getDescriberModelOverride(createConfig())).toEqual({
      'describe/pr-describer': 'provider/default-model',
    });
  });

  it('resolves skills additively from defaults, namespace, frontmatter, overrides, and review config', () => {
    const config = createConfig({
      agents: {
        default: { skills: ['global-skill'] },
        namespaces: {
          review: { skills: ['review-skill'] },
        },
        overrides: {
          'review/security': { skills: ['override-skill'] },
        },
      },
      review: {
        agent: {
          name: 'review/security',
          model: 'provider/security-model',
          skills: ['configured-skill', 'global-skill'],
        },
        ignorePatterns: [],
      },
    });

    expect(resolveAgentSkills(config, 'review/security', ['frontmatter-skill'])).toEqual([
      'global-skill',
      'review-skill',
      'frontmatter-skill',
      'override-skill',
      'configured-skill',
    ]);
  });

  it('resolves generic run config and thinking level by agent id', () => {
    const config = createConfig({
      agents: {
        default: {
          model: 'provider/default-model',
          thinkingLevel: 'low',
          run: {
            json: false,
            output: 'default-output.txt',
          },
        },
        namespaces: {
          task: {
            thinkingLevel: 'medium',
            run: {
              promptFile: 'prompts/task.md',
              json: true,
            },
          },
        },
        overrides: {
          'task/docs-updater': {
            thinkingLevel: 'high',
            run: {
              prompt: 'Configured prompt',
            },
          },
        },
      },
    });

    expect(resolveAgentThinkingLevel(config, 'task/docs-updater')).toBe('high');
    expect(resolveAgentRunConfig(config, 'task/docs-updater')).toEqual({
      prompt: 'Configured prompt',
      promptFile: 'prompts/task.md',
      output: 'default-output.txt',
      json: true,
    });
  });
});
