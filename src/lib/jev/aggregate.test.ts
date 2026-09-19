import { describe, expect, it } from 'vitest';
import { aggregateJevResponses } from './aggregate.js';
import type { JevChunkEvaluation } from './chunks.js';

function chunk(weight: number, score: number, typed: number): JevChunkEvaluation {
  return {
    weight,
    fileNames: [`src/${weight}.ts`],
    response: {
      model: 'jev-test',
      answers: {
        applicable: { type: 'noul', noul: typed },
        score: {
          type: 'score',
          score,
          legend: { '0': 'weak', '1': 'strong' },
          probabilities: { '0': 1 - score, '1': score },
          confidence: typed,
        },
        choice: {
          type: 'choice',
          choice: typed >= 0.5 ? 'safe' : 'unsafe',
          probabilities: { safe: typed, unsafe: 1 - typed },
          confidence: typed,
        },
      },
      usage: { input_tokens: weight, output_tokens: 2 },
    },
  };
}

describe('aggregateJevResponses', () => {
  it('combines distributions by visible-diff weight and sums usage', () => {
    const result = aggregateJevResponses([chunk(1, 0.2, 0.2), chunk(3, 0.8, 0.8)]);

    expect(result).toMatchObject({
      model: 'jev-test',
      usage: { input_tokens: 4, output_tokens: 4 },
      answers: {
        applicable: { type: 'noul', noul: 0.65 },
        score: { type: 'score', score: 0.65, confidence: 0.65 },
        choice: { type: 'choice', choice: 'safe', confidence: 0.65 },
      },
    });
    expect(result.answers.score).toMatchObject({
      probabilities: { '0': 0.35, '1': 0.65 },
    });
  });

  it('rejects inconsistent model identities', () => {
    const first = chunk(1, 0.5, 0.5);
    const second = chunk(1, 0.5, 0.5);
    second.response.model = 'other-model';

    expect(() => aggregateJevResponses([first, second])).toThrow('inconsistent model identities');
  });

  it('aggregates selected choices when probability maps are empty', () => {
    const first = chunk(1, 0.5, 0.2);
    const second = chunk(3, 0.5, 0.8);
    if (first.response.answers.choice.type !== 'choice') throw new Error('Expected choice.');
    if (second.response.answers.choice.type !== 'choice') throw new Error('Expected choice.');
    first.response.answers.choice.probabilities = {};
    second.response.answers.choice.probabilities = {};

    expect(aggregateJevResponses([first, second]).answers.choice).toMatchObject({
      type: 'choice',
      choice: 'safe',
      probabilities: {},
    });
  });
});
