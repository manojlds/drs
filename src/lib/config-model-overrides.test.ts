import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDescriberModelOverride,
  getModelOverrides,
  getReviewAgentIds,
  getUnifiedModelOverride,
  normalizeAgentConfig,
  resolveAgentSkills,
  type DRSConfig,
} from './config.js';

describe('agent model and skill configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.REVIEW_DEFAULT_MODEL;
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
        agents: ['review/security', 'review/quality', 'review/style'],
        ignorePatterns: [],
      },
      ...overrides,
    } as DRSConfig;
  }

  it('applies agents.default.model to fully qualified review agents', () => {
    const overrides = getModelOverrides(createConfig());

    expect(overrides).toEqual({
      'review/security': 'provider/default-model',
      'review/quality': 'provider/default-model',
      'review/style': 'provider/default-model',
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
        agents: [{ name: 'review/security', model: 'provider/security-model' }, 'review/quality'],
        ignorePatterns: [],
      },
    });

    expect(getModelOverrides(config)).toEqual({
      'review/security': 'provider/security-model',
      'review/quality': 'provider/review-default',
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
        agents: ['review/quality'],
        ignorePatterns: [],
      },
    });

    expect(getModelOverrides(config)).toEqual({
      'review/quality': 'provider/quality-model',
    });
  });

  it('uses fully qualified per-agent environment variable', () => {
    process.env.REVIEW_AGENT_REVIEW_SECURITY_MODEL = 'provider/security-env';

    const config = createConfig({
      review: {
        agents: ['review/security', 'review/quality'],
        ignorePatterns: [],
      },
    });

    expect(getModelOverrides(config)).toEqual({
      'review/security': 'provider/security-env',
      'review/quality': 'provider/default-model',
    });
  });

  it('normalizes mixed agent config values without changing ids', () => {
    expect(
      normalizeAgentConfig([
        'review/security',
        { name: 'review/quality', model: 'provider/quality' },
      ])
    ).toEqual([{ name: 'review/security' }, { name: 'review/quality', model: 'provider/quality' }]);
  });

  it('extracts fully qualified review agent ids', () => {
    const config = createConfig({
      review: {
        agents: ['review/security', { name: 'review/quality' }, 'review/security'],
        ignorePatterns: [],
      },
    });

    expect(getReviewAgentIds(config)).toEqual(['review/security', 'review/quality']);
  });

  it('rejects short or non-review ids in review.agents', () => {
    expect(() =>
      getReviewAgentIds(
        createConfig({
          review: { agents: ['security'], ignorePatterns: [] },
        })
      )
    ).toThrow('fully qualified');

    expect(() =>
      getReviewAgentIds(
        createConfig({
          review: { agents: ['task/docs-updater'], ignorePatterns: [] },
        })
      )
    ).toThrow('"review" namespace');
  });

  it('keeps explicit unified reviewer override as an exact id override', () => {
    const config = createConfig({
      review: {
        agents: ['review/unified-reviewer'],
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
        agents: [{ name: 'review/security', skills: ['configured-skill', 'global-skill'] }],
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
});
