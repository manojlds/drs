import { describe, expect, it, vi } from 'vitest';
import type { ReviewSource } from '../review-orchestrator.js';
import { evaluateGuidanceCompliance, formatGuidanceComplianceReport } from './evaluator.js';
import { parseGuidanceRubric, type GuidanceRubric } from './rubric.js';

const SHA = 'a'.repeat(64);

function rubric(): GuidanceRubric {
  return parseGuidanceRubric({
    version: 1,
    compiledAt: '2026-09-19T12:00:00.000Z',
    compiledBy: 'task/guidance-compiler',
    sources: [
      { path: 'AGENTS.md', sha256: SHA, scope: '**/*' },
      { path: 'src/api/AGENTS.md', sha256: 'b'.repeat(64), scope: 'src/api/**/*' },
    ],
    thresholds: { act: 0.8, flag: 0.5 },
    rules: [
      {
        id: 'boolean-rule',
        text: 'Do not add single-use helpers.',
        source: { path: 'AGENTS.md', line: 1 },
        scope: ['src/**/*.ts'],
        when: 'change',
        status: 'active',
        check: {
          type: 'model',
          question: {
            type: 'boolean',
            instructions: 'Does the change add a single-use helper?',
            violating: true,
          },
        },
      },
      {
        id: 'choice-rule',
        text: 'Use typed errors.',
        source: { path: 'AGENTS.md', line: 2 },
        scope: ['src/**/*.ts'],
        when: 'change',
        status: 'active',
        check: {
          type: 'model',
          question: {
            type: 'choice',
            instructions: 'What error shape does the change introduce?',
            criteria: { typed: 'Typed domain error', raw: 'Raw Error' },
            violating: ['raw'],
          },
        },
      },
      {
        id: 'score-rule',
        text: 'Keep API handlers simple.',
        source: { path: 'src/api/AGENTS.md', line: 1 },
        scope: ['src/api/**/*.ts'],
        when: 'change',
        status: 'active',
        check: {
          type: 'model',
          question: {
            type: 'score',
            instructions: 'How much unnecessary complexity does the handler add?',
            criteria: ['none', 'minor', 'substantial'],
            violatingFrom: 2,
          },
        },
      },
      {
        id: 'lint-rule',
        text: 'Do not use console.log.',
        source: { path: 'AGENTS.md', line: 3 },
        scope: ['**/*.ts'],
        when: 'change',
        status: 'active',
        check: { type: 'lint', pattern: 'console\\.log' },
      },
      {
        id: 'suppressed-rule',
        text: 'A noisy rule.',
        source: { path: 'AGENTS.md', line: 4 },
        scope: ['**/*'],
        when: 'change',
        status: 'noisy',
        check: {
          type: 'model',
          question: {
            type: 'boolean',
            instructions: 'Is this noisy?',
            violating: true,
          },
        },
      },
      {
        id: 'out-of-scope-rule',
        text: 'Documentation rule.',
        source: { path: 'AGENTS.md', line: 5 },
        scope: ['docs/**/*'],
        when: 'change',
        status: 'active',
        check: {
          type: 'model',
          question: {
            type: 'boolean',
            instructions: 'Does documentation violate the rule?',
            violating: true,
          },
        },
      },
    ],
  });
}

function source(): ReviewSource {
  return {
    name: 'PR #42',
    files: ['src/main.ts', 'src/api/handler.ts'],
    filesWithDiffs: [
      { filename: 'src/main.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
      { filename: 'src/api/handler.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
    ],
    context: { pullRequest: { headSha: 'abc123' } },
  };
}

describe('evaluateGuidanceCompliance', () => {
  it('groups identical scopes and transforms boolean, choice, and score probabilities', async () => {
    const evaluate = vi.fn(async (_state: unknown, questions: unknown) => {
      const ids = Object.keys(questions as Record<string, unknown>);
      if (ids.includes('guidance_score-rule')) {
        return {
          model: 'jev-latest',
          answers: {
            'guidance_score-rule': {
              type: 'score' as const,
              score: 1,
              legend: { '0': 'none', '1': 'minor', '2': 'substantial' },
              probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 20, output_tokens: 0 },
        };
      }
      return {
        model: 'jev-latest',
        answers: {
          'guidance_boolean-rule': { type: 'noul' as const, noul: 0.85 },
          'guidance_choice-rule': {
            type: 'choice' as const,
            choice: 'raw',
            probabilities: { typed: 0.4, raw: 0.6 },
            confidence: 0.7,
          },
        },
        usage: { input_tokens: 30, output_tokens: 0 },
      };
    });

    const result = await evaluateGuidanceCompliance(
      rubric(),
      source(),
      { evaluate: evaluate as never },
      {
        now: () => new Date('2026-09-19T13:00:00.000Z'),
        pricing: { 'jev-latest': { input: 1, output: 2 } },
      }
    );

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      schemaVersion: 1,
      evaluatedAt: '2026-09-19T13:00:00.000Z',
      reviewedSha: 'abc123',
      model: 'jev-latest',
      summary: {
        evaluated: 3,
        act: 1,
        flag: 1,
        clear: 1,
        outOfScope: 1,
        suppressed: 1,
        unsupported: 1,
      },
      usage: { inputTokens: 50, outputTokens: 0, requests: 2, cost: 0.00005 },
    });
    expect(result.rules.find((rule) => rule.id === 'boolean-rule')).toMatchObject({
      probability: 0.85,
      band: 'act',
    });
    expect(result.rules.find((rule) => rule.id === 'choice-rule')).toMatchObject({
      probability: 0.6,
      band: 'flag',
    });
    expect(result.rules.find((rule) => rule.id === 'score-rule')).toMatchObject({
      probability: 0.2,
      band: 'clear',
      applicableFiles: ['src/api/handler.ts'],
    });
    expect(result.report).toContain('DRS Guidance Compliance');
    expect(result.report).toContain('not a merge gate');
    expect(result.report).toContain('3 evaluated · 1 out of scope · 1 suppressed · 1 unsupported');
    expect(result.report).toContain('# 🧭 DRS Guidance Compliance');
    expect(result.report).toContain('## 💰 Model Usage');
    expect(result.report).toContain('<summary>View token and cost breakdown</summary>');
    expect(result.report).toContain('**Estimated Cost**: $0.0001');
    expect(result.report).toContain('<summary>View all guidance rule outcomes</summary>');
    expect(result.report).toContain('⏭️ Unsupported');
  });

  it('does not call Jev when no active model rule is in scope', async () => {
    const evaluate = vi.fn();
    const change = source();
    change.files = ['README.md'];
    change.filesWithDiffs = [{ filename: 'README.md', patch: '@@ -1 +1 @@\n-old\n+new' }];

    const result = await evaluateGuidanceCompliance(rubric(), change, { evaluate });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.summary.evaluated).toBe(0);
  });

  it('fails instead of treating a missing in-scope patch as compliant', async () => {
    const change = source();
    change.filesWithDiffs = [{ filename: 'src/main.ts', patch: '@@ -1 +1 @@\n-old\n+new' }];

    await expect(
      evaluateGuidanceCompliance(rubric(), change, { evaluate: vi.fn() })
    ).rejects.toThrow('requires a complete patch for in-scope file: src/api/handler.ts');
  });

  it('fails on an omitted or mismatched Jev answer', async () => {
    const evaluate = vi.fn(async () => ({
      model: 'jev-latest',
      answers: {},
      usage: { input_tokens: 1, output_tokens: 0 },
    }));

    await expect(evaluateGuidanceCompliance(rubric(), source(), { evaluate })).rejects.toThrow(
      'Jev omitted the guidance decision'
    );
  });

  it('fails on incomplete or inconsistent choice probabilities', async () => {
    const change = source();
    change.files = ['src/main.ts'];
    change.filesWithDiffs = [{ filename: 'src/main.ts', patch: '@@ -1 +1 @@\n-old\n+new' }];

    for (const answer of [
      {
        type: 'choice' as const,
        choice: 'raw',
        probabilities: { typed: 1 },
        confidence: 1,
      },
      {
        type: 'choice' as const,
        choice: 'raw',
        probabilities: { typed: 0.8, raw: 0.2 },
        confidence: 1,
      },
    ]) {
      const evaluate = vi.fn(async () => ({
        model: 'jev-latest',
        answers: {
          'guidance_boolean-rule': { type: 'noul' as const, noul: 0 },
          'guidance_choice-rule': answer,
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      }));

      await expect(
        evaluateGuidanceCompliance(rubric(), change, { evaluate: evaluate as never })
      ).rejects.toThrow(/invalid choice probabilities|inconsistent choice/);
    }
  });

  it('fails on incomplete or out-of-range score probabilities', async () => {
    const evaluate = vi.fn(async (_state: unknown, questions: unknown) => {
      if (Object.keys(questions as Record<string, unknown>).includes('guidance_score-rule')) {
        return {
          model: 'jev-latest',
          answers: {
            'guidance_score-rule': {
              type: 'score' as const,
              score: -1,
              legend: {},
              probabilities: { '0': 1 },
              confidence: 1,
            },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        };
      }
      return {
        model: 'jev-latest',
        answers: {
          'guidance_boolean-rule': { type: 'noul' as const, noul: 0 },
          'guidance_choice-rule': {
            type: 'choice' as const,
            choice: 'typed',
            probabilities: { typed: 1, raw: 0 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    });

    await expect(
      evaluateGuidanceCompliance(rubric(), source(), { evaluate: evaluate as never })
    ).rejects.toThrow('invalid score probabilities');
  });

  it('renders untrusted filenames as inert inline code', async () => {
    const result = await evaluateGuidanceCompliance(rubric(), source(), {
      evaluate: vi.fn(async (_state: unknown, questions: unknown) => {
        const answers = Object.fromEntries(
          Object.keys(questions as Record<string, unknown>).map((id) => [
            id,
            id === 'guidance_score-rule'
              ? {
                  type: 'score',
                  score: 0,
                  legend: {},
                  probabilities: { '0': 1, '1': 0, '2': 0 },
                  confidence: 1,
                }
              : id === 'guidance_choice-rule'
                ? {
                    type: 'choice',
                    choice: 'raw',
                    probabilities: { typed: 0, raw: 1 },
                    confidence: 1,
                  }
                : { type: 'noul', noul: 1 },
          ])
        );
        return {
          model: 'jev-latest',
          answers,
          usage: { input_tokens: 1, output_tokens: 0 },
        };
      }) as never,
    });
    const choice = result.rules.find((rule) => rule.id === 'choice-rule');
    if (!choice) throw new Error('Expected choice-rule evaluation.');
    choice.applicableFiles = ['a`[click](https://example.com)|x.ts'];
    const report = formatGuidanceComplianceReport(result);

    expect(report).toContain(
      '<code>a&#x60;&#x5b;click&#x5d;&#x28;https://example.com&#x29;&#x7c;x.ts</code>'
    );
    expect(report).not.toContain('[click](https://example.com)');
  });
});
