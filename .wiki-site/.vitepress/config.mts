import { cp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { lstatSync } from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type DefaultTheme } from 'vitepress';
import { parse as parseYaml } from 'yaml';
import {
  isSafeWikiSiteRemoteUrl,
  neutralizeWikiSiteMarkdown,
  normalizeWikiSiteBase,
  sanitizeWikiSiteFrontmatter,
} from '../../src/lib/wiki-site-safety.ts';

interface OkfConcept {
  description: string;
  id: string;
  title: string;
  type: string;
}

const configDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(configDirectory, '../..');
const wikiRoot = join(repositoryRoot, 'wiki');
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'drs';
const base = normalizeWikiSiteBase(
  process.env.WIKI_SITE_BASE ??
    (process.env.GITHUB_ACTIONS === 'true' ? `/${repositoryName}/` : '/')
);
const siteUrl = process.env.WIKI_SITE_URL ?? 'https://manojlds.github.io/drs';
const concepts = await loadConcepts(wikiRoot);

export default defineConfig({
  title: 'DRS Knowledge Map',
  titleTemplate: ':title · DRS Knowledge Map',
  description: 'Architecture, workflows, operations, and maintenance knowledge for DRS.',
  lang: 'en-US',
  base,
  srcDir: '../wiki',
  outDir: './dist',
  cacheDir: './.vitepress/cache',
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
    plugins: [
      {
        name: 'okf-safe-markdown-source',
        enforce: 'pre',
        transform(source, id) {
          if (!id.endsWith('.md')) return null;
          return neutralizeWikiSiteMarkdown(source);
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
      { text: 'Start here', link: '/quickstart' },
      { text: 'Concepts', link: '/' },
      { text: 'Raw OKF', link: `${siteUrl}/okf/index.md` },
      {
        text: 'OKF v0.1',
        link: 'https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md',
      },
    ],
    sidebar: createSidebar(concepts),
    search: {
      provider: 'local',
    },
    outline: {
      level: 'deep',
      label: 'On this concept',
    },
    editLink: {
      pattern: 'https://github.com/manojlds/drs/edit/main/wiki/:path',
      text: 'Edit this concept on GitHub',
    },
    lastUpdated: {
      text: 'Last source update',
      formatOptions: {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/manojlds/drs' }],
    docFooter: {
      prev: 'Previous concept',
      next: 'Next concept',
    },
  },
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
      writeFile(join(siteConfig.outDir, '.nojekyll'), '', 'utf-8'),
    ]);
    await assertSiteOutput(siteConfig.outDir);
  },
});

async function assertSiteOutput(outputDirectory: string): Promise<void> {
  const [indexHtml, rawIndex, llmsText] = await Promise.all([
    readFile(join(outputDirectory, 'index.html'), 'utf-8'),
    readFile(join(outputDirectory, 'okf', 'index.md'), 'utf-8'),
    readFile(join(outputDirectory, 'llms.txt'), 'utf-8'),
  ]);
  const expectedLinks = [`href="${base}assets/`, `href="${base}quickstart.html`];
  const missingLink = expectedLinks.find((link) => !indexHtml.includes(link));
  if (missingLink) {
    throw new Error(`Generated wiki site is missing expected base-path link ${missingLink}`);
  }
  if (!rawIndex.includes('okf_version: "0.1"')) {
    throw new Error('Generated wiki site is missing the unchanged OKF bundle index');
  }
  if (!llmsText.includes(`${siteUrl}/quickstart.html`)) {
    throw new Error('Generated wiki site is missing public concept URLs in llms.txt');
  }
}

async function loadConcepts(directory: string): Promise<OkfConcept[]> {
  const concepts: OkfConcept[] = [];
  for (const filePath of await listMarkdownFiles(directory)) {
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
    });
  }
  return concepts.sort((left, right) => compareStrings(left.id, right.id));
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

function createSidebar(concepts: OkfConcept[]): DefaultTheme.SidebarItem[] {
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
        { text: 'Update log', link: '/log' },
      ],
    },
    ...orderedTypes.map((type) => ({
      text: type,
      collapsed: false,
      items: (groups.get(type) ?? []).map((concept) => ({
        text: concept.title,
        link: `/${concept.id}`,
      })),
    })),
  ];
}

function createLlmsText(items: OkfConcept[]): string {
  const lines = [
    '# DRS Repository Wiki',
    '',
    '> Architecture, workflows, operations, and maintenance knowledge for DRS.',
    '',
    '## Concepts',
    '',
  ];
  for (const concept of items) {
    const suffix = concept.description ? `: ${concept.description}` : '';
    lines.push(`- [${concept.title}](${siteUrl}/${concept.id}.html)${suffix}`);
  }
  lines.push('', '## Raw OKF bundle', '', `- [Bundle index](${siteUrl}/okf/index.md)`, '');
  return lines.join('\n');
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
