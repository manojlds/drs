import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { lstatSync } from 'fs';
import { createRequire } from 'module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type DefaultTheme } from 'vitepress';
import { parse as parseYaml } from 'yaml';
import {
  isSafeWikiSiteRemoteUrl,
  neutralizeWikiSiteMarkdown,
  normalizeWikiSiteBase,
  readWikiSiteOkfVersion,
  sanitizeWikiSiteFrontmatter,
} from '../../dist/lib/wiki-site-safety.js';
import {
  createWikiSiteGraphHtml,
  encodeWikiSiteConceptId,
  extractWikiSiteConceptLinks,
} from '../../dist/lib/wiki-site-graph.js';

interface OkfConcept {
  description: string;
  id: string;
  links: string[];
  title: string;
  type: string;
}

interface WikiThemeConfig extends DefaultTheme.Config {
  startConcept?: { link: string; text: string };
}

const configDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bundledRepositoryRoot = resolve(configDirectory, '../..');
const siteRoot = resolve(configDirectory, '..');
const projectRoot = resolve(process.env.DRS_WIKI_SITE_PROJECT_ROOT ?? bundledRepositoryRoot);
const wikiRoot = resolve(projectRoot, process.env.DRS_WIKI_SITE_SOURCE ?? 'wiki');
const outputRoot = resolve(process.env.DRS_WIKI_SITE_OUTPUT ?? join(siteRoot, 'dist'));
const repository =
  process.env.DRS_WIKI_SITE_REPOSITORY !== undefined
    ? process.env.DRS_WIKI_SITE_REPOSITORY
    : process.env.GITHUB_REPOSITORY || 'manojlds/drs';
const [repositoryOwner = 'localhost', configuredRepositoryName] = repository.split('/');
const repositoryName = configuredRepositoryName || basename(projectRoot);
const base = normalizeWikiSiteBase(
  process.env.WIKI_SITE_BASE ??
    (process.env.GITHUB_ACTIONS === 'true' ? `/${repositoryName}/` : '/')
);
const siteUrl = (
  process.env.WIKI_SITE_URL ?? `https://${repositoryOwner}.github.io/${repositoryName}`
).replace(/\/+$/, '');
const siteTitle = process.env.DRS_WIKI_SITE_TITLE ?? `${repositoryName} Knowledge Map`;
const siteDescription = `Open Knowledge Format concepts and relationships for ${repositoryName}.`;
const sourcePath = relative(projectRoot, wikiRoot).split(sep).join('/');
const markdownFiles = await listMarkdownFiles(wikiRoot);
const concepts = await loadConcepts(wikiRoot, markdownFiles);
const startConcept = concepts.find((concept) => concept.id === 'quickstart') ?? concepts[0];
const hasLog = markdownFiles.includes('log.md');

export default defineConfig({
  title: siteTitle,
  titleTemplate: `:title · ${siteTitle}`,
  description: siteDescription,
  lang: 'en-US',
  base,
  srcDir: relative(siteRoot, wikiRoot).split(sep).join('/'),
  outDir: outputRoot,
  cacheDir: resolve(projectRoot, '.drs/wiki-site-cache'),
  cleanUrls: false,
  lastUpdated: true,
  sitemap: {
    hostname: `${siteUrl}/`,
  },
  head: [
    ['meta', { name: 'theme-color', content: '#16213d' }],
    ['meta', { name: 'color-scheme', content: 'light dark' }],
  ],
  vite: {
    logLevel: process.env.DRS_WIKI_SITE_QUIET === 'true' ? 'silent' : 'info',
    resolve: {
      alias: [
        { find: /^vue$/, replacement: require.resolve('vue/dist/vue.runtime.esm-bundler.js') },
        {
          find: /^vue\/server-renderer$/,
          replacement: require.resolve('@vue/server-renderer/dist/server-renderer.esm-bundler.js'),
        },
      ],
    },
    plugins: [
      {
        name: 'okf-safe-markdown-source',
        enforce: 'pre',
        transform(source, id) {
          if (!id.endsWith('.md')) return null;
          return neutralizeWikiSiteMarkdown(source);
        },
      },
      {
        name: 'okf-development-artifacts',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            try {
              const requestUrl = new URL(request.url ?? '/', 'http://localhost');
              if (base !== '/' && !requestUrl.pathname.startsWith(base)) {
                next();
                return;
              }
              const sitePath =
                base !== '/' && requestUrl.pathname.startsWith(base)
                  ? `/${requestUrl.pathname.slice(base.length)}`
                  : requestUrl.pathname;
              if (sitePath === '/graph.html') {
                const currentConcepts = await loadConcepts(wikiRoot);
                sendDevelopmentArtifact(
                  response,
                  createWikiSiteGraphHtml(currentConcepts, { base, siteTitle }),
                  'text/html; charset=utf-8'
                );
                return;
              }
              if (sitePath === '/llms.txt') {
                const currentConcepts = await loadConcepts(wikiRoot);
                sendDevelopmentArtifact(
                  response,
                  createLlmsText(currentConcepts),
                  'text/plain; charset=utf-8'
                );
                return;
              }
              if (sitePath.startsWith('/okf/')) {
                const rawPath = resolve(
                  wikiRoot,
                  decodeURIComponent(sitePath.slice('/okf/'.length))
                );
                const relativePath = relative(wikiRoot, rawPath);
                if (
                  extname(rawPath) !== '.md' ||
                  isAbsolute(relativePath) ||
                  relativePath === '..' ||
                  relativePath.startsWith(`..${sep}`)
                ) {
                  next();
                  return;
                }
                if (!(await isSafeRawWikiPath(rawPath, relativePath))) {
                  next();
                  return;
                }
                sendDevelopmentArtifact(
                  response,
                  await readFile(rawPath, 'utf-8'),
                  'text/markdown; charset=utf-8'
                );
                return;
              }
              next();
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  },
  markdown: {
    html: false,
    config(markdown) {
      const render = markdown.renderer.render.bind(markdown.renderer);
      const renderImage = markdown.renderer.rules.image;
      markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
        const source = tokens[index]?.attrGet('src') ?? '';
        if (isSafeWikiSiteRemoteUrl(source) && renderImage) {
          return renderImage(tokens, index, options, environment, renderer);
        }
        const alternative = markdown.utils.escapeHtml(tokens[index]?.content || 'image');
        return `<span class="okf-image-placeholder">[Image: ${alternative}]</span>`;
      };
      markdown.renderer.render = (tokens, options, environment) =>
        render(tokens, options, environment)
          .replaceAll('{{', '&#123;&#123;')
          .replaceAll('}}', '&#125;&#125;');
    },
  },
  transformPageData(pageData) {
    pageData.frontmatter = sanitizeWikiSiteFrontmatter(pageData.frontmatter);
  },
  themeConfig: {
    nav: [
      ...(startConcept
        ? [{ text: 'Start here', link: `/${encodeWikiSiteConceptId(startConcept.id)}` }]
        : []),
      { text: 'Concepts', link: '/' },
      { text: 'Graph', link: '/graph.html' },
      { text: 'Raw OKF', link: `${siteUrl}/okf/index.md` },
      {
        text: 'OKF v0.1',
        link: 'https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md',
      },
    ],
    sidebar: createSidebar(concepts, hasLog),
    ...(startConcept
      ? {
          startConcept: {
            link: `/${encodeWikiSiteConceptId(startConcept.id)}`,
            text: startConcept.title,
          },
        }
      : {}),
    search: {
      provider: 'local',
    },
    outline: {
      level: 'deep',
      label: 'On this concept',
    },
    editLink: repository
      ? {
          pattern: `https://github.com/${repository}/edit/main/${sourcePath}/:path`,
          text: 'Edit this concept on GitHub',
        }
      : undefined,
    lastUpdated: {
      text: 'Last source update',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },
    socialLinks: repository ? [{ icon: 'github', link: `https://github.com/${repository}` }] : [],
    docFooter: {
      prev: 'Previous concept',
      next: 'Next concept',
    },
  } satisfies WikiThemeConfig,
  async buildEnd(siteConfig) {
    const rawBundleOutput = join(siteConfig.outDir, 'okf');
    await rm(rawBundleOutput, { recursive: true, force: true });
    await cp(wikiRoot, rawBundleOutput, {
      recursive: true,
      filter: (source) => lstatSync(source).isDirectory() || extname(source) === '.md',
    });
    await mkdir(siteConfig.outDir, { recursive: true });
    await Promise.all([
      writeFile(join(siteConfig.outDir, 'llms.txt'), createLlmsText(concepts), 'utf-8'),
      writeFile(
        join(siteConfig.outDir, 'graph.html'),
        createWikiSiteGraphHtml(concepts, { base, siteTitle }),
        'utf-8'
      ),
      writeFile(join(siteConfig.outDir, '.nojekyll'), '', 'utf-8'),
    ]);
    await assertSiteOutput(siteConfig.outDir);
  },
});

function sendDevelopmentArtifact(
  response: { end(content: string): void; setHeader(name: string, value: string): void },
  content: string,
  contentType: string
): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', contentType);
  response.end(content);
}

async function assertSiteOutput(outputDirectory: string): Promise<void> {
  const [indexHtml, graphHtml, rawIndex, llmsText] = await Promise.all([
    readFile(join(outputDirectory, 'index.html'), 'utf-8'),
    readFile(join(outputDirectory, 'graph.html'), 'utf-8'),
    readFile(join(outputDirectory, 'okf', 'index.md'), 'utf-8'),
    readFile(join(outputDirectory, 'llms.txt'), 'utf-8'),
  ]);
  const expectedLinks = [
    `href="${base}assets/`,
    `href="${base}graph.html`,
    ...(startConcept ? [`href="${base}${encodeWikiSiteConceptId(startConcept.id)}.html`] : []),
  ];
  const missingLink = expectedLinks.find((link) => !indexHtml.includes(link));
  if (missingLink) {
    throw new Error(`Generated wiki site is missing expected base-path link ${missingLink}`);
  }
  if (readWikiSiteOkfVersion(rawIndex) !== '0.1') {
    throw new Error('Generated wiki site is missing the unchanged OKF bundle index');
  }
  if (
    startConcept &&
    !llmsText.includes(`${siteUrl}/${encodeWikiSiteConceptId(startConcept.id)}.html`)
  ) {
    throw new Error('Generated wiki site is missing public concept URLs in llms.txt');
  }
  if (!graphHtml.includes(`href="${base}"`) || !graphHtml.includes('id="graph-data"')) {
    throw new Error('Generated wiki site is missing the base-aware concept graph');
  }
}

async function loadConcepts(directory: string, markdownFiles?: string[]): Promise<OkfConcept[]> {
  const concepts: Array<Omit<OkfConcept, 'links'> & { content: string }> = [];
  for (const filePath of markdownFiles ?? (await listMarkdownFiles(directory))) {
    const name = filePath.split('/').at(-1);
    if (name === 'index.md' || name === 'log.md') continue;
    const content = await readFile(join(directory, ...filePath.split('/')), 'utf-8');
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter?.type) continue;
    const id = filePath.replace(/\.md$/, '');
    concepts.push({
      id,
      type: String(frontmatter.type),
      title: String(frontmatter.title ?? titleFromId(id)),
      description: String(frontmatter.description ?? ''),
      content,
    });
  }
  const conceptIds = new Set(concepts.map((concept) => concept.id));
  return concepts
    .map(({ content, ...concept }) => ({
      ...concept,
      links: extractWikiSiteConceptLinks(content, concept.id, conceptIds),
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
}

async function listMarkdownFiles(directory: string, current = ''): Promise<string[]> {
  const absoluteDirectory = join(directory, current);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (entry.name.startsWith('.')) continue;
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(directory, relativePath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(relativePath);
    }
  }
  return files;
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match?.[1]) return null;
  const parsed = parseYaml(match[1]);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function createSidebar(concepts: OkfConcept[], hasLog: boolean): DefaultTheme.SidebarItem[] {
  const typeOrder = [
    'Quickstart',
    'Architecture',
    'Workflow',
    'Configuration',
    'Integration',
    'Operations',
  ];
  const groups = new Map<string, OkfConcept[]>();
  for (const concept of concepts) {
    const group = groups.get(concept.type) ?? [];
    group.push(concept);
    groups.set(concept.type, group);
  }
  const orderedTypes = [...groups.keys()].sort((left, right) => {
    const leftIndex = typeOrder.indexOf(left);
    const rightIndex = typeOrder.indexOf(right);
    if (leftIndex < 0 && rightIndex < 0) return compareStrings(left, right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });

  return [
    {
      text: 'Bundle',
      items: [
        { text: 'Concept index', link: '/' },
        ...(hasLog ? [{ text: 'Update log', link: '/log' }] : []),
      ],
    },
    ...orderedTypes.map((type) => ({
      text: type,
      collapsed: false,
      items: (groups.get(type) ?? []).map((concept) => ({
        text: concept.title,
        link: `/${encodeWikiSiteConceptId(concept.id)}`,
      })),
    })),
  ];
}

function createLlmsText(items: OkfConcept[]): string {
  const lines = [
    `# ${inlineMarkdownText(siteTitle)}`,
    '',
    `> ${siteDescription}`,
    '',
    '## Concepts',
    '',
  ];
  for (const concept of items) {
    const suffix = concept.description ? `: ${inlineMarkdownText(concept.description)}` : '';
    lines.push(
      `- [${markdownLinkText(concept.title)}](${siteUrl}/${encodeWikiSiteConceptId(concept.id)}.html)${suffix}`
    );
  }
  lines.push(
    '',
    '## Explore',
    '',
    `- [Concept graph](${siteUrl}/graph.html): Interactive view of relationships between concepts.`,
    '',
    '## Raw OKF bundle',
    '',
    `- [Bundle index](${siteUrl}/okf/index.md)`,
    ''
  );
  return lines.join('\n');
}

function inlineMarkdownText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function markdownLinkText(value: string): string {
  return inlineMarkdownText(value).replace(/[\\\[\]]/g, '\\$&');
}

async function isSafeRawWikiPath(filePath: string, relativePath: string): Promise<boolean> {
  try {
    const status = await lstat(filePath);
    if (!status.isFile()) return false;
    const [realRoot, realFile] = await Promise.all([realpath(wikiRoot), realpath(filePath)]);
    return realFile === resolve(realRoot, relativePath);
  } catch {
    return false;
  }
}

function titleFromId(id: string): string {
  const name = id.split('/').at(-1) ?? id;
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
