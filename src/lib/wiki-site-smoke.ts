import { readWikiSiteOkfVersion } from './wiki-site-safety.js';

export interface WikiSiteSmokeResult {
  assetsChecked: number;
  baseUrl: string;
  pagesChecked: number;
}

export interface WikiSiteSmokeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface WaitForWikiSiteOptions extends WikiSiteSmokeOptions {
  attempts?: number;
  delayMs?: number;
}

interface FetchedResource {
  content: string;
  contentType: string;
  url: URL;
}

export async function checkWikiSite(
  value: string,
  options: WikiSiteSmokeOptions = {}
): Promise<WikiSiteSmokeResult> {
  const baseUrl = normalizeSiteUrl(value);
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requiredUrls = {
    graph: new URL('graph.html', baseUrl),
    llms: new URL('llms.txt', baseUrl),
    rawIndex: new URL('okf/index.md', baseUrl),
    sitemap: new URL('sitemap.xml', baseUrl),
  };
  const [root, graph, llms, rawIndex, sitemap] = await Promise.all([
    fetchResource(baseUrl, fetchImplementation, timeoutMs, baseUrl),
    fetchResource(requiredUrls.graph, fetchImplementation, timeoutMs, baseUrl),
    fetchResource(requiredUrls.llms, fetchImplementation, timeoutMs, baseUrl),
    fetchResource(requiredUrls.rawIndex, fetchImplementation, timeoutMs, baseUrl),
    fetchResource(requiredUrls.sitemap, fetchImplementation, timeoutMs, baseUrl),
  ]);

  if (
    !root.content.includes('id="local-search"') ||
    !/\\*"provider\\*":\\*"local\\*"/.test(root.content)
  ) {
    throw new Error(`Wiki site ${baseUrl.href} is missing its local search index marker.`);
  }
  const graphConceptUrls = extractGraphConceptUrls(graph.content, graph.url, baseUrl);
  if (!llms.content.startsWith('# ') || !llms.content.includes('/okf/index.md')) {
    throw new Error(`Wiki site ${requiredUrls.llms.href} is not a valid llms.txt index.`);
  }
  const llmsUrls = extractLlmsUrls(llms.content, llms.url, baseUrl);
  for (const requiredUrl of [requiredUrls.graph, requiredUrls.rawIndex, ...graphConceptUrls]) {
    if (!llmsUrls.has(requiredUrl.href)) {
      throw new Error(
        `Wiki site ${requiredUrls.llms.href} is missing required URL ${requiredUrl.href}.`
      );
    }
  }
  if (readWikiSiteOkfVersion(rawIndex.content) !== '0.1') {
    throw new Error(`Wiki site ${requiredUrls.rawIndex.href} is not an OKF v0.1 bundle index.`);
  }

  const pageUrls = extractSitemapUrls(sitemap.content, baseUrl);
  if (pageUrls.length === 0) {
    throw new Error(`Wiki site ${requiredUrls.sitemap.href} contains no pages.`);
  }
  const additionalPageUrls = pageUrls.filter((url) => url.href !== baseUrl.href);
  const pages = await Promise.all(
    additionalPageUrls.map((url) => fetchResource(url, fetchImplementation, timeoutMs, baseUrl))
  );
  const resources = new Map<string, URL>();
  for (const page of [root, ...pages]) {
    for (const url of extractInternalResources(page.content, page.url, baseUrl)) {
      resources.set(url.href, url);
    }
  }
  for (const url of graphConceptUrls) resources.set(url.href, url);
  for (const url of Object.values(requiredUrls)) resources.delete(url.href);
  resources.delete(baseUrl.href);
  for (const url of additionalPageUrls) resources.delete(url.href);
  await Promise.all(
    [...resources.values()].map((url) =>
      fetchResource(url, fetchImplementation, timeoutMs, baseUrl)
    )
  );

  return {
    baseUrl: baseUrl.href,
    pagesChecked: 1 + additionalPageUrls.length,
    assetsChecked: resources.size + 4,
  };
}

function extractGraphConceptUrls(content: string, graphUrl: URL, baseUrl: URL): URL[] {
  const match = /<script[^>]*\bid=["']graph-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(content);
  if (!match?.[1]) {
    throw new Error(`Wiki site ${graphUrl.href} is missing concept graph data.`);
  }
  let graph: unknown;
  try {
    graph = JSON.parse(match[1]);
  } catch {
    throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
  }
  if (graph === null || typeof graph !== 'object') {
    throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
  }
  const { nodes, edges } = graph as { edges?: unknown; nodes?: unknown };
  const types = (graph as { types?: unknown }).types;
  if (
    !Array.isArray(nodes) ||
    nodes.length === 0 ||
    !Array.isArray(edges) ||
    !Array.isArray(types) ||
    !types.every((type) => typeof type === 'string')
  ) {
    throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
  }
  const typeNames = new Set(types);
  const nodeIds = new Set<string>();
  const urls = nodes.map((node) => {
    if (node === null || typeof node !== 'object') {
      throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
    }
    const { color, description, href, id, title, type } = node as Record<string, unknown>;
    if (
      typeof color !== 'string' ||
      typeof description !== 'string' ||
      typeof href !== 'string' ||
      typeof id !== 'string' ||
      typeof title !== 'string' ||
      typeof type !== 'string' ||
      !typeNames.has(type) ||
      nodeIds.has(id)
    ) {
      throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
    }
    nodeIds.add(id);
    const url = new URL(href, graphUrl);
    assertWithinBase(url, baseUrl);
    return url;
  });
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object') {
      throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
    }
    const { source, target } = edge as { source?: unknown; target?: unknown };
    if (
      typeof source !== 'string' ||
      typeof target !== 'string' ||
      !nodeIds.has(source) ||
      !nodeIds.has(target)
    ) {
      throw new Error(`Wiki site ${graphUrl.href} contains invalid concept graph data.`);
    }
  }
  return urls;
}

function extractLlmsUrls(content: string, llmsUrl: URL, baseUrl: URL): Set<string> {
  const urls = new Set<string>();
  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!match[1]) continue;
    const url = new URL(match[1], llmsUrl);
    if (url.origin !== baseUrl.origin) continue;
    assertWithinBase(url, baseUrl);
    url.hash = '';
    urls.add(url.href);
  }
  return urls;
}

export async function waitForWikiSite(
  value: string,
  options: WaitForWikiSiteOptions = {}
): Promise<WikiSiteSmokeResult> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 5_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await checkWikiSite(value, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function normalizeSiteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Wiki site URL must use HTTP or HTTPS, received ${url.protocol}`);
  }
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function fetchResource(
  url: URL,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  baseUrl: URL
): Promise<FetchedResource> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Could not fetch wiki site resource ${url.href}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`Wiki site resource ${url.href} returned HTTP ${response.status}.`);
  }
  const finalUrl = response.url ? new URL(response.url) : url;
  assertWithinBase(finalUrl, baseUrl);
  const contentType = response.headers.get('content-type') ?? '';
  assertExpectedContentType(url, contentType);
  return {
    url: finalUrl,
    content: await response.text(),
    contentType,
  };
}

function assertExpectedContentType(url: URL, contentType: string): void {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const path = url.pathname.toLowerCase();
  let accepted: RegExp | undefined;
  if (path.endsWith('/') || path.endsWith('.html')) accepted = /^text\/html$/;
  else if (path.endsWith('.js')) accepted = /^(?:application|text)\/(?:java|ecma)script$/;
  else if (path.endsWith('.css')) accepted = /^text\/css$/;
  else if (path.endsWith('.xml')) accepted = /^(?:application|text)\/xml$/;
  else if (path.endsWith('.json')) accepted = /^application\/json$/;
  else if (path.endsWith('.txt')) accepted = /^text\/plain$/;
  else if (path.endsWith('.md')) accepted = /^text\/(?:markdown|plain)$/;
  if (accepted && !accepted.test(mediaType)) {
    throw new Error(
      `Wiki site resource ${url.href} returned unexpected content type ${contentType || '(missing)'}.`
    );
  }
}

function extractSitemapUrls(content: string, baseUrl: URL): URL[] {
  const urls = new Map<string, URL>();
  for (const match of content.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const rawUrl = match[1]?.replaceAll('&amp;', '&');
    if (!rawUrl) continue;
    const url = new URL(rawUrl, baseUrl);
    assertWithinBase(url, baseUrl);
    url.hash = '';
    urls.set(url.href, url);
  }
  return [...urls.values()].sort((left, right) => compareStrings(left.href, right.href));
}

function extractInternalResources(content: string, pageUrl: URL, baseUrl: URL): URL[] {
  const resources = new Map<string, URL>();
  for (const match of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const value = match[1];
    if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
    const url = new URL(value.replaceAll('&amp;', '&'), pageUrl);
    if (url.origin !== baseUrl.origin) continue;
    assertWithinBase(url, baseUrl);
    url.hash = '';
    url.search = '';
    resources.set(url.href, url);
  }
  return [...resources.values()];
}

function assertWithinBase(url: URL, baseUrl: URL): void {
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new Error(`Wiki site URL ${url.href} escapes configured base ${baseUrl.href}.`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
