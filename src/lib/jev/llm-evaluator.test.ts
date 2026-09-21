import { describe, expect, it, vi } from 'vitest';
import { metricDefinitions } from './metrics.js';
import { buildLlmQualityPrompt, evaluateQualityWithLlm } from './llm-evaluator.js';

function response(definitions = metricDefinitions) {
  return JSON.stringify({
    metrics: Object.fromEntries(
      definitions.map((definition) => [
        definition.key,
        [
          definition.key === 'correctness',
          definition.key === 'correctness' ? 3 : 8,
          definition.key === 'correctness' ? 'regression_risk' : 'no_material_issue',
        ],
      ])
    ),
  });
}

function completion(text: string, stopReason: 'stop' | 'length' = 'stop') {
  return {
    text,
    provider: 'test',
    requestedModel: 'model',
    resolvedModel: 'model-v1',
    stopReason,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
  } as const;
}

describe('LLM quality evaluator', () => {
  it('includes the exact state JSON and all Jev questions in the prompt', () => {
    const stateJson = '{"task":"review","diff":"patch","repositoryContext":"{}"}';
    const prompt = buildLlmQualityPrompt(stateJson);
    expect(prompt.userPrompt).toContain(stateJson);
    expect(prompt.userPrompt).toContain('correctness_applicable');
    expect(prompt.userPrompt).toContain('observability_weakness');
  });

  it('normalizes strict model output through the Jev transformation', async () => {
    let call = 0;
    const runtime = {
      completeSimple: vi.fn().mockImplementation(() => {
        const definitions = metricDefinitions.slice(call * 5, call * 5 + 5);
        call += 1;
        return completion(response(definitions));
      }),
    };
    const result = await evaluateQualityWithLlm(runtime, 'test/model', '{"task":"review"}');

    expect(runtime.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test/model', temperature: 0 })
    );
    expect(runtime.completeSimple).toHaveBeenCalledTimes(4);
    expect(result.evaluation.model).toBe('test/model-v1');
    expect(result.evaluation.metrics.correctness).toMatchObject({
      applicable: true,
      score: 3,
      confidence: 1,
    });
    expect(result.evaluation.metrics.performance).toEqual({ applicable: false });
    expect(result.evaluation.metrics.security).toMatchObject({ applicable: true, score: 8 });
    expect(result.evaluation.priorities[0]).toMatchObject({ metric: 'correctness' });
    expect(result.evaluation.usage).toEqual({ inputTokens: 400, outputTokens: 80 });
  });

  it('supplies the OpenCode Go routing session header without enabling tools', async () => {
    const runtime = { completeSimple: vi.fn().mockResolvedValue(completion(response())) };
    await evaluateQualityWithLlm(runtime, 'opencode-go/model', '{}', { batchSize: 19 });

    expect(runtime.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'x-opencode-session': expect.any(String) },
      })
    );
  });

  it('rejects truncated completions and invalid metric choices', async () => {
    await expect(
      evaluateQualityWithLlm(
        {
          completeSimple: vi
            .fn()
            .mockResolvedValue(completion(response(metricDefinitions.slice(0, 5)), 'length')),
        },
        'test/model',
        '{}'
      )
    ).rejects.toThrow(/length/);

    const parsed = JSON.parse(response());
    parsed.metrics.correctness[2] = 'invented';
    await expect(
      evaluateQualityWithLlm(
        { completeSimple: vi.fn().mockResolvedValue(completion(JSON.stringify(parsed))) },
        'test/model',
        '{}',
        { batchSize: 19 }
      )
    ).rejects.toThrow(/unknown weakness/);
  });
});
