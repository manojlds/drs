import { lstat, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { build, createServer } from 'vitepress';
import { formatOkfValidationErrors, validateOkfBundle } from './okf-wiki.js';
import { normalizeWikiSiteBase } from './wiki-site-safety.js';

export interface WikiSiteOptions {
  base?: string;
  output?: string;
  projectRoot?: string;
  quiet?: boolean;
  repository?: string;
  siteUrl?: string;
  source?: string;
  title?: string;
}

export interface WikiSiteBuildResult {
  base: string;
  output: string;
  source: string;
}

export interface WikiSiteServeOptions extends WikiSiteOptions {
  host?: string;
  port?: number;
}

export interface WikiSiteServer {
  close(): Promise<void>;
  urls: string[];
}

interface ResolvedWikiSiteOptions {
  base: string;
  output: string;
  projectRoot: string;
  quiet: boolean;
  repository: string;
  siteRoot: string;
  siteUrl: string;
  source: string;
  title: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const bundledSiteRoot = resolve(moduleDirectory, '../../.wiki-site');
let operationActive = false;

export async function buildWikiSite(options: WikiSiteOptions = {}): Promise<WikiSiteBuildResult> {
  const releaseOperation = beginWikiSiteOperation();
  try {
    const resolved = await resolveWikiSiteOptions(options);
    const restoreEnvironment = applyWikiSiteEnvironment(resolved);
    const restoreOutput = resolved.quiet ? suppressProcessOutput() : () => {};
    try {
      await build(resolved.siteRoot, { base: resolved.base });
    } finally {
      restoreOutput();
      restoreEnvironment();
    }
    return {
      base: resolved.base,
      output: resolved.output,
      source: resolved.source,
    };
  } finally {
    releaseOperation();
  }
}

export async function serveWikiSite(options: WikiSiteServeOptions = {}): Promise<WikiSiteServer> {
  const releaseOperation = beginWikiSiteOperation();
  try {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 4173;
    const base = normalizeWikiSiteBase(options.base ?? '/');
    const resolved = await resolveWikiSiteOptions({
      ...options,
      siteUrl: options.siteUrl ?? localWikiSiteUrl(host, port, base),
    });
    const restoreEnvironment = applyWikiSiteEnvironment(resolved);
    try {
      const server = await createServer(resolved.siteRoot, {
        base: resolved.base,
        host,
        port,
        strictPort: true,
      });
      await server.listen();
      const urls = [...(server.resolvedUrls?.local ?? []), ...(server.resolvedUrls?.network ?? [])];
      let closed = false;
      return {
        urls,
        async close() {
          if (closed) return;
          closed = true;
          try {
            await server.close();
          } finally {
            restoreEnvironment();
            releaseOperation();
          }
        },
      };
    } catch (error) {
      restoreEnvironment();
      throw error;
    }
  } catch (error) {
    releaseOperation();
    throw error;
  }
}

async function resolveWikiSiteOptions(options: WikiSiteOptions): Promise<ResolvedWikiSiteOptions> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const source = resolveProjectPath(projectRoot, options.source ?? 'wiki', 'Wiki source');
  const output = resolveProjectPath(
    projectRoot,
    options.output ?? '.drs/wiki-site',
    'Wiki site output'
  );
  if (isPathWithin(source, output) || isPathWithin(output, source)) {
    throw new Error('Wiki source and site output must be separate directories.');
  }
  const sourceStatus = await stat(source).catch(() => null);
  if (!sourceStatus?.isDirectory()) {
    throw new Error(`Wiki source directory does not exist: ${source}`);
  }
  const sourcePath = relative(projectRoot, source);
  const validation = await validateOkfBundle(projectRoot, sourcePath);
  if (!validation.valid) {
    throw new Error(`Cannot render invalid OKF bundle:\n${formatOkfValidationErrors(validation)}`);
  }
  await assertNoSymlinkAncestors(projectRoot, output, 'Wiki site output');
  const siteStatus = await stat(bundledSiteRoot).catch(() => null);
  if (!siteStatus?.isDirectory()) {
    throw new Error(`Bundled wiki site adapter is missing: ${bundledSiteRoot}`);
  }
  const base = normalizeWikiSiteBase(options.base ?? '/');
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY ?? '';
  if (repository && !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Repository must use owner/name format, received ${repository}`);
  }
  const repositoryName = repository.split('/')[1] || basename(projectRoot);
  const siteUrl = normalizeSiteUrl(
    options.siteUrl ??
      (repository
        ? `https://${repository.split('/')[0]}.github.io/${repositoryName}`
        : `http://localhost:4173${base === '/' ? '' : base.slice(0, -1)}`)
  );

  return {
    base,
    output,
    projectRoot,
    quiet: options.quiet ?? false,
    repository,
    siteRoot: bundledSiteRoot,
    siteUrl,
    source,
    title: options.title ?? `${repositoryName} Knowledge Map`,
  };
}

function beginWikiSiteOperation(): () => void {
  if (operationActive) {
    throw new Error('Another wiki site build or server is already active in this process.');
  }
  operationActive = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    operationActive = false;
  };
}

async function assertNoSymlinkAncestors(
  projectRoot: string,
  targetPath: string,
  label: string
): Promise<void> {
  const relativePath = relative(projectRoot, targetPath);
  let currentPath = projectRoot;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, part);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        throw new Error(`${label} cannot contain symbolic links: ${relativePath}`);
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

function localWikiSiteUrl(host: string, port: number, base: string): string {
  const publicHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const formattedHost = publicHost.includes(':') ? `[${publicHost}]` : publicHost;
  return `http://${formattedHost}:${port}${base === '/' ? '' : base.slice(0, -1)}`;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function resolveProjectPath(projectRoot: string, value: string, label: string): string {
  const absolutePath = resolve(projectRoot, value);
  const relativePath = relative(projectRoot, absolutePath);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must remain inside the project root: ${value}`);
  }
  return absolutePath;
}

function isPathWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  );
}

function normalizeSiteUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Wiki site URL must use HTTP or HTTPS, received ${url.protocol}`);
  }
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
}

function applyWikiSiteEnvironment(options: ResolvedWikiSiteOptions): () => void {
  const values: Record<string, string> = {
    DRS_WIKI_SITE_OUTPUT: options.output,
    DRS_WIKI_SITE_PROJECT_ROOT: options.projectRoot,
    DRS_WIKI_SITE_QUIET: String(options.quiet),
    DRS_WIKI_SITE_REPOSITORY: options.repository,
    DRS_WIKI_SITE_SOURCE: options.source,
    DRS_WIKI_SITE_TITLE: options.title,
    WIKI_SITE_BASE: options.base,
    WIKI_SITE_URL: options.siteUrl,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function suppressProcessOutput(): () => void {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  return () => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  };
}
