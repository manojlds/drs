import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWikiClean, planWikiUpdate, recordWikiState } from './wiki-delta.js';

const tempDirectories: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'drs-wiki-delta-'));
  tempDirectories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'tests@example.com');
  git(root, 'config', 'user.name', 'DRS Tests');
  write(root, 'src/app.ts', 'export const value = 1;\n');
  git(root, 'add', 'src/app.ts');
  git(root, 'commit', '-m', 'initial source');
  return root;
}

function createWiki(root: string): void {
  write(
    root,
    'wiki/quickstart.md',
    '---\ntype: Quickstart\ntitle: Quickstart\n---\n\nRepository overview.\n'
  );
  write(
    root,
    'wiki/index.md',
    '---\nokf_version: "0.1"\n---\n\n# Concepts\n\n* [Quickstart](quickstart.md)\n'
  );
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('wiki delta state', () => {
  it('plans initial generation when no bundle exists', async () => {
    const root = createRepository();

    const plan = await planWikiUpdate(root);

    expect(plan).toMatchObject({
      mode: 'generate',
      shouldRun: true,
      root: 'wiki',
      statePath: '.drs/wiki-state.json',
      changedPaths: [],
    });
  });

  it('records fingerprints and skips the model when source and wiki are unchanged', async () => {
    const root = createRepository();
    createWiki(root);
    const state = await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');

    const plan = await planWikiUpdate(root);

    expect(plan).toMatchObject({
      mode: 'noop',
      shouldRun: false,
      sourceHash: state.sourceHash,
      wikiHash: state.wikiHash,
      previousGitHead: state.gitHead,
    });
  });

  it('reports exact source paths changed since the recorded state', async () => {
    const root = createRepository();
    createWiki(root);
    await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');
    write(root, 'src/app.ts', 'export const value = 2;\n');
    write(root, 'src/new.ts', 'export const added = true;\n');

    const plan = await planWikiUpdate(root);

    expect(plan.mode).toBe('update');
    expect(plan.shouldRun).toBe(true);
    expect(plan.changedPaths).toEqual(['src/app.ts', 'src/new.ts']);
    expect(plan.changedPathCount).toBe(2);
  });

  it('keeps recorded deletions stable after they are committed', async () => {
    const root = createRepository();
    createWiki(root);
    await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');
    rmSync(join(root, 'src/app.ts'));

    const dirtyPlan = await planWikiUpdate(root);
    expect(dirtyPlan.changedPaths).toEqual(['src/app.ts']);

    await recordWikiState(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'remove source file');

    await expect(planWikiUpdate(root)).resolves.toMatchObject({ mode: 'noop', shouldRun: false });
  });

  it('preserves whitespace in Git path names', async () => {
    const root = createRepository();
    write(root, 'src/ spaced .ts', 'export const spaced = 1;\n');
    git(root, 'add', 'src/ spaced .ts');
    git(root, 'commit', '-m', 'add spaced source');
    createWiki(root);
    await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');
    write(root, 'src/ spaced .ts', 'export const spaced = 2;\n');

    const plan = await planWikiUpdate(root);

    expect(plan.changedPaths).toEqual(['src/ spaced .ts']);
  });

  it('fingerprints checked-out submodule changes', async () => {
    const moduleRoot = createRepository();
    const root = createRepository();
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', moduleRoot, 'vendor/module');
    git(root, 'commit', '-am', 'add submodule');
    createWiki(root);
    await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');

    write(moduleRoot, 'src/app.ts', 'export const value = 2;\n');
    git(moduleRoot, 'add', 'src/app.ts');
    git(moduleRoot, 'commit', '-m', 'update module');
    const moduleHead = git(moduleRoot, 'rev-parse', 'HEAD');
    const checkoutRoot = join(root, 'vendor/module');
    git(checkoutRoot, 'fetch');
    git(checkoutRoot, 'checkout', moduleHead);

    const dirtyPlan = await planWikiUpdate(root);
    expect(dirtyPlan.changedPaths).toEqual(['vendor/module']);

    await recordWikiState(root);
    git(root, 'add', 'vendor/module', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'update submodule and wiki state');
    await expect(planWikiUpdate(root)).resolves.toMatchObject({ mode: 'noop', shouldRun: false });

    rmSync(checkoutRoot, { recursive: true, force: true });
    await expect(planWikiUpdate(root)).resolves.toMatchObject({ mode: 'noop', shouldRun: false });
  });

  it('refuses to record dirty submodule content', async () => {
    const moduleRoot = createRepository();
    const root = createRepository();
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', moduleRoot, 'vendor/module');
    git(root, 'commit', '-am', 'add submodule');
    createWiki(root);
    write(root, 'vendor/module/src/app.ts', 'export const value = 2;\n');

    await expect(recordWikiState(root)).rejects.toThrow(
      'Cannot record wiki state while Git submodule is dirty'
    );
  });

  it('reconciles wiki content changed outside a recorded update', async () => {
    const root = createRepository();
    createWiki(root);
    await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');
    write(
      root,
      'wiki/quickstart.md',
      '---\ntype: Quickstart\ntitle: Changed\n---\n\nChanged overview.\n'
    );

    const plan = await planWikiUpdate(root);

    expect(plan).toMatchObject({
      mode: 'reconcile',
      shouldRun: true,
      reason: 'Wiki content changed without a corresponding state update.',
    });
  });

  it('detects generated wiki and state changes in check mode', async () => {
    const root = createRepository();
    write(root, '.gitignore', '.drs/*\nwiki/\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-m', 'ignore generated output');
    createWiki(root);
    await recordWikiState(root);

    const dirty = await checkWikiClean(root);

    expect(dirty.clean).toBe(false);
    expect(dirty.changedPaths).toEqual([
      '.drs/wiki-state.json',
      'wiki/index.md',
      'wiki/quickstart.md',
    ]);

    git(root, 'add', '-f', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');
    const clean = await checkWikiClean(root);
    expect(clean).toMatchObject({ clean: true, changedPaths: [] });
    expect(JSON.parse(readFileSync(join(root, '.drs/wiki-state.json'), 'utf-8'))).toMatchObject({
      version: 1,
      okfVersion: '0.1',
    });
  });

  it('uses literal pathspecs for configured output paths', async () => {
    const root = createRepository();
    const magicRoot = ':(exclude)wiki';
    write(
      root,
      `${magicRoot}/quickstart.md`,
      '---\ntype: Quickstart\ntitle: Quickstart\n---\n\nRepository overview.\n'
    );
    write(
      root,
      `${magicRoot}/index.md`,
      '---\nokf_version: "0.1"\n---\n\n# Concepts\n\n* [Quickstart](quickstart.md)\n'
    );
    await recordWikiState(root, magicRoot);
    git(root, '--literal-pathspecs', 'add', magicRoot, '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add magic path wiki');
    write(
      root,
      `${magicRoot}/quickstart.md`,
      '---\ntype: Quickstart\ntitle: Changed\n---\n\nChanged overview.\n'
    );

    const result = await checkWikiClean(root, magicRoot);

    expect(result.clean).toBe(false);
    expect(result.changedPaths).toEqual([`${magicRoot}/quickstart.md`]);
  });

  it('retains special property names in the source manifest', async () => {
    const root = createRepository();
    write(root, '__proto__', 'first\n');
    git(root, 'add', '__proto__');
    git(root, 'commit', '-m', 'add special source path');
    createWiki(root);
    const state = await recordWikiState(root);
    git(root, 'add', 'wiki', '.drs/wiki-state.json');
    git(root, 'commit', '-m', 'add wiki');

    expect(Object.prototype.hasOwnProperty.call(state.sourceFiles, '__proto__')).toBe(true);
    write(root, '__proto__', 'second\n');
    await expect(planWikiUpdate(root)).resolves.toMatchObject({
      mode: 'update',
      changedPaths: ['__proto__'],
    });
  });

  it('requires state to live outside the bundle', async () => {
    const root = createRepository();

    await expect(planWikiUpdate(root, 'wiki', 'wiki/state.json')).rejects.toThrow(
      'Wiki state path must be outside'
    );
  });

  it('rejects symbolic links in bundle and state path ancestors', async () => {
    const root = createRepository();
    createWiki(root);
    const outside = mkdtempSync(join(tmpdir(), 'drs-wiki-state-outside-'));
    tempDirectories.push(outside);
    symlinkSync(outside, join(root, '.drs'), 'dir');

    await expect(planWikiUpdate(root)).rejects.toThrow(
      'Wiki state path cannot contain symbolic links'
    );

    const bundleRoot = createRepository();
    const outsideBundle = mkdtempSync(join(tmpdir(), 'drs-wiki-bundle-outside-'));
    tempDirectories.push(outsideBundle);
    symlinkSync(outsideBundle, join(bundleRoot, 'wiki'), 'dir');
    await expect(planWikiUpdate(bundleRoot)).rejects.toThrow(
      'Wiki bundle root cannot contain symbolic links'
    );
  });

  it('treats a crafted Git revision in state as invalid data', async () => {
    const root = createRepository();
    createWiki(root);
    await recordWikiState(root);
    const statePath = join(root, '.drs/wiki-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    state.gitHead = '--output=/tmp/drs-wiki-state-injection';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');

    await expect(planWikiUpdate(root)).resolves.toMatchObject({
      mode: 'reconcile',
      reason: 'Wiki state is missing or invalid.',
    });
  });
});
