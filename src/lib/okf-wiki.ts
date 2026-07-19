import { lstat, readFile, readdir, realpath, writeFile } from 'fs/promises';
import { isAbsolute, relative, resolve, sep } from 'path';
import * as path from 'path';
import * as yaml from 'yaml';
import { resolveWithinWorkingDir } from './path-utils.js';
import {
  analyzeWikiConceptGraph,
  extractWikiSiteConceptLinks,
  type WikiConceptGraphMetrics,
} from './wiki-site-graph.js';

export const SUPPORTED_OKF_VERSION = '0.1' as const;

export interface OkfValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface OkfBundleValidationResult {
  valid: boolean;
  version: typeof SUPPORTED_OKF_VERSION;
  root: string;
  concepts: number;
  indexes: number;
  logs: number;
  errors: OkfValidationIssue[];
  graph: WikiConceptGraphMetrics;
  warnings: OkfValidationIssue[];
}

export interface OkfIndexSyncResult {
  version: typeof SUPPORTED_OKF_VERSION;
  root: string;
  indexes: number;
  updated: number;
}

export interface OkfConceptDocument {
  body: string;
  description?: string;
  path: string;
  tags: string[];
  title?: string;
  type: string;
}

export interface OkfConceptBundle {
  concepts: OkfConceptDocument[];
  root: string;
}

interface BundleEntry {
  absolutePath: string;
  relativePath: string;
}

interface BundleDirectory extends BundleEntry {
  directories: string[];
  files: string[];
}

interface ParsedFrontmatter {
  body: string;
  fields: Record<string, unknown>;
}

interface IndexLink {
  description?: string;
  href: string;
  label: string;
}

/** Generate stable progressive-disclosure indexes for every non-empty bundle directory. */
export async function synchronizeOkfIndexes(
  workingDir: string,
  root = 'wiki',
  version: string = SUPPORTED_OKF_VERSION
): Promise<OkfIndexSyncResult> {
  requireSupportedVersion(version);
  const bundle = await resolveBundleRoot(workingDir, root);
  const directories = await collectBundleDirectories(bundle.absolutePath);
  let updated = 0;

  for (const directory of directories) {
    const conceptLinks: IndexLink[] = [];
    for (const filename of directory.files) {
      if (!isConceptFilename(filename)) continue;
      const filePath = resolve(directory.absolutePath, filename);
      const metadata = readDisplayMetadata(await readFile(filePath, 'utf-8'));
      conceptLinks.push({
        href: encodeURIComponent(filename),
        label: metadata.title ?? titleFromSlug(filename.slice(0, -3)),
        ...(metadata.description ? { description: metadata.description } : {}),
      });
    }

    const directoryLinks = directory.directories.map((name) => ({
      href: `${encodeURIComponent(name)}/`,
      label: titleFromSlug(name),
    }));
    if (conceptLinks.length === 0 && directoryLinks.length === 0) continue;

    const isRoot = directory.relativePath === '';
    const content = renderIndex(conceptLinks, directoryLinks, isRoot ? version : undefined);
    const indexPath = resolve(directory.absolutePath, 'index.md');
    const existing = directory.files.includes('index.md')
      ? await readFile(indexPath, 'utf-8')
      : undefined;
    if (existing !== content) {
      await writeFile(indexPath, content, 'utf-8');
      updated += 1;
    }
  }

  return {
    version: SUPPORTED_OKF_VERSION,
    root: bundle.relativePath,
    indexes: directories.filter(
      (directory) => directory.files.some(isConceptFilename) || directory.directories.length > 0
    ).length,
    updated,
  };
}

/** Validate an OKF bundle without modifying it. */
export async function validateOkfBundle(
  workingDir: string,
  root = 'wiki',
  version: string = SUPPORTED_OKF_VERSION
): Promise<OkfBundleValidationResult> {
  requireSupportedVersion(version);
  const errors: OkfValidationIssue[] = [];
  const warnings: OkfValidationIssue[] = [];
  let bundle: BundleEntry;

  try {
    bundle = await resolveBundleRoot(workingDir, root);
  } catch (error) {
    return {
      valid: false,
      version: SUPPORTED_OKF_VERSION,
      root: root.trim() || root,
      concepts: 0,
      indexes: 0,
      logs: 0,
      errors: [issue('invalid_bundle_root', errorMessage(error))],
      graph: emptyGraphMetrics(),
      warnings,
    };
  }

  const entries = await collectBundleEntries(bundle.absolutePath, errors);
  const files = new Set(entries.map((entry) => entry.relativePath));
  const conceptIds = new Set(
    entries
      .filter((entry) => isConceptFilename(path.posix.basename(entry.relativePath)))
      .map((entry) => entry.relativePath.replace(/\.md$/u, ''))
  );
  const graphConcepts: Array<{ id: string; links: string[] }> = [];
  let concepts = 0;
  let indexes = 0;
  let logs = 0;

  for (const entry of entries) {
    if (!entry.relativePath.endsWith('.md')) continue;
    const filename = path.posix.basename(entry.relativePath);
    const content = await readFile(entry.absolutePath, 'utf-8');

    if (filename === 'index.md') {
      indexes += 1;
      validateIndex(content, entry.relativePath, version, errors);
    } else if (filename === 'log.md') {
      logs += 1;
      validateLog(content, entry.relativePath, errors);
    } else {
      concepts += 1;
      validateConcept(content, entry.relativePath, errors, warnings);
      const id = entry.relativePath.replace(/\.md$/u, '');
      graphConcepts.push({
        id,
        links: extractWikiSiteConceptLinks(content, id, conceptIds),
      });
    }

    validateInternalLinks(content, entry.relativePath, files, warnings);
  }

  if (concepts === 0) {
    errors.push(issue('empty_bundle', 'The bundle must contain at least one concept document.'));
  }
  const graph = analyzeWikiConceptGraph(graphConcepts);
  for (const id of graph.orphanIds) {
    warnings.push(
      issue(
        'orphan_concept',
        'Concept has no incoming or outgoing semantic links to another concept.',
        `${id}.md`
      )
    );
  }

  return {
    valid: errors.length === 0,
    version: SUPPORTED_OKF_VERSION,
    root: bundle.relativePath,
    concepts,
    indexes,
    logs,
    errors,
    graph: graph.metrics,
    warnings,
  };
}

export function formatOkfValidationErrors(result: OkfBundleValidationResult): string {
  return result.errors
    .map(({ code, message, path: issuePath }) =>
      issuePath ? `- ${issuePath}: [${code}] ${message}` : `- [${code}] ${message}`
    )
    .join('\n');
}

/** Load validated concept documents from an OKF bundle in stable path order. */
export async function loadOkfConcepts(
  workingDir: string,
  root = 'wiki',
  version: string = SUPPORTED_OKF_VERSION
): Promise<OkfConceptBundle> {
  const validation = await validateOkfBundle(workingDir, root, version);
  if (!validation.valid) {
    throw new Error(`Cannot load invalid OKF bundle:\n${formatOkfValidationErrors(validation)}`);
  }

  const bundle = await resolveBundleRoot(workingDir, root);
  const traversalErrors: OkfValidationIssue[] = [];
  const entries = await collectBundleEntries(bundle.absolutePath, traversalErrors);
  if (traversalErrors.length > 0) {
    throw new Error(
      `Cannot load invalid OKF bundle:\n${traversalErrors
        .map(({ code, message, path: issuePath }) =>
          issuePath ? `- ${issuePath}: [${code}] ${message}` : `- [${code}] ${message}`
        )
        .join('\n')}`
    );
  }

  const concepts: OkfConceptDocument[] = [];
  for (const entry of entries) {
    const filename = path.posix.basename(entry.relativePath);
    if (!isConceptFilename(filename)) continue;

    const parsed = parseFrontmatter(await readFile(entry.absolutePath, 'utf-8'));
    if (typeof parsed === 'string') {
      throw new Error(`Cannot load invalid OKF concept ${entry.relativePath}: ${parsed}`);
    }
    const type = normalizeDisplayText(parsed.fields.type);
    if (!type) {
      throw new Error(`Cannot load invalid OKF concept ${entry.relativePath}: missing type`);
    }
    const title = normalizeDisplayText(parsed.fields.title);
    const description = normalizeDisplayText(parsed.fields.description);
    const tags = Array.isArray(parsed.fields.tags)
      ? parsed.fields.tags.flatMap((tag) => {
          const normalized = normalizeDisplayText(tag);
          return normalized ? [normalized] : [];
        })
      : [];
    concepts.push({
      body: parsed.body,
      path: entry.relativePath,
      tags,
      type,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    });
  }

  return { concepts, root: bundle.relativePath };
}

async function resolveBundleRoot(workingDir: string, root: string): Promise<BundleEntry> {
  const requestedRoot = root.trim();
  if (!requestedRoot) throw new Error('OKF bundle root cannot be empty.');

  const workingRoot = resolve(workingDir);
  const absolutePath = resolveWithinWorkingDir(workingDir, requestedRoot, 'access');
  if (absolutePath === workingRoot) {
    throw new Error('OKF bundle root must be a subdirectory of the working directory.');
  }

  let rootStat;
  try {
    rootStat = await lstat(absolutePath);
  } catch {
    throw new Error(`OKF bundle root does not exist: ${requestedRoot}`);
  }
  if (rootStat.isSymbolicLink()) throw new Error('OKF bundle root cannot be a symbolic link.');
  if (!rootStat.isDirectory())
    throw new Error(`OKF bundle root is not a directory: ${requestedRoot}`);

  const [realWorkingRoot, realBundleRoot] = await Promise.all([
    realpath(workingRoot),
    realpath(absolutePath),
  ]);
  const realRelative = relative(realWorkingRoot, realBundleRoot);
  if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
    throw new Error(`OKF bundle root resolves outside the working directory: ${requestedRoot}`);
  }

  return {
    absolutePath,
    relativePath: toPosixPath(relative(workingRoot, absolutePath)),
  };
}

async function collectBundleDirectories(
  absoluteRoot: string,
  absoluteDirectory = absoluteRoot
): Promise<BundleDirectory[]> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const descendants = await Promise.all(
    directories.map((name) =>
      collectBundleDirectories(absoluteRoot, resolve(absoluteDirectory, name))
    )
  );
  return [
    ...descendants.flat(),
    {
      absolutePath: absoluteDirectory,
      relativePath: toPosixPath(relative(absoluteRoot, absoluteDirectory)),
      directories,
      files,
    },
  ];
}

async function collectBundleEntries(
  absoluteRoot: string,
  errors: OkfValidationIssue[],
  absoluteDirectory = absoluteRoot
): Promise<BundleEntry[]> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const collected: BundleEntry[] = [];

  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const absolutePath = resolve(absoluteDirectory, entry.name);
    const relativePath = toPosixPath(relative(absoluteRoot, absolutePath));
    if (entry.isSymbolicLink()) {
      errors.push(
        issue(
          'symbolic_link',
          'Symbolic links are not supported inside an OKF bundle.',
          relativePath
        )
      );
    } else if (entry.isDirectory()) {
      collected.push(...(await collectBundleEntries(absoluteRoot, errors, absolutePath)));
    } else if (entry.isFile()) {
      collected.push({ absolutePath, relativePath });
    }
  }

  return collected;
}

function validateConcept(
  content: string,
  relativePath: string,
  errors: OkfValidationIssue[],
  warnings: OkfValidationIssue[]
): void {
  const parsed = parseFrontmatter(content);
  if (typeof parsed === 'string') {
    errors.push(issue('invalid_frontmatter', parsed, relativePath));
    return;
  }

  const { fields } = parsed;
  if (typeof fields.type !== 'string' || !fields.type.trim()) {
    errors.push(
      issue('invalid_type', 'Concept frontmatter requires a non-empty string `type`.', relativePath)
    );
  }

  for (const field of ['title', 'description', 'resource'] as const) {
    if (field in fields && (typeof fields[field] !== 'string' || !fields[field].trim())) {
      warnings.push(
        issue(
          `invalid_${field}`,
          `Optional field \`${field}\` should be a non-empty string when present.`,
          relativePath
        )
      );
    }
  }
  if (
    'tags' in fields &&
    (!Array.isArray(fields.tags) ||
      fields.tags.some((tag) => typeof tag !== 'string' || !tag.trim()))
  ) {
    warnings.push(
      issue(
        'invalid_tags',
        'Optional field `tags` should be a list of non-empty strings.',
        relativePath
      )
    );
  }
  if (
    'timestamp' in fields &&
    (typeof fields.timestamp !== 'string' || Number.isNaN(Date.parse(fields.timestamp)))
  ) {
    warnings.push(
      issue(
        'invalid_timestamp',
        'Optional field `timestamp` should be an ISO 8601 datetime.',
        relativePath
      )
    );
  }
}

function validateIndex(
  content: string,
  relativePath: string,
  version: string,
  errors: OkfValidationIssue[]
): void {
  let body = stripBom(content);
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    if (relativePath !== 'index.md') {
      errors.push(
        issue(
          'index_frontmatter',
          'Only the bundle-root index.md may contain frontmatter.',
          relativePath
        )
      );
      return;
    }
    const parsed = parseFrontmatter(body);
    if (typeof parsed === 'string') {
      errors.push(issue('invalid_index_frontmatter', parsed, relativePath));
      return;
    }
    if (typeof parsed.fields.okf_version !== 'string' || parsed.fields.okf_version !== version) {
      errors.push(
        issue(
          'invalid_okf_version',
          `Root index.md declares an unsupported OKF version; expected ${version}.`,
          relativePath
        )
      );
    }
    body = parsed.body;
  }

  if (!/^#\s+\S+/mu.test(body)) {
    errors.push(issue('invalid_index', 'index.md must contain a section heading.', relativePath));
  }
  if (!/^\s*[-*+]\s+\[[^\]]+\]\([^)]+\)/mu.test(body)) {
    errors.push(
      issue(
        'invalid_index',
        'index.md must contain at least one Markdown link entry.',
        relativePath
      )
    );
  }
}

function validateLog(content: string, relativePath: string, errors: OkfValidationIssue[]): void {
  const body = stripBom(content);
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) {
    errors.push(issue('log_frontmatter', 'log.md must not contain frontmatter.', relativePath));
    return;
  }
  if (!/^#\s+\S+/mu.test(body)) {
    errors.push(issue('invalid_log', 'log.md must contain a title heading.', relativePath));
  }

  const dateHeadings = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)];
  for (const match of dateHeadings) {
    const date = match[1];
    if (!isIsoDate(date)) {
      errors.push(
        issue('invalid_log_date', `Log date heading must use YYYY-MM-DD: ${date}`, relativePath)
      );
    }
  }
}

function validateInternalLinks(
  content: string,
  sourcePath: string,
  files: Set<string>,
  warnings: OkfValidationIssue[]
): void {
  for (const target of extractMarkdownLinks(content)) {
    if (isExternalOrAnchorLink(target)) continue;
    const linkPath = target.split(/[?#]/u, 1)[0].replace(/^<|>$/gu, '');
    if (!linkPath) continue;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(linkPath);
    } catch {
      warnings.push(issue('invalid_link', `Link is not valid URI encoding: ${target}`, sourcePath));
      continue;
    }

    const resolved = decodedPath.startsWith('/')
      ? path.posix.normalize(decodedPath.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decodedPath));
    if (resolved === '..' || resolved.startsWith('../')) {
      warnings.push(
        issue('link_outside_bundle', `Link resolves outside the OKF bundle: ${target}`, sourcePath)
      );
      continue;
    }

    const candidate = resolved.endsWith('/') ? `${resolved}index.md` : resolved;
    if (!files.has(candidate)) {
      warnings.push(issue('broken_link', `Link target does not exist: ${target}`, sourcePath));
    }
  }
}

function parseFrontmatter(content: string): ParsedFrontmatter | string {
  const normalized = stripBom(content);
  const lines = normalized.split(/\r?\n/u);
  if (lines[0] !== '---') return 'File must begin with a YAML frontmatter delimiter (`---`).';
  const closingLine = lines.indexOf('---', 1);
  if (closingLine === -1) return 'Opening frontmatter has no closing `---` delimiter.';

  let fields: unknown;
  try {
    fields = yaml.parse(lines.slice(1, closingLine).join('\n'), {
      maxAliasCount: 100,
      schema: 'core',
      uniqueKeys: true,
    }) as unknown;
  } catch (error) {
    return `Frontmatter is not valid YAML: ${errorMessage(error)}`;
  }
  if (!isRecord(fields)) return 'Frontmatter must be a YAML mapping.';

  return {
    fields,
    body: lines.slice(closingLine + 1).join('\n'),
  };
}

function readDisplayMetadata(content: string): { title?: string; description?: string } {
  const parsed = parseFrontmatter(content);
  if (typeof parsed === 'string') return {};
  const title = normalizeDisplayText(parsed.fields.title);
  const description = normalizeDisplayText(parsed.fields.description);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function renderIndex(concepts: IndexLink[], directories: IndexLink[], version?: string): string {
  const sections = [
    renderIndexSection('Concepts', concepts),
    renderIndexSection('Directories', directories),
  ]
    .filter(Boolean)
    .join('\n\n');
  const frontmatter = version ? `---\nokf_version: ${JSON.stringify(version)}\n---\n\n` : '';
  return `${frontmatter}${sections}\n`;
}

function renderIndexSection(heading: string, links: IndexLink[]): string {
  if (links.length === 0) return '';
  const items = [...links]
    .sort((left, right) => compareStrings(left.href, right.href))
    .map(({ description, href, label }) => {
      const link = `* [${escapeMarkdownLabel(label)}](${href})`;
      return description ? `${link} - ${description}` : link;
    });
  return `# ${heading}\n\n${items.join('\n')}`;
}

function extractMarkdownLinks(content: string): string[] {
  return [...content.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)].map(
    (match) => match[1]
  );
}

function isExternalOrAnchorLink(target: string): boolean {
  return target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(target);
}

function isConceptFilename(filename: string): boolean {
  return filename.endsWith('.md') && filename !== 'index.md' && filename !== 'log.md';
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function requireSupportedVersion(version: string): asserts version is typeof SUPPORTED_OKF_VERSION {
  if (version !== SUPPORTED_OKF_VERSION) {
    throw new Error(
      `Unsupported OKF version "${version}". DRS currently supports ${SUPPORTED_OKF_VERSION}.`
    );
  }
}

function normalizeDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/\s+/gu, ' ').trim();
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/u, '');
}

function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyGraphMetrics(): WikiConceptGraphMetrics {
  return {
    directedEdgeCount: 0,
    nodeCount: 0,
    orphanConceptCount: 0,
    weaklyConnectedConceptCount: 0,
  };
}

function issue(code: string, message: string, issuePath?: string): OkfValidationIssue {
  return { code, message, ...(issuePath ? { path: issuePath } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
