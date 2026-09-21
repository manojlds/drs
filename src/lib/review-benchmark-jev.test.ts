import { describe, expect, it } from 'vitest';
import {
  analyzeJevExpectedSignals,
  analyzeJevPairs,
  loadBenchmarkCase,
  loadBenchmarkSuite,
} from './review-benchmark.js';
import { metricKeys, type JevEvaluation, type MetricKey } from './jev/types.js';

const root = process.cwd();

function evaluation(
  scores: Partial<Record<MetricKey, number>>,
  priorities: MetricKey[] = []
): JevEvaluation {
  return {
    model: 'jev-test',
    metrics: Object.fromEntries(
      metricKeys.map((metric) => [
        metric,
        scores[metric] === undefined
          ? { applicable: false }
          : {
              applicable: true,
              score: scores[metric],
              confidence: 0.8,
              summary: 'Test signal.',
            },
      ])
    ) as JevEvaluation['metrics'],
    priorities: priorities.map((metric) => ({
      metric,
      severity: 'high',
      reason: 'Test priority.',
    })),
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

describe('historical Jev benchmark pilot', () => {
  it('loads historical cases and their expected weak dimensions', async () => {
    const suite = await loadBenchmarkSuite(root, 'jev-historical-pilot-v1');
    expect(suite.suite.cases).toHaveLength(10);
    expect((await loadBenchmarkCase(root, 't6a1-j8')).jev?.expectedWeakDimensions).toEqual([
      'security',
    ]);
  });

  it('summarizes expected-dimension applicability and priority hits', () => {
    const analysis = analyzeJevExpectedSignals([
      {
        caseId: 'defect',
        repeat: 1,
        expectedWeakDimensions: ['correctness', 'security'],
        evaluation: evaluation({ correctness: 4 }, ['correctness']),
      },
    ]);

    expect(analysis).toMatchObject({
      checkCount: 2,
      applicableRate: 0.5,
      priorityHitRate: 0.5,
      medianScore: 4,
    });
    expect(analysis.observations).toEqual([
      expect.objectContaining({
        caseId: 'defect',
        metric: 'correctness',
        applicable: true,
        priority: true,
        score: 4,
      }),
      expect.objectContaining({
        caseId: 'defect',
        metric: 'security',
        applicable: false,
        priority: false,
        score: null,
      }),
    ]);
  });

  it('reports movement for declared dimensions separately from all dimensions', () => {
    const analysis = analyzeJevPairs([
      {
        caseId: 'defect',
        repeat: 1,
        comparison: { group: 'condition', variant: 'defect' },
        expectedWeakDimensions: ['correctness'],
        evaluation: evaluation({ correctness: 3 }),
      },
      {
        caseId: 'fixed',
        repeat: 1,
        comparison: { group: 'condition', variant: 'fixed' },
        evaluation: evaluation({ correctness: 8 }),
      },
    ]);

    expect(analysis[0]).toMatchObject({
      expectedDimensions: ['correctness'],
      expectedDimensionImprovementRate: 1,
      expectedDirections: { correctness: 'improved' },
    });
  });
});
