import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertGuidanceRubricCurrent, discoverGuidanceSources } from './discovery.js';
import type { GuidanceRubric } from './rubric.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'drs-guidance-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root: string, path: string, content: string): void {
  const filePath = join(root, path);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function rubricFor(sources: ReturnType<typeof discoverGuidanceSources>): GuidanceRubric {
  return {
    version: 1,
    compiledAt: '2026-09-19T12:00:00.000Z',
    sources: sources.map(({ content: _content, ...source }) => source),
    thresholds: { act: 0.8, flag: 0.5 },
    rules: [],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('discoverGuidanceSources', () => {
  it('discovers root, nested, and repository-wide Copilot guidance deterministically', () => {
    const root = temporaryDirectory();
    write(root, 'AGENTS.md', '# Root\n');
    write(root, 'packages/api/CLAUDE.md', '# API\n');
    write(root, '.github/copilot-instructions.md', '# Copilot\n');
    write(root, 'node_modules/example/AGENTS.md', '# Ignored\n');
    write(root, '.drs/artifacts/AGENTS.md', '# Ignored\n');

    const sources = discoverGuidanceSources(root);

    expect(sources.map(({ path, scope }) => ({ path, scope }))).toEqual([
      { path: '.github/copilot-instructions.md', scope: '**/*' },
      { path: 'AGENTS.md', scope: '**/*' },
      { path: 'packages/api/CLAUDE.md', scope: 'packages/api/**/*' },
    ]);
    expect(sources[1]?.sha256).toBe(createHash('sha256').update('# Root\n').digest('hex'));
    expect(sources[2]?.content).toBe('# API\n');
  });

  it('does not follow guidance symlinks', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    write(outside, 'AGENTS.md', '# Outside\n');
    symlinkSync(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'));

    expect(discoverGuidanceSources(root)).toEqual([]);
  });

  it('does not follow a symlinked parent for Copilot instructions', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    write(outside, 'copilot-instructions.md', '# Outside\n');
    symlinkSync(outside, join(root, '.github'));

    expect(discoverGuidanceSources(root)).toEqual([]);
  });

  it('bounds source size and count', () => {
    const root = temporaryDirectory();
    write(root, 'AGENTS.md', 'too large');
    expect(() => discoverGuidanceSources(root, { maxSourceBytes: 3 })).toThrow(
      'AGENTS.md exceeds 3 bytes'
    );

    write(root, 'nested/CLAUDE.md', '# Nested\n');
    expect(() => discoverGuidanceSources(root, { maxSources: 1 })).toThrow(
      'more than 1 source files'
    );
  });

  it('honors the traversal depth limit', () => {
    const root = temporaryDirectory();
    write(root, 'one/AGENTS.md', '# One\n');
    write(root, 'one/two/CLAUDE.md', '# Two\n');

    expect(discoverGuidanceSources(root, { maxDepth: 1 }).map((source) => source.path)).toEqual([
      'one/AGENTS.md',
    ]);
  });
});

describe('assertGuidanceRubricCurrent', () => {
  it('accepts matching source hashes and scopes', () => {
    const root = temporaryDirectory();
    write(root, 'AGENTS.md', '# Root\n');
    const sources = discoverGuidanceSources(root);

    expect(() => assertGuidanceRubricCurrent(rubricFor(sources), sources)).not.toThrow();
  });

  it('reports changed, removed, and newly discovered sources', () => {
    const root = temporaryDirectory();
    write(root, 'AGENTS.md', '# Root\n');
    write(root, 'old/CLAUDE.md', '# Old\n');
    const rubric = rubricFor(discoverGuidanceSources(root));

    write(root, 'AGENTS.md', '# Changed\n');
    rmSync(join(root, 'old'), { recursive: true });
    write(root, 'new/AGENTS.md', '# New\n');

    expect(() => assertGuidanceRubricCurrent(rubric, discoverGuidanceSources(root))).toThrow(
      'AGENTS.md, new/AGENTS.md, old/CLAUDE.md'
    );
  });
});
