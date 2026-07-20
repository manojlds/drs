import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWikiSite } from './wiki-site.js';

describe('wiki site build integration', () => {
  let projectRoot: string | undefined;

  afterEach(async () => {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(join(process.cwd(), 'dist', 'lib', 'wiki-site-safety.js')))(
    'builds a repository-neutral bundle without quickstart or log concepts',
    async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'drs-wiki-site-integration-'));
      const wikiRoot = join(projectRoot, 'knowledge');
      await mkdir(wikiRoot);
      await writeFile(
        join(wikiRoot, 'index.md'),
        "---\nokf_version: '0.1'\n---\n\n# Knowledge\n\n- [Overview](overview.md)\n"
      );
      await writeFile(
        join(wikiRoot, 'overview.md'),
        '\uFEFF---\ntype: Guide\ntitle: Product overview\ndescription: A small reusable bundle.\ndrs_sources:\n  - path: src/app.ts\n    symbols: [createApp]\n---\n\n# Product overview\n'
      );

      const result = await buildWikiSite({
        projectRoot,
        source: 'knowledge',
        output: 'public',
        base: '/docs/',
        repository: 'owner/product',
        siteUrl: 'https://docs.example.com/docs',
        title: 'Product Knowledge',
        quiet: true,
      });
      const [indexHtml, graphHtml, llmsText, overviewHtml] = await Promise.all([
        readFile(join(projectRoot, 'public', 'index.html'), 'utf-8'),
        readFile(join(projectRoot, 'public', 'graph.html'), 'utf-8'),
        readFile(join(projectRoot, 'public', 'llms.txt'), 'utf-8'),
        readFile(join(projectRoot, 'public', 'overview.html'), 'utf-8'),
      ]);

      expect(result.base).toBe('/docs/');
      expect(indexHtml).toContain('Product Knowledge');
      expect(indexHtml).toContain('href="/docs/overview.html"');
      expect(indexHtml).not.toContain('/quickstart');
      expect(indexHtml).not.toContain('href="/docs/log.html"');
      expect(indexHtml).toContain('href="https://docs.example.com/docs/graph.html"');
      expect(indexHtml).toContain('target="_self"');
      expect(graphHtml).toContain('Product Knowledge concept relationship graph');
      expect(graphHtml).not.toContain('DRS OKF concept relationship graph');
      expect(llmsText).toContain('# Product Knowledge');
      expect(llmsText).toContain('https://docs.example.com/docs/overview.html');
      expect(overviewHtml).toContain('Sources');
      expect(overviewHtml).toContain('https://github.com/owner/product/blob/main/src/app.ts');
      expect(overviewHtml).toContain('createApp');
    },
    30_000
  );
});
