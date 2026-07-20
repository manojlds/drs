import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { searchWiki } from './wiki-search.js';

const tempDirectories: string[] = [];

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'drs-wiki-search-'));
  tempDirectories.push(directory);
  return directory;
}

function writeWikiFile(projectRoot: string, relativePath: string, content: string): void {
  const filePath = join(projectRoot, 'wiki', relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function concept(frontmatter: string[], body: string): string {
  return ['---', ...frontmatter, '---', '', body, ''].join('\n');
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('wiki search', () => {
  it('exposes concept provenance in search results', async () => {
    const projectRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'runtime.md',
      concept(
        [
          'type: Architecture',
          'title: Workflow runtime',
          'drs_sources:',
          '  - path: src/runtime/client.ts',
          '    symbols: [runAgent]',
        ],
        '# Runtime\n\nExecutes repository workflows.'
      )
    );

    const result = await searchWiki(projectRoot, 'workflow runtime');

    expect(result.results[0]).toMatchObject({
      path: 'wiki/runtime.md',
      sources: [{ path: 'src/runtime/client.ts', symbols: ['runAgent'] }],
    });
  });

  it('ranks metadata before body matches and excludes reserved documents', async () => {
    const projectRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'runtime.md',
      concept(
        [
          'type: Architecture',
          'title: Workflow runtime',
          'description: Executes maintenance jobs.',
        ],
        '# Runtime\n\nRuns configured nodes.'
      )
    );
    writeWikiFile(
      projectRoot,
      'operations.md',
      concept(
        ['type: Guide', 'title: Operations', 'tags: [workflow, deployment]'],
        '# Operations\n\nProduction guidance.'
      )
    );
    writeWikiFile(
      projectRoot,
      'internals.md',
      concept(
        ['type: Reference', 'title: Internals'],
        '# Internals\n\nThe workflow scheduler executes the graph.'
      )
    );
    writeWikiFile(projectRoot, 'index.md', '# Concepts\n\n* [Workflow](runtime.md)\n');
    writeWikiFile(projectRoot, 'log.md', '# Log\n\n## 2026-07-19\n\nWorkflow update.\n');

    const result = await searchWiki(projectRoot, 'workflow');

    expect(result).toMatchObject({ query: 'workflow', source: 'wiki', total: 3 });
    expect(result.results.map((match) => match.path)).toEqual([
      'wiki/runtime.md',
      'wiki/operations.md',
      'wiki/internals.md',
    ]);
    expect(result.results[0].snippet).toContain('Workflow runtime');
    expect(result.results[1].snippet).toContain('workflow');
    expect(result.results[2].snippet).toContain('workflow scheduler');
  });

  it('ignores Markdown headings inside fenced code blocks', async () => {
    const projectRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'untitled.md',
      concept(
        ['type: Reference'],
        [
          '```bash',
          '# Fake fenced heading',
          'run-command',
          '```',
          '',
          '# Real heading',
          '',
          'Body.',
        ].join('\n')
      )
    );

    const result = await searchWiki(projectRoot, 'fake');

    expect(result.results[0]).toMatchObject({ title: 'Real heading', path: 'wiki/untitled.md' });
  });

  it('does not open invalid backtick fences that contain backticks in their info string', async () => {
    const projectRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'invalid-fence.md',
      concept(
        ['type: Reference'],
        ['``` bad`info', '# Visible heading', '', 'Searchable body.'].join('\n')
      )
    );

    const result = await searchWiki(projectRoot, 'visible');

    expect(result.results[0]).toMatchObject({
      title: 'Visible heading',
      path: 'wiki/invalid-fence.md',
    });
  });

  it('keeps normalized Unicode matches in long code-point-safe snippets', async () => {
    const projectRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'unicode.md',
      concept(
        ['type: Reference', 'title: Unicode behavior'],
        `# Unicode\n\n${'İ'.repeat(100)} ${'🙂'.repeat(80)} target ${'🙂'.repeat(80)}`
      )
    );

    const result = await searchWiki(projectRoot, 'target');
    const snippet = result.results[0].snippet;

    expect(snippet).toContain('target');
    expect(
      [...snippet].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff;
      })
    ).toBe(false);
  });

  it('boosts complete phrase matches and applies a deterministic limit', async () => {
    const projectRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'temporal-policy.md',
      concept(
        ['type: Reference', 'title: Temporal retry policy'],
        '# Policy\n\nClassifies retryable failures.'
      )
    );
    writeWikiFile(
      projectRoot,
      'temporal-guide.md',
      concept(
        ['type: Guide', 'title: Temporal operations'],
        '# Retry behavior\n\nConfigure activity retries.'
      )
    );

    const result = await searchWiki(projectRoot, ' temporal   retry ', { limit: 1 });

    expect(result.query).toBe('temporal retry');
    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe('wiki/temporal-policy.md');
  });

  it('rejects empty queries, invalid limits, and unsafe bundles', async () => {
    const projectRoot = createTempDir();
    const outsideRoot = createTempDir();
    writeWikiFile(
      projectRoot,
      'quickstart.md',
      concept(['type: Quickstart', 'title: Start'], '# Start\n\nRepository overview.')
    );

    await expect(searchWiki(projectRoot, '   ')).rejects.toThrow('query cannot be empty');
    await expect(searchWiki(projectRoot, 'start', { limit: 0 })).rejects.toThrow(
      'limit must be a positive integer'
    );

    writeFileSync(join(outsideRoot, 'outside.md'), 'outside', 'utf-8');
    symlinkSync(join(outsideRoot, 'outside.md'), join(projectRoot, 'wiki', 'outside.md'));
    await expect(searchWiki(projectRoot, 'start')).rejects.toThrow('symbolic_link');
  });
});
