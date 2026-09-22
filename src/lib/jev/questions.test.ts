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
    expect(weakness.instructions).toMatchObject({
      question: expect.stringContaining('most strongly evidenced'),
      inspect: [
        '`change.diff`',
        '`change.repository`',
        '`change.summary`',
        '`change.manifest`',
        '`change.segment`',
      ],
      boundary: expect.stringContaining('Do not speculate'),
    });
    expect(weakness.criteria.no_material_issue).toMatchObject({
      what: expect.stringContaining('No material issue'),
    });
  });

  it('uses structured, path-specific instructions and non-numeric score levels', () => {
    const questions = buildJevQuestions();
    const score = questions.correctness_score;
    const applicable = questions.correctness_applicable;
    if (score.type !== 'score' || applicable.type !== 'noul') {
      throw new Error('Expected score and applicability questions');
    }

    expect(score.instructions).toMatchObject({
      question: expect.stringContaining('`change.diff`'),
      inspect: [
        '`change.diff`',
        '`change.repository`',
        '`change.summary`',
        '`change.manifest`',
        '`change.segment`',
      ],
    });
    expect(applicable.criteria.true).toMatchObject({
      requires: expect.stringContaining('`change.diff`'),
    });
    expect(score.criteria).toHaveLength(10);
    expect(score.criteria[0]).not.toMatch(/^\d/);
  });

  it('distinguishes core dimensions from conditionally relevant dimensions', () => {
    const questions = buildJevQuestions();
    const correctness = questions.correctness_applicable;
    const performance = questions.performance_applicable;

    expect(correctness.instructions).toMatchObject({
      question: expect.stringContaining('enough evidence to assess'),
      boundary: expect.stringContaining('Answer no when'),
    });
    expect(performance.instructions).toMatchObject({
      question: expect.stringContaining('relevant to the implementation'),
      boundary: expect.stringContaining('Answer yes only when'),
    });
  });
});
