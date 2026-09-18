import { describe, expect, it } from 'vitest';
import { metricDefinitions, metricKeys } from './metrics.js';
import { buildJevQuestions, questionId } from './questions.js';

describe('Jev questions', () => {
  it('builds applicability, score, and weakness decisions for all 19 metrics', () => {
    const questions = buildJevQuestions();

    expect(metricKeys).toHaveLength(19);
    expect(Object.keys(questions)).toHaveLength(57);
    for (const metric of metricDefinitions) {
      expect(questions[questionId(metric.key, 'applicable')]).toMatchObject({ type: 'noul' });
      expect(questions[questionId(metric.key, 'score')]).toMatchObject({ type: 'score' });
      expect(questions[questionId(metric.key, 'weakness')]).toMatchObject({ type: 'choice' });
    }
  });

  it('keeps weakness choices as rubric hints rather than root-cause findings', () => {
    const questions = buildJevQuestions();
    const weakness = questions.correctness_weakness;

    expect(weakness.type).toBe('choice');
    if (weakness.type !== 'choice') throw new Error('Expected weakness question');
    expect(weakness.instructions).toContain('single most consequential');
    expect(weakness.instructions).toContain('Do not speculate');
    expect(weakness.criteria.no_material_issue).toContain('No material issue');
  });
});
