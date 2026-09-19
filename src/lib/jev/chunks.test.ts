import { describe, expect, it, vi } from 'vitest';
import { JevClientError } from './client.js';
import { evaluateJevChunks, estimateJevRequestTokens } from './chunks.js';
import type { JevQuestions } from './questions.js';
import type { JevResponse } from './schema.js';
import type { JevReviewState } from './review.js';

const questions: JevQuestions = {
  relevant: {
    type: 'noul',
    instructions: 'Is this relevant?',
    criteria: { true: 'Relevant', false: 'Not relevant' },
  },
};

function response(inputTokens = 10): JevResponse {
  return {
    model: 'jev-test',
    answers: { relevant: { type: 'noul', noul: 0.8 } },
    usage: { input_tokens: inputTokens, output_tokens: 1 },
  };
}

describe('evaluateJevChunks', () => {
  it('packs complete patches into multiple bounded requests without summary-only states', async () => {
    const evaluate = vi.fn(async (_state: JevReviewState, _questions: JevQuestions) => response());
    const chunks = await evaluateJevChunks({
      label: 'Large change',
      files: [
        {
          filename: 'src/a.ts',
          patch: Array(90)
            .fill(`+${'a'.repeat(20)}`)
            .join('\n'),
        },
        {
          filename: 'src/b.ts',
          patch: Array(90)
            .fill(`+${'b'.repeat(20)}`)
            .join('\n'),
        },
      ],
      contextWindow: 1000,
      questions,
      evaluate,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect([...new Set(chunks.flatMap((chunk) => chunk.fileNames))].sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    for (const [state] of evaluate.mock.calls) {
      expect(state.diff).toContain('```diff');
      expect(state.diff).not.toContain('No inline patch');
      expect(state.changeManifest).toEqual(['src/a.ts', 'src/b.ts']);
      expect(estimateJevRequestTokens(state, questions)).toBeLessThanOrEqual(800);
    }
  });

  it('losslessly splits a single diff line that exceeds the request budget', async () => {
    const patch = `+${'x'.repeat(3000)}`;
    const states: JevReviewState[] = [];
    const chunks = await evaluateJevChunks({
      label: 'Long generated line',
      files: [{ filename: 'generated.txt', patch }],
      contextWindow: 1000,
      questions,
      evaluate: async (state) => {
        states.push(state);
        return response();
      },
    });

    const reconstructed = states
      .map((state) => state.diff.match(/```diff\n([\s\S]*?)\n```/)?.[1] ?? '')
      .join('');
    expect(states.length).toBeGreaterThan(1);
    expect(reconstructed).toBe(patch);
    expect(states.every((state) => estimateJevRequestTokens(state, questions) <= 800)).toBe(true);
    expect(chunks.reduce((bytes, chunk) => bytes + chunk.weight, 0)).toBe(
      Buffer.byteLength(patch, 'utf8')
    );
  });

  it('recursively splits and retries an API token-limit rejection', async () => {
    let calls = 0;
    const patch = '+line ending\n';
    const evaluate = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new JevClientError('token_limit', 'too large', 400);
      return response();
    });
    const chunks = await evaluateJevChunks({
      label: 'Adaptive change',
      files: [{ filename: 'src/app.ts', patch }],
      contextWindow: 10_000,
      questions,
      evaluate,
    });

    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.fileNames[0] === 'src/app.ts')).toBe(true);
    expect(chunks.reduce((bytes, chunk) => bytes + chunk.weight, 0)).toBe(
      Buffer.byteLength(patch, 'utf8')
    );
  });

  it('fails instead of evaluating a filename-only change', async () => {
    await expect(
      evaluateJevChunks({
        label: 'Incomplete change',
        files: [{ filename: 'src/app.ts' }],
        contextWindow: 10_000,
        questions,
        evaluate: vi.fn(),
      })
    ).rejects.toThrow('requires complete patches');
  });

  it('accepts complete-but-empty patches and counts them as evaluated coverage', async () => {
    const evaluate = vi.fn(async (_state: JevReviewState, _questions: JevQuestions) => response());
    const chunks = await evaluateJevChunks({
      label: 'Mixed change',
      files: [
        { filename: 'src/a.ts', patch: '+const a = 1;' },
        { filename: 'assets/logo.png', patch: '' },
        { filename: 'src/script.sh', patch: '   ' },
      ],
      contextWindow: 10_000,
      questions,
      evaluate,
    });

    expect(chunks.length).toBe(1);
    expect(chunks[0].fileNames.sort()).toEqual(['assets/logo.png', 'src/a.ts', 'src/script.sh']);
    const [state] = evaluate.mock.calls[0];
    expect(state.diff).toContain('src/a.ts');
    expect(state.diff).not.toContain('assets/logo.png');
    expect(state.changeManifest).toEqual(['src/a.ts', 'assets/logo.png', 'src/script.sh']);
  });

  it('keeps empty-patch files in coverage after adaptive splitting', async () => {
    let calls = 0;
    const evaluate = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new JevClientError('token_limit', 'too large', 400);
      return response();
    });
    const chunks = await evaluateJevChunks({
      label: 'Adaptive mixed change',
      files: [
        { filename: 'src/app.ts', patch: '+line ending\n' },
        { filename: 'assets/logo.png', patch: '' },
      ],
      contextWindow: 10_000,
      questions,
      evaluate,
    });

    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(chunks).toHaveLength(2);
    const evaluatedFileNames = [...new Set(chunks.flatMap((chunk) => chunk.fileNames))].sort();
    expect(evaluatedFileNames).toEqual(['assets/logo.png', 'src/app.ts']);
  });

  it('evaluates a change with only empty patches as a no-content review', async () => {
    const evaluate = vi.fn(async (_state: JevReviewState, _questions: JevQuestions) => response());
    const chunks = await evaluateJevChunks({
      label: 'Mode-only change',
      files: [{ filename: 'src/script.sh', patch: '' }],
      contextWindow: 10_000,
      questions,
      evaluate,
    });

    expect(chunks.length).toBe(1);
    expect(chunks[0].fileNames).toEqual(['src/script.sh']);
    const [state] = evaluate.mock.calls[0];
    expect(state.diff).toContain('No inline patch');
  });

  it('estimates the entire serialized request using UTF-8 bytes', () => {
    const state = {
      task: 'Evaluate.',
      diff: '+ const message = "こんにちは";',
      repositoryContext: '{}',
    };
    const serialized = JSON.stringify({ state, model: 'jev-latest', questions });

    expect(estimateJevRequestTokens(state, questions)).toBe(
      Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3)
    );
  });
});
