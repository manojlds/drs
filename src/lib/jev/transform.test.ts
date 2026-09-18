import { describe, expect, it } from 'vitest';
import type { metricKeys } from './metrics.js';
import { metricDefinitions } from './metrics.js';
import { questionId } from './questions.js';
import { JevEvaluationError, toJevEvaluation } from './transform.js';
import type { JevResponse } from './schema.js';

function responseWithScores(scores: Partial<Record<(typeof metricKeys)[number], number>> = {}) {
  const answers: JevResponse['answers'] = {};
  for (const metric of metricDefinitions) {
    const score = scores[metric.key] ?? 8;
    answers[questionId(metric.key, 'applicable')] = { type: 'noul', noul: 1 };
    answers[questionId(metric.key, 'score')] = {
      type: 'score',
      score: score - 1,
      confidence: 0.81,
      probabilities: {},
      legend: {},
    };
    answers[questionId(metric.key, 'weakness')] = {
      type: 'choice',
      choice: Object.keys(metric.weaknesses).find((key) => key !== 'no_material_issue')!,
      confidence: 0.7,
      probabilities: {},
    };
  }
  return {
    model: 'jev-latest',
    answers,
    usage: { input_tokens: 100, output_tokens: 50 },
  } satisfies JevResponse;
}

describe('Jev evaluation transform', () => {
  it('preserves independent metric scores, confidence, model, usage, and no overall score', () => {
    const evaluation = toJevEvaluation(responseWithScores({ correctness: 4 }));

    expect(evaluation.model).toBe('jev-latest');
    expect(evaluation.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(evaluation.metrics.correctness).toMatchObject({
      applicable: true,
      score: 4,
      confidence: 0.81,
    });
    expect(evaluation).not.toHaveProperty('overallScore');
  });

  it('marks non-applicable metrics without score or confidence', () => {
    const response = responseWithScores();
    response.answers.performance_applicable = { type: 'noul', noul: 0.49 };

    const evaluation = toJevEvaluation(response);

    expect(evaluation.metrics.performance).toEqual({ applicable: false });
  });

  it('ranks at most five weak priorities with correctness/security/changeability weighting', () => {
    const evaluation = toJevEvaluation(
      responseWithScores({
        readability: 5,
        correctness: 5,
        security: 5,
        changeability: 5,
        documentation: 5,
        consistency: 5,
      })
    );

    expect(evaluation.priorities).toHaveLength(5);
    expect(new Set(evaluation.priorities.map((priority) => priority.metric).slice(0, 3))).toEqual(
      new Set(['correctness', 'changeability', 'security'])
    );
  });

  it('compares only meaningful rounded score deltas', () => {
    const previous = toJevEvaluation(responseWithScores({ correctness: 7, security: 7 }));
    const current = toJevEvaluation(
      responseWithScores({ correctness: 7.74, security: 6.24 }),
      previous
    );

    expect(current.comparison?.find((entry) => entry.metric === 'correctness')).toMatchObject({
      delta: 0.7,
      direction: 'unchanged',
    });
    expect(current.comparison?.find((entry) => entry.metric === 'security')).toMatchObject({
      delta: -0.8,
      direction: 'regressed',
    });
  });

  it('fails closed when Jev omits a required decision', () => {
    const response = responseWithScores();
    delete response.answers.correctness_score;

    expect(() => toJevEvaluation(response)).toThrow(JevEvaluationError);
  });

  it('fails closed when Jev selects an unknown weakness category', () => {
    const response = responseWithScores({ correctness: 4 });
    response.answers.correctness_weakness = {
      type: 'choice',
      choice: 'invented_category',
      confidence: 0.9,
      probabilities: {},
    };

    expect(() => toJevEvaluation(response)).toThrow(JevEvaluationError);
  });
});
