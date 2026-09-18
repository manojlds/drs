import { describe, expect, it } from 'vitest';
import { metricKeys, type JevEvaluation } from './types.js';
import {
  createJevPrBaseline,
  createJevPrTrend,
  encodeJevPrBaselineMarker,
  extractJevPrBaseline,
} from './pr-trend.js';

function evaluation(
  scores: Partial<Record<(typeof metricKeys)[number], number>>,
  model = 'jev-1.13.0'
): JevEvaluation {
  return {
    model,
    metrics: Object.fromEntries(
      metricKeys.map((metric) => {
        const score = scores[metric];
        return [
          metric,
          score === undefined
            ? { applicable: false }
            : {
                applicable: true,
                score,
                confidence: 0.8,
                summary: `${metric} summary`,
              },
        ];
      })
    ) as JevEvaluation['metrics'],
    priorities: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe('Jev PR trend baseline', () => {
  it('round-trips a validated baseline through a hidden comment marker', () => {
    const baseline = createJevPrBaseline(evaluation({ correctness: 6.2 }), 'abc123');
    const marker = encodeJevPrBaselineMarker(baseline);

    expect(marker).toMatch(/^<!-- drs-jev-pr-baseline-v1: [A-Za-z0-9_-]+ -->$/);
    expect(extractJevPrBaseline(`summary\n${marker}`)).toEqual(baseline);
  });

  it('accepts only the terminal baseline marker and ignores injected markers in content', () => {
    const forged = encodeJevPrBaselineMarker(
      createJevPrBaseline(evaluation({ correctness: 1 }), 'attacker')
    );
    const authentic = encodeJevPrBaselineMarker(
      createJevPrBaseline(evaluation({ correctness: 8 }), 'trusted')
    );

    expect(extractJevPrBaseline(`model output ${forged}\nfooter`)).toBeUndefined();
    expect(extractJevPrBaseline(`model output ${forged}\nfooter\n${authentic}\n`)).toMatchObject({
      headSha: 'trusted',
      metrics: { correctness: { applicable: true, score: 8 } },
    });
  });

  it('rejects malformed or incomplete baseline markers', () => {
    const malformed = Buffer.from(JSON.stringify({ version: 1, model: 'jev-latest' })).toString(
      'base64url'
    );

    expect(extractJevPrBaseline(`<!-- drs-jev-pr-baseline-v1: ${malformed} -->`)).toBeUndefined();
    expect(extractJevPrBaseline('<!-- drs-jev-pr-baseline-v1: !!! -->')).toBeUndefined();
  });

  it('rejects valid base64 state with extra fields, confidence, or out-of-range scores', () => {
    const baseline = createJevPrBaseline(evaluation({ correctness: 6 }), 'first');
    const markerFor = (value: unknown) =>
      `<!-- drs-jev-pr-baseline-v1: ${Buffer.from(JSON.stringify(value)).toString('base64url')} -->`;

    expect(extractJevPrBaseline(markerFor({ ...baseline, extra: true }))).toBeUndefined();
    expect(
      extractJevPrBaseline(
        markerFor({
          ...baseline,
          metrics: {
            ...baseline.metrics,
            correctness: { applicable: true, score: 6, confidence: 0.8 },
          },
        })
      )
    ).toBeUndefined();
    expect(
      extractJevPrBaseline(
        markerFor({
          ...baseline,
          metrics: {
            ...baseline.metrics,
            correctness: { applicable: true, score: 11 },
          },
        })
      )
    ).toBeUndefined();
  });

  it('compares current applicable dimensions with the immutable first run', () => {
    const baseline = createJevPrBaseline(
      evaluation({ correctness: 6, reliability: 7, security: 5 }),
      'first'
    );
    const trend = createJevPrTrend(
      baseline,
      evaluation({ correctness: 8, reliability: 7.2, readability: 7 }),
      'current'
    );

    expect(trend.comparable).toBe(true);
    expect(trend.baselineHeadSha).toBe('first');
    expect(trend.currentHeadSha).toBe('current');
    expect(trend.entries.find((entry) => entry.metric === 'correctness')).toMatchObject({
      baselineScore: 6,
      currentScore: 8,
      delta: 2,
      direction: 'improved',
    });
    expect(trend.entries.find((entry) => entry.metric === 'reliability')).toMatchObject({
      direction: 'unchanged',
    });
    expect(trend.entries.find((entry) => entry.metric === 'readability')).toMatchObject({
      direction: 'newly-applicable',
    });
    expect(trend.entries.find((entry) => entry.metric === 'security')).toMatchObject({
      baselineScore: 5,
      direction: 'no-longer-applicable',
    });
    expect(trend.entries.some((entry) => entry.metric === 'projectStructure')).toBe(false);
  });

  it('uses the documented 0.75 meaningful-change threshold after one-decimal rounding', () => {
    const baseline = createJevPrBaseline(evaluation({ correctness: 6 }), 'first');

    expect(createJevPrTrend(baseline, evaluation({ correctness: 6.7 })).entries[0]).toMatchObject({
      delta: 0.7,
      direction: 'unchanged',
    });
    expect(createJevPrTrend(baseline, evaluation({ correctness: 6.8 })).entries[0]).toMatchObject({
      delta: 0.8,
      direction: 'improved',
    });
  });

  it('suppresses numeric comparisons when the returned Jev model changes', () => {
    const baseline = createJevPrBaseline(evaluation({ correctness: 6 }, 'jev-1'), 'first');
    const trend = createJevPrTrend(baseline, evaluation({ correctness: 8 }, 'jev-2'), 'current');

    expect(trend).toMatchObject({ comparable: false, reason: 'model-changed', entries: [] });
  });
});
