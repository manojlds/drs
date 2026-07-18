import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  close: vi.fn(),
  createServer: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('vitepress', () => ({
  build: mocks.build,
  createServer: mocks.createServer,
}));

import { buildWikiSite, serveWikiSite } from './wiki-site.js';

describe('reusable wiki site adapter', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), 'drs-wiki-site-'));
    await mkdir(join(projectRoot, 'wiki'));
    await writeFile(
      join(projectRoot, 'wiki', 'index.md'),
      '---\nokf_version: "0.1"\n---\n\n# Concepts\n\n- [Example](example.md)\n'
    );
    await writeFile(
      join(projectRoot, 'wiki', 'example.md'),
      '---\ntype: Guide\ntitle: Example\n---\n\n# Example\n'
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('builds a project bundle with isolated adapter environment', async () => {
    let observedSource = '';
    mocks.build.mockImplementationOnce(() => {
      observedSource = process.env.DRS_WIKI_SITE_SOURCE ?? '';
    });

    const result = await buildWikiSite({
      projectRoot,
      source: 'wiki',
      output: 'public/wiki',
      base: '/project/',
      repository: 'owner/project',
      siteUrl: 'https://owner.github.io/project/',
    });

    expect(observedSource).toBe(join(projectRoot, 'wiki'));
    expect(result).toEqual({
      base: '/project/',
      output: join(projectRoot, 'public/wiki'),
      source: join(projectRoot, 'wiki'),
    });
    expect(process.env.DRS_WIKI_SITE_SOURCE).toBeUndefined();
    expect(mocks.build).toHaveBeenCalledWith(expect.stringContaining('.wiki-site'), {
      base: '/project/',
    });
  });

  it('keeps the environment until a development server closes', async () => {
    mocks.createServer.mockResolvedValueOnce({
      close: mocks.close,
      listen: mocks.listen,
      resolvedUrls: { local: ['http://127.0.0.1:4173/'], network: [] },
    });
    const server = await serveWikiSite({ projectRoot, base: '/docs/', port: 4321 });

    expect(process.env.DRS_WIKI_SITE_SOURCE).toBe(join(projectRoot, 'wiki'));
    expect(process.env.WIKI_SITE_URL).toBe('http://127.0.0.1:4321/docs');
    expect(server.urls).toEqual(['http://127.0.0.1:4173/']);
    await server.close();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(process.env.DRS_WIKI_SITE_SOURCE).toBeUndefined();
  });

  it('rejects source paths outside the project root', async () => {
    await expect(buildWikiSite({ projectRoot, source: '../wiki' })).rejects.toThrow(
      /must remain inside the project root/
    );
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it('rejects symbolic-link source and output paths', async () => {
    await rm(join(projectRoot, 'wiki'), { recursive: true });
    await mkdir(join(projectRoot, 'outside-wiki'));
    await symlink(join(projectRoot, 'outside-wiki'), join(projectRoot, 'wiki'), 'dir');

    await expect(buildWikiSite({ projectRoot })).rejects.toThrow(/symbolic link/);

    await rm(join(projectRoot, 'wiki'));
    await mkdir(join(projectRoot, 'wiki'));
    await writeFile(
      join(projectRoot, 'wiki', 'index.md'),
      '---\nokf_version: "0.1"\n---\n\n# Concepts\n\n- [Example](example.md)\n'
    );
    await writeFile(join(projectRoot, 'wiki', 'example.md'), '---\ntype: Guide\n---\n');
    await mkdir(join(projectRoot, 'outside-output'));
    await symlink(join(projectRoot, 'outside-output'), join(projectRoot, 'public'), 'dir');

    await expect(buildWikiSite({ projectRoot, output: 'public/site' })).rejects.toThrow(
      /output cannot contain symbolic links/
    );
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it('rejects overlapping build and serve operations', async () => {
    mocks.createServer.mockResolvedValueOnce({
      close: mocks.close,
      listen: mocks.listen,
      resolvedUrls: { local: ['http://127.0.0.1:4173/'], network: [] },
    });
    const server = await serveWikiSite({ projectRoot });

    await expect(buildWikiSite({ projectRoot })).rejects.toThrow(/already active/);
    await server.close();
    await expect(buildWikiSite({ projectRoot })).resolves.toMatchObject({ base: '/' });
  });
});
