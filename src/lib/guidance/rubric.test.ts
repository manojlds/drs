import { describe, expect, it } from 'vitest';
import { DEFAULT_GUIDANCE_THRESHOLDS, parseGuidanceRubric } from './rubric.js';

const SHA = 'a'.repeat(64);

function validRubric(): Record<string, unknown> {
  return {
    version: 1,
    compiledAt: '2026-09-19T12:00:00.000Z',
    compiledBy: 'task/guidance-compiler',
    sources: [{ path: 'AGENTS.md', sha256: SHA, scope: '**/*' }],
    thresholds: DEFAULT_GUIDANCE_THRESHOLDS,
    rules: [
      {
        id: 'no-single-use-helper',
        text: 'Keep things in one function unless composable or reusable.',
        source: { path: 'AGENTS.md', line: 12 },
        scope: ['src/**/*'],
        when: 'change',
        status: 'active',
        check: {
          type: 'model',
          question: {
            type: 'boolean',
            violating: true,
            instructions:
              'Does this change add an abstraction with one caller and no independently reusable behavior?',
          },
        },
      },
    ],
  };
}

describe('parseGuidanceRubric', () => {
  it('accepts a source-linked model rule', () => {
    const rubric = parseGuidanceRubric(validRubric());

    expect(rubric.rules[0]?.id).toBe('no-single-use-helper');
    expect(rubric.thresholds).toEqual({ act: 0.8, flag: 0.5 });
  });

  it('rejects unknown fields at persisted boundaries', () => {
    const candidate = validRubric();
    candidate.extra = true;

    expect(() => parseGuidanceRubric(candidate)).toThrow('Guidance rubric is invalid');
  });

  it('rejects duplicate rule ids', () => {
    const candidate = validRubric();
    const rules = candidate.rules as Record<string, unknown>[];
    rules.push(structuredClone(rules[0]));

    expect(() => parseGuidanceRubric(candidate)).toThrow(
      'Guidance rubric contains duplicate rule id: no-single-use-helper'
    );
  });

  it('rejects rules whose source is not declared', () => {
    const candidate = validRubric();
    const rules = candidate.rules as Record<string, unknown>[];
    rules[0].source = { path: 'packages/api/AGENTS.md', line: 3 };

    expect(() => parseGuidanceRubric(candidate)).toThrow(
      'references an unknown source: packages/api/AGENTS.md'
    );
  });

  it('rejects unsafe source paths and scopes', () => {
    const unsafePath = validRubric();
    const sources = unsafePath.sources as Record<string, unknown>[];
    sources[0].path = '../AGENTS.md';
    expect(() => parseGuidanceRubric(unsafePath)).toThrow(
      'must be a safe repository-relative path'
    );

    const unsafeScope = validRubric();
    const rules = unsafeScope.rules as Record<string, unknown>[];
    rules[0].scope = ['../src/**/*'];
    expect(() => parseGuidanceRubric(unsafeScope)).toThrow(
      'must be a safe repository-relative glob'
    );

    const windowsPath = validRubric();
    const windowsSources = windowsPath.sources as Record<string, unknown>[];
    windowsSources[0].path = 'C:/outside/AGENTS.md';
    expect(() => parseGuidanceRubric(windowsPath)).toThrow(
      'must be a safe repository-relative path'
    );
  });

  it('requires a canonical ISO compilation timestamp', () => {
    const candidate = validRubric();
    candidate.compiledAt = '2026-09-19';

    expect(() => parseGuidanceRubric(candidate)).toThrow(
      'compiledAt must be a canonical ISO timestamp'
    );
  });

  it('requires a probability gap between flag and act', () => {
    const candidate = validRubric();
    candidate.thresholds = { act: 0.8, flag: 0.8 };

    expect(() => parseGuidanceRubric(candidate)).toThrow(
      'flag threshold must be lower than act threshold'
    );
  });

  it('validates choice, score, and lint rule semantics', () => {
    const invalidChoice = validRubric();
    const choiceRule = (invalidChoice.rules as Record<string, unknown>[])[0];
    choiceRule.check = {
      type: 'model',
      question: {
        type: 'choice',
        instructions: 'Which implementation shape does the change use?',
        criteria: { compliant: 'Uses the required shape', violation: 'Uses the forbidden shape' },
        violating: ['missing'],
      },
    };
    expect(() => parseGuidanceRubric(invalidChoice)).toThrow('names an unknown violating option');

    const unboundedChoice = validRubric();
    const unboundedChoiceRule = (unboundedChoice.rules as Record<string, unknown>[])[0];
    unboundedChoiceRule.check = {
      type: 'model',
      question: {
        type: 'choice',
        instructions: 'Which implementation shape does the change use?',
        criteria: { compliant: 'Uses the required shape', ['x'.repeat(101)]: 'Too long' },
        violating: ['x'.repeat(101)],
      },
    };
    expect(() => parseGuidanceRubric(unboundedChoice)).toThrow('Guidance rubric is invalid');

    const invalidScore = validRubric();
    const scoreRule = (invalidScore.rules as Record<string, unknown>[])[0];
    scoreRule.check = {
      type: 'model',
      question: {
        type: 'score',
        instructions: 'How much unnecessary complexity does the change add?',
        criteria: ['none', 'substantial'],
        violatingFrom: 2,
      },
    };
    expect(() => parseGuidanceRubric(invalidScore)).toThrow('has an invalid violatingFrom index');

    const invalidLint = validRubric();
    const lintRule = (invalidLint.rules as Record<string, unknown>[])[0];
    lintRule.check = { type: 'lint' };
    expect(() => parseGuidanceRubric(invalidLint)).toThrow('must define how or pattern');
  });
});
