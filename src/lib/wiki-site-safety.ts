import { parse as parseYaml } from 'yaml';

export function normalizeWikiSiteBase(value: string): string {
  if (!value.startsWith('/') || !value.endsWith('/')) {
    throw new Error(`WIKI_SITE_BASE must start and end with a slash, received ${value}`);
  }
  return value;
}

export function neutralizeWikiSiteMarkdown(source: string): string {
  return source
    .replace(/<!--\s*@include:/g, (directive) => directive.replace('<', '&lt;'))
    .replace(/^(\s{0,3})<<</gm, '$1&lt;&lt;&lt;')
    .replace(/<(\/?)(script|style|template)(?=[\s>])/gi, '&lt;$1$2');
}

export function sanitizeWikiSiteFrontmatter(
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const field of ['okf_version', 'type', 'title', 'description', 'resource', 'timestamp']) {
    const value = safeScalarString(frontmatter[field]);
    if (value !== undefined) sanitized[field] = value;
  }
  if (Array.isArray(frontmatter.tags)) {
    sanitized.tags = frontmatter.tags.flatMap((tag) => {
      const value = safeScalarString(tag);
      return value === undefined ? [] : [value];
    });
  }
  if (Array.isArray(frontmatter.drs_sources)) {
    const sources = frontmatter.drs_sources.flatMap((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const sourcePath = safeScalarString(record.path);
      if (!sourcePath) return [];
      const symbols = Array.isArray(record.symbols)
        ? record.symbols.flatMap((symbol) => {
            const value = safeScalarString(symbol);
            return value === undefined ? [] : [value];
          })
        : undefined;
      return [{ path: sourcePath, ...(symbols?.length ? { symbols } : {}) }];
    });
    if (sources.length > 0) sanitized.drs_sources = sources;
  }
  return sanitized;
}

export function isSafeWikiSiteRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function readWikiSiteOkfVersion(source: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match?.[1]) return undefined;
  try {
    const frontmatter = parseYaml(match[1]);
    if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
      return undefined;
    }
    const version = (frontmatter as Record<string, unknown>).okf_version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

function safeScalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  if (value instanceof Date) return value.toISOString();
  return undefined;
}
