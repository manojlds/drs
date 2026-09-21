import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { metricKeys, type JevEvaluation } from './jev/types.js';
import { runQualityBenchmark } from './quality-benchmark.js';

const root = process.cwd();
const output = 'out/quality-benchmark-test';

function evaluation(model: string, score: number): JevEvaluation {
  return {
    model,
    metrics: Object.fromEntries(
      metricKeys.map((metric) => [
        metric,
        {
          applicable: true,
          score,
          confidence: model === 'jev-test' ? 0.8 : 1,
          summary: 'Test quality signal.',
        },
      ])
    ) as JevEvaluation['metrics'],
    priorities: score < 8 ? [{ metric: 'correctness', severity: 'medium', reason: 'Test.' }] : [],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

afterEach(async () => {
  await rm(join(root, output), { recursive: true, force: true });
});

describe('quality benchmark', () => {
  it('uses identical prepared state for Jev and every LLM evaluator', async () => {
    const previousKey = process.env.JEV_API_KEY;
    process.env.JEV_API_KEY = 'test-key';
    const jevStates: string[] = [];
    const llmStates: string[] = [];
    try {
      const result = await runQualityBenchmark(
        {
          projectRoot: root,
          suite: 'jev-calibration-v1',
          models: ['test/model'],
          profile: 'isolated',
          repeat: 1,
          output,
          live: true,
        },
        {
          onProgress: () => {},
          evaluateJev: async (state) => {
            jevStates.push(JSON.stringify(state));
            return evaluation('jev-test', 4);
          },
          evaluateLlm: async (_model, stateJson) => {
            llmStates.push(stateJson);
            return {
              evaluation: evaluation('test/model-v1', 6),
              completion: {
                text: '{}',
                provider: 'test',
                requestedModel: 'model',
                resolvedModel: 'model-v1',
                stopReason: 'stop',
                usage: {
                  input: 20,
                  output: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 30,
                  cost: {
                    input: 0.01,
                    output: 0.02,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0.03,
                  },
                },
              },
            };
          },
        }
      );

      expect(jevStates).toEqual(llmStates);
      const report = result.report as any;
      expect(report.runs).toHaveLength(12);
      expect(report.evaluators).toEqual(['jev', 'llm:test/model']);
      expect(report.agreementWithJev['llm:test/model']).toMatchObject({
        pairedRuns: 6,
        applicabilityAgreement: 1,
        scoreMeanAbsoluteDifference: 2,
      });
      for (const caseId of new Set(report.runs.map((run: any) => run.caseId))) {
        expect(
          new Set(
            report.runs
              .filter((run: any) => run.caseId === caseId)
              .map((run: any) => run.stateSha256)
          ).size
        ).toBe(1);
      }
      const markdown = await readFile(result.markdownPath, 'utf8');
      expect(markdown).toContain('## Ground-truth signals');
      expect(markdown).toContain('## Agreement with Jev');
      expect(markdown).toContain('LLM confidence is synthetic');
    } finally {
      if (previousKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousKey;
    }
  }, 15_000);
});
