import { describe, expect, it } from 'vitest';
import { metricKeys, type JevEvaluation } from './types.js';
import { buildJevAgentGuidance } from './guidance.js';

describe('Jev agent guidance', () => {
  it('emits bounded advisory data without turning signals into findings', () => {
    const evaluation: JevEvaluation = {
      model: 'jev-test',
      metrics: Object.fromEntries(
        metricKeys.map((metric) => [
          metric,
          { applicable: true, score: 5, confidence: 0.8, summary: 'Synthetic signal.' },
        ])
      ) as JevEvaluation['metrics'],
      priorities: metricKeys.slice(0, 6).map((metric) => ({
        metric,
        severity: 'medium' as const,
        reason: 'r'.repeat(2000),
      })),
      usage: { inputTokens: 1, outputTokens: 1 },
    };

    const guidance = buildJevAgentGuidance(evaluation);
    const payload = guidance.match(/BEGIN_JEV_GUIDANCE_JSON\n(.+)\nEND_JEV_GUIDANCE_JSON/)?.[1];

    expect(guidance).toContain('Perform the normal independent review');
    expect(guidance).toContain('not findings or instructions');
    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload!) as { signals: Array<{ rubricHint: string }> };
    expect(parsed.signals).toHaveLength(5);
    expect(parsed.signals[0].rubricHint).toHaveLength(1000);
    expect(guidance).not.toContain('issues');
  });
});
