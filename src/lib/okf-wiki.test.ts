import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { synchronizeOkfIndexes, validateOkfBundle } from './okf-wiki.js';

const tempDirectories: string[] = [];

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'drs-okf-wiki-'));
  tempDirectories.push(directory);
  return directory;
}

function writeConcept(root: string, relativePath: string, content: string): void {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('OKF wiki bundles', () => {
  it('synchronizes official OKF indexes and validates a bundle', async () => {
    const projectRoot = createTempDir();
    const wikiRoot = join(projectRoot, 'wiki');
    mkdirSync(wikiRoot);
    writeConcept(
      wikiRoot,
      'quickstart.md',
      [
        '---',
        'type: Quickstart',
        'title: Repository quickstart',
        'description: Start here to understand the repository.',
        'timestamp: 2026-07-17T12:00:00Z',
        'owner: maintainers',
        '---',
        '',
        'The runtime [depends on the workflow engine](/architecture/runtime.md).',
        '',
      ].join('\n')
    );
    writeConcept(
      wikiRoot,
      'architecture/runtime.md',
      [
        '---',
        'type: Architecture',
        'title: Workflow runtime',
        'description: Executes repository maintenance workflows.',
        'tags: [runtime, workflow]',
        '---',
        '',
        'The runtime is introduced by the [quickstart](/quickstart.md).',
        '',
      ].join('\n')
    );
    writeConcept(
      wikiRoot,
      'log.md',
      '# Bundle update log\n\n## 2026-07-17\n\n* **Creation**: Added the initial bundle.\n'
    );

    const firstSync = await synchronizeOkfIndexes(projectRoot);
    const secondSync = await synchronizeOkfIndexes(projectRoot);
    const validation = await validateOkfBundle(projectRoot);

    expect(firstSync).toMatchObject({ root: 'wiki', indexes: 2, updated: 2 });
    expect(secondSync.updated).toBe(0);
    expect(readFileSync(join(wikiRoot, 'index.md'), 'utf-8')).toContain('okf_version: "0.1"');
    expect(readFileSync(join(wikiRoot, 'architecture', 'index.md'), 'utf-8')).toBe(
      '# Concepts\n\n* [Workflow runtime](runtime.md) - Executes repository maintenance workflows.\n'
    );
    expect(validation).toMatchObject({
      valid: true,
      root: 'wiki',
      version: '0.1',
      concepts: 2,
      indexes: 2,
      logs: 1,
      errors: [],
      warnings: [],
    });
  });

  it('reports concept and reserved-file conformance errors', async () => {
    const projectRoot = createTempDir();
    const wikiRoot = join(projectRoot, 'wiki');
    mkdirSync(join(wikiRoot, 'architecture'), { recursive: true });
    writeConcept(wikiRoot, 'missing-frontmatter.md', '# Missing frontmatter\n');
    writeConcept(wikiRoot, 'missing-type.md', '---\ntitle: Missing type\n---\n\nBody\n');
    writeConcept(
      wikiRoot,
      'architecture/index.md',
      '---\ntype: Documentation Index\n---\n\n# Concepts\n\n* [Missing](../missing-type.md)\n'
    );
    writeConcept(wikiRoot, 'log.md', '# Log\n\n## July 17\n\n* Updated docs.\n');

    const validation = await validateOkfBundle(projectRoot);

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'invalid_frontmatter',
        'invalid_type',
        'index_frontmatter',
        'invalid_log_date',
      ])
    );
  });

  it('keeps broken links as warnings as required by OKF consumption rules', async () => {
    const projectRoot = createTempDir();
    const wikiRoot = join(projectRoot, 'wiki');
    mkdirSync(wikiRoot);
    writeConcept(
      wikiRoot,
      'quickstart.md',
      '---\ntype: Quickstart\n---\n\nSee the [future concept](/future.md).\n'
    );

    const validation = await validateOkfBundle(projectRoot);

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContainEqual(
      expect.objectContaining({ code: 'broken_link', path: 'quickstart.md' })
    );
  });

  it('rejects unsafe bundle roots and symbolic links', async () => {
    const projectRoot = createTempDir();
    const outsideRoot = createTempDir();
    mkdirSync(join(projectRoot, 'wiki'));
    writeConcept(
      projectRoot,
      'wiki/quickstart.md',
      '---\ntype: Quickstart\n---\n\nRepository overview.\n'
    );
    writeConcept(outsideRoot, 'outside.md', '---\ntype: Reference\n---\n\nOutside.\n');
    symlinkSync(join(outsideRoot, 'outside.md'), join(projectRoot, 'wiki', 'outside.md'));

    const rootValidation = await validateOkfBundle(projectRoot, '.');
    const linkValidation = await validateOkfBundle(projectRoot);

    expect(rootValidation).toMatchObject({
      valid: false,
      errors: [expect.objectContaining({ code: 'invalid_bundle_root' })],
    });
    expect(linkValidation.valid).toBe(false);
    expect(linkValidation.errors).toContainEqual(
      expect.objectContaining({ code: 'symbolic_link', path: 'outside.md' })
    );
    await expect(validateOkfBundle(projectRoot, '../outside')).resolves.toMatchObject({
      valid: false,
      errors: [expect.objectContaining({ code: 'invalid_bundle_root' })],
    });
  });

  it('rejects unsupported OKF versions', async () => {
    const projectRoot = createTempDir();
    mkdirSync(join(projectRoot, 'wiki'));

    await expect(validateOkfBundle(projectRoot, 'wiki', '1.0')).rejects.toThrow(
      'Unsupported OKF version "1.0"'
    );
  });
});
