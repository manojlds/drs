import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWikiCommand } from './wiki.js';

const originalWorkingDirectory = process.cwd();
const tempDirectories: string[] = [];

afterEach(() => {
  process.chdir(originalWorkingDirectory);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('wiki CLI', () => {
  it('prints deterministic JSON search results with a configurable limit', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'drs-wiki-cli-'));
    tempDirectories.push(projectRoot);
    mkdirSync(join(projectRoot, 'wiki'));
    writeFileSync(
      join(projectRoot, 'wiki', 'runtime.md'),
      [
        '---',
        'type: Architecture',
        'title: Workflow runtime',
        'tags: [workflow]',
        '---',
        '',
        '# Runtime',
        '',
        'Executes workflow nodes.',
        '',
      ].join('\n'),
      'utf-8'
    );
    process.chdir(projectRoot);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createWikiCommand().parseAsync([
      'node',
      'drs',
      'search',
      'workflow',
      'runtime',
      '--limit',
      '1',
      '--json',
    ]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      query: 'workflow runtime',
      source: 'wiki',
      total: 1,
      results: [
        {
          path: 'wiki/runtime.md',
          title: 'Workflow runtime',
          type: 'Architecture',
          tags: ['workflow'],
        },
      ],
    });
  });
});
