import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBenchmarkCommand } from './benchmark.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('benchmark command', () => {
  it('passes repeatable models and validated options without exiting', async () => {
    const run = vi.fn(async () => ({
      jsonPath: 'result.json',
      markdownPath: 'result.md',
      report: {},
    }));
    const command = createBenchmarkCommand(run);
    command.exitOverride();
    await command.parseAsync(
      [
        'review',
        '--suite',
        'development-v1',
        '--model',
        'a/one',
        '--model',
        'b/two',
        '--repeat',
        '2',
        '--live',
      ],
      { from: 'user' }
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        models: ['a/one', 'b/two'],
        repeat: 2,
        live: true,
        profile: 'isolated',
      })
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a non-positive repeat before running', async () => {
    const run = vi.fn();
    const command = createBenchmarkCommand(run);
    command.exitOverride();
    await expect(
      command.parseAsync(
        ['review', '--suite', 'development-v1', '--model', 'a/one', '--repeat', '0'],
        { from: 'user' }
      )
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
