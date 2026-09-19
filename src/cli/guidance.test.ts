import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuidanceCommand } from './guidance.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('guidance command', () => {
  it('compiles guidance for the current project', async () => {
    const compile = vi.fn(async () => ({
      outputPath: '.drs/guidance-rubric.json',
      rubric: { rules: [{ id: 'one' }, { id: 'two' }] },
    }));
    const load = vi.fn(() => ({ marker: true }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const command = createGuidanceCommand(compile as never, load as never);
    command.exitOverride();

    await command.parseAsync(['compile'], { from: 'user' });

    expect(load).toHaveBeenCalledWith(process.cwd());
    expect(compile).toHaveBeenCalledWith({ marker: true }, { projectRoot: process.cwd() });
    expect(log).toHaveBeenCalledWith('Wrote .drs/guidance-rubric.json (2 rules)');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports compiler failures without terminating the process', async () => {
    const compile = vi.fn(async () => {
      throw new Error('invalid rules');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const command = createGuidanceCommand(compile, (() => ({})) as never);
    command.exitOverride();

    await command.parseAsync(['compile'], { from: 'user' });

    expect(error).toHaveBeenCalledWith('Error: invalid rules');
    expect(process.exitCode).toBe(1);
  });
});
