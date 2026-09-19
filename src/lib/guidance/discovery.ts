import { createHash } from 'crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import type { GuidanceRubric, GuidanceRubricSource } from './rubric.js';

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_SOURCES = 100;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const GUIDANCE_FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md']);
const EXCLUDED_DIRECTORIES = new Set([
  '.drs',
  '.git',
  '.next',
  '.astro',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);

export interface GuidanceSource extends GuidanceRubricSource {
  content: string;
}

export interface GuidanceDiscoveryOptions {
  maxDepth?: number;
  maxSources?: number;
  maxSourceBytes?: number;
  includeCopilotInstructions?: boolean;
}

export function discoverGuidanceSources(
  projectRoot: string,
  options: GuidanceDiscoveryOptions = {}
): GuidanceSource[] {
  const root = realpathSync(projectRoot);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const paths: string[] = [];

  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(fullPath, depth + 1);
        continue;
      }
      if (entry.isFile() && GUIDANCE_FILE_NAMES.has(entry.name)) paths.push(fullPath);
    }
  };

  visit(root, 0);

  if (options.includeCopilotInstructions !== false) {
    const copilotPath = resolve(root, '.github', 'copilot-instructions.md');
    if (isRegularFileInsideRoot(root, copilotPath)) paths.push(copilotPath);
  }

  const uniquePaths = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  if (uniquePaths.length > maxSources) {
    throw new Error(`Guidance discovery found more than ${maxSources} source files.`);
  }

  return uniquePaths.map((filePath) =>
    readGuidanceSource(
      root,
      filePath,
      maxSourceBytes,
      toRepositoryPath(root, filePath) === '.github/copilot-instructions.md' ? '**/*' : undefined
    )
  );
}

export function assertGuidanceRubricCurrent(
  rubric: GuidanceRubric,
  discoveredSources: readonly GuidanceSource[]
): void {
  const expected = new Map(rubric.sources.map((source) => [source.path, source]));
  const actual = new Map(discoveredSources.map((source) => [source.path, source]));
  const changed = new Set<string>();

  for (const [path, source] of expected) {
    const discovered = actual.get(path);
    if (discovered?.sha256 !== source.sha256 || discovered.scope !== source.scope) {
      changed.add(path);
    }
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) changed.add(path);
  }

  if (changed.size > 0) {
    throw new Error(
      `Guidance rubric is stale; recompile after changes to: ${[...changed].sort().join(', ')}`
    );
  }
}

function readGuidanceSource(
  root: string,
  filePath: string,
  maxSourceBytes: number,
  scopeOverride?: string
): GuidanceSource {
  if (!isRegularFileInsideRoot(root, filePath)) {
    throw new Error(`Guidance source is not a regular file inside the repository: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  if (bytes.byteLength > maxSourceBytes) {
    const relativePath = toRepositoryPath(root, filePath);
    throw new Error(`Guidance source ${relativePath} exceeds ${maxSourceBytes} bytes.`);
  }

  const path = toRepositoryPath(root, filePath);
  const directory = dirname(path).replaceAll('\\', '/');
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    scope: scopeOverride ?? (directory === '.' ? '**/*' : `${directory}/**/*`),
    content: bytes.toString('utf-8'),
  };
}

function isRegularFileInsideRoot(root: string, filePath: string): boolean {
  try {
    const relativePath = relative(root, filePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath.startsWith(sep)
    ) {
      return false;
    }
    const realPath = realpathSync(filePath);
    const realRelativePath = relative(root, realPath);
    if (
      realRelativePath === '..' ||
      realRelativePath.startsWith(`..${sep}`) ||
      realRelativePath.startsWith(sep)
    ) {
      return false;
    }
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function toRepositoryPath(root: string, filePath: string): string {
  const path = relative(root, filePath).replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || path.startsWith('/')) {
    throw new Error(`Guidance source is outside the repository: ${filePath}`);
  }
  return path;
}
