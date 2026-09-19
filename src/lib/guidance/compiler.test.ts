import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../config.js';
import { compileGuidanceRubric, GUIDANCE_COMPILER_AGENT_ID } from './compiler.js';
import { discoverGuidanceSources } from './discovery.js';

const directories: string[] = [];
const config = {} as DRSConfig;

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'drs-guidance-compiler-'));
  directories.push(root);
  return root;
}

function response(rules: unknown[]): string {
  return JSON.stringify({ rules });
}

function modelRule(source = 'AGENTS.md', line = 1): Record<string, unknown> {
  return {
    id: 'no-single-use-helper',
    text: 'Do not add single-use helpers.',
    source: { path: source, line },
    scope: ['**/*'],
    when: 'change',
    status: 'active',
    check: {
      type: 'model',
      question: {
        type: 'boolean',
        instructions: 'Does this change add a helper with one caller and no reusable behavior?',
        violating: true,
      },
    },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('compileGuidanceRubric', () => {
  it('gives ordered sources to the compiler and writes host-owned metadata atomically', async () => {
    const root = project();
    writeFileSync(join(root, 'AGENTS.md'), 'Do not add single-use helpers.\n');
    writeFileSync(join(root, 'CLAUDE.md'), 'Run the quality gate.\n');
    const runAgent = vi.fn(async () => ({ response: response([modelRule()]) }));

    const result = await compileGuidanceRubric(
      config,
      { projectRoot: root },
      {
        runAgent: runAgent as never,
        now: () => new Date('2026-09-19T12:00:00.000Z'),
      }
    );

    expect(runAgent).toHaveBeenCalledWith(
      config,
      GUIDANCE_COMPILER_AGENT_ID,
      expect.objectContaining({
        workingDir: root,
        quiet: true,
        allowImplicitStdin: false,
        ignoreConfiguredOutput: true,
      })
    );
    const calls = runAgent.mock.calls as unknown as Array<[unknown, unknown, { prompt?: string }]>;
    const prompt = calls[0]?.[2].prompt;
    expect(prompt).toBeDefined();
    if (!prompt) throw new Error('Expected compiler prompt');
    expect(prompt.indexOf('AGENTS.md')).toBeLessThan(prompt.indexOf('CLAUDE.md'));
    expect(result.outputPath).toBe('.drs/guidance-rubric.json');
    expect(result.rubric).toMatchObject({
      version: 1,
      compiledAt: '2026-09-19T12:00:00.000Z',
      compiledBy: GUIDANCE_COMPILER_AGENT_ID,
      thresholds: { act: 0.8, flag: 0.5 },
    });
    const written = readFileSync(join(root, result.outputPath), 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
    expect(JSON.parse(written)).toEqual(result.rubric);
  });

  it('rejects invalid compiler output without replacing an existing rubric', async () => {
    const root = project();
    writeFileSync(join(root, 'AGENTS.md'), 'Do not add single-use helpers.\n');
    const output = join(root, '.drs', 'guidance-rubric.json');
    const existing = 'existing rubric\n';
    const runAgent = vi.fn(async () => ({ response: '{"notRules":[]}' }));

    await expect(
      compileGuidanceRubric(config, { projectRoot: root }, { runAgent: runAgent as never })
    ).rejects.toThrow('must return exactly one object containing a rules array');
    expect(existsSync(output)).toBe(false);

    const validRun = vi.fn(async () => ({ response: response([modelRule()]) }));
    await compileGuidanceRubric(config, { projectRoot: root }, { runAgent: validRun as never });
    writeFileSync(output, existing);
    await expect(
      compileGuidanceRubric(config, { projectRoot: root }, { runAgent: runAgent as never })
    ).rejects.toThrow();
    expect(readFileSync(output, 'utf-8')).toBe(existing);
  });

  it('rejects missing guidance before invoking the agent', async () => {
    const root = project();
    const runAgent = vi.fn();

    await expect(
      compileGuidanceRubric(config, { projectRoot: root }, { runAgent: runAgent as never })
    ).rejects.toThrow('No repository guidance sources were found');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('rejects source changes during compilation', async () => {
    const root = project();
    writeFileSync(join(root, 'AGENTS.md'), 'Do not add single-use helpers.\n');
    const first = discoverGuidanceSources(root);
    const changed = first.map((source) => ({ ...source, sha256: 'b'.repeat(64) }));
    const discover = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(changed);
    const runAgent = vi.fn(async () => ({ response: response([modelRule()]) }));

    await expect(
      compileGuidanceRubric(
        config,
        { projectRoot: root },
        { runAgent: runAgent as never, discover }
      )
    ).rejects.toThrow('Guidance rubric is stale');
    expect(existsSync(join(root, '.drs', 'guidance-rubric.json'))).toBe(false);
  });

  it('rejects source lines outside the supplied file', async () => {
    const root = project();
    writeFileSync(join(root, 'AGENTS.md'), 'One line\n');
    const runAgent = vi.fn(async () => ({ response: response([modelRule('AGENTS.md', 2)]) }));

    await expect(
      compileGuidanceRubric(config, { projectRoot: root }, { runAgent: runAgent as never })
    ).rejects.toThrow('references line 2 outside AGENTS.md');
  });
});
