import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolveWithinWorkingDir } from './path-utils.js';

export interface WorkflowArtifactScope {
  platform: string;
  projectId?: string;
  subject?: string;
  changeKind?: string;
  changeNumber?: number | string;
  branch?: string;
}

export interface WorkflowArtifactEnvelope<T = unknown> {
  schemaVersion: 1;
  kind: string;
  id: string;
  createdAt: string;
  updatedAt: string;
  scope: WorkflowArtifactScope;
  payload: T;
}

export interface SaveWorkflowArtifactOptions<T = unknown> {
  kind: string;
  scope: WorkflowArtifactScope;
  payload: T;
  id?: string;
}

export interface SavedWorkflowArtifact<T = unknown> {
  artifact: WorkflowArtifactEnvelope<T>;
  path: string;
  latestPath: string;
}

export interface UpdateWorkflowArtifactOptions<T = unknown> {
  artifact: WorkflowArtifactEnvelope<T>;
  payload: T;
}

function slugSegment(value: string | number | undefined, fallback: string): string {
  const raw = value === undefined || value === '' ? fallback : String(value);
  const slug = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function createWorkflowArtifactId(date: Date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '');
  const random = Math.random().toString(36).slice(2, 8);
  return `art_${timestamp}_${random}`;
}

/**
 * Canonical workflow artifact id pattern.
 *
 * Matches IDs produced by the two artifact generators:
 *   - `createWorkflowArtifactId` -> `art_<ISO-date-digits>_<6-char-base36>`
 *   - `createReviewId`            -> `rev_<ISO-date-digits>_<6-char-base36>`
 *
 * Both generators always emit lowercase, so the regex is intentionally
 * case-sensitive — early versions with `/i` over-matched rejected inputs
 * like `ART_…_A1B2C3` which are also non-canonical.
 *
 * Any id that does not match this shape is rejected because workflows allow
 * the `id` option on `load`/`artifact-exists` to be templated from
 * `--input` values, which means a malicious caller can otherwise inject
 * `../` segments and escape the `.drs/artifacts/<scope>/` namespace.
 */
const ARTIFACT_ID_PATTERN = /^(art|rev)_[0-9]+_[a-z0-9]+$/;
const MAX_REVIEW_ARTIFACT_BYTES = 5 * 1024 * 1024;

/**
 * Assert that an artifact id matches the canonical auto-generated shape.
 *
 * Accepts `unknown` so callers at workflow boundaries can pass raw
 * template-rendered values without an upfront cast. Throws when the value
 * is not a string, or the string does not match the canonical pattern.
 * Exposed so callers (including workflow action runners) can validate ids
 * before joining them onto a directory path.
 */
export function assertSafeArtifactId(id: unknown, action: 'read' | 'write' = 'read'): void {
  if (typeof id !== 'string' || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new Error(`Refusing to ${action} workflow artifact with invalid id: ${String(id)}`);
  }
}

export function getWorkflowArtifactSubject(scope: WorkflowArtifactScope): string {
  if (scope.subject) {
    return slugSegment(scope.subject, 'subject');
  }
  if (scope.changeKind && scope.changeNumber !== undefined) {
    return `${slugSegment(scope.changeKind, 'change')}-${slugSegment(scope.changeNumber, '0')}`;
  }
  if (scope.branch) {
    return `branch-${slugSegment(scope.branch, 'unknown')}`;
  }
  return 'default';
}

export function getWorkflowArtifactDirectory(
  workingDir: string,
  kind: string,
  scope: WorkflowArtifactScope
): string {
  const relativePath = join(
    '.drs',
    'artifacts',
    slugSegment(scope.platform, 'local'),
    slugSegment(scope.projectId, 'project'),
    getWorkflowArtifactSubject(scope),
    slugSegment(kind, 'artifact')
  );
  return resolveWithinWorkingDir(workingDir, relativePath, 'write');
}

export function createWorkflowArtifact<T>(
  options: SaveWorkflowArtifactOptions<T>,
  date: Date = new Date()
): WorkflowArtifactEnvelope<T> {
  const now = date.toISOString();
  return {
    schemaVersion: 1,
    kind: options.kind,
    id: options.id ?? createWorkflowArtifactId(date),
    createdAt: now,
    updatedAt: now,
    scope: options.scope,
    payload: options.payload,
  };
}

export async function saveWorkflowArtifact<T>(
  workingDir: string,
  options: SaveWorkflowArtifactOptions<T>
): Promise<SavedWorkflowArtifact<T>> {
  if (options.id !== undefined) {
    assertSafeArtifactId(options.id, 'write');
  }
  const artifact = createWorkflowArtifact(options);
  const directory = getWorkflowArtifactDirectory(workingDir, options.kind, options.scope);
  const path = join(directory, `${artifact.id}.json`);
  const latestPath = join(directory, 'latest.json');
  const content = `${JSON.stringify(artifact, null, 2)}\n`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  await writeFile(latestPath, content, 'utf-8');

  return { artifact, path, latestPath };
}

export async function updateWorkflowArtifact<T>(
  workingDir: string,
  options: UpdateWorkflowArtifactOptions<T>
): Promise<SavedWorkflowArtifact<T>> {
  assertSafeArtifactId(options.artifact.id, 'write');
  const artifact: WorkflowArtifactEnvelope<T> = {
    ...options.artifact,
    updatedAt: new Date().toISOString(),
    payload: options.payload,
  };
  const directory = getWorkflowArtifactDirectory(workingDir, artifact.kind, artifact.scope);
  const path = join(directory, `${artifact.id}.json`);
  const latestPath = join(directory, 'latest.json');
  const content = `${JSON.stringify(artifact, null, 2)}\n`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  await writeFile(latestPath, content, 'utf-8');

  return { artifact, path, latestPath };
}

function assertWorkflowArtifactEnvelope(value: unknown): asserts value is WorkflowArtifactEnvelope {
  if (!value || typeof value !== 'object') {
    throw new Error('Workflow artifact is not an object.');
  }
  const candidate = value as Partial<WorkflowArtifactEnvelope>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.kind !== 'string' ||
    typeof candidate.id !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !candidate.scope ||
    typeof candidate.scope !== 'object' ||
    !Object.prototype.hasOwnProperty.call(candidate, 'payload')
  ) {
    throw new Error('Workflow artifact envelope is invalid.');
  }
}

function assertWorkflowArtifactScope(
  actual: WorkflowArtifactScope,
  expected: WorkflowArtifactScope
): void {
  const fields = [
    'platform',
    'projectId',
    'subject',
    'changeKind',
    'changeNumber',
    'branch',
  ] as const;
  if (fields.some((field) => actual[field] !== expected[field])) {
    throw new Error('Workflow artifact scope does not match the requested scope.');
  }
}

export async function loadWorkflowArtifact<T = unknown>(
  workingDir: string,
  kind: string,
  scope: WorkflowArtifactScope,
  id?: string
): Promise<{ artifact: WorkflowArtifactEnvelope<T>; path: string }> {
  if (id !== undefined) {
    assertSafeArtifactId(id, 'read');
  }
  const directory = getWorkflowArtifactDirectory(workingDir, kind, scope);
  const path = join(directory, id ? `${id}.json` : 'latest.json');
  if (kind === 'review' && (await stat(path)).size > MAX_REVIEW_ARTIFACT_BYTES) {
    throw new Error('Review artifact exceeds the maximum allowed size.');
  }
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  assertWorkflowArtifactEnvelope(parsed);
  assertSafeArtifactId(parsed.id, 'read');
  if (parsed.kind !== kind) {
    throw new Error(`Expected workflow artifact kind "${kind}" but found "${parsed.kind}".`);
  }
  if (id !== undefined && parsed.id !== id) {
    throw new Error(`Expected workflow artifact id "${id}" but found "${parsed.id}".`);
  }
  assertWorkflowArtifactScope(parsed.scope, scope);
  return { artifact: parsed as WorkflowArtifactEnvelope<T>, path };
}

export async function workflowArtifactExists(
  workingDir: string,
  kind: string,
  scope: WorkflowArtifactScope,
  id?: string
): Promise<boolean> {
  try {
    await loadWorkflowArtifact(workingDir, kind, scope, id);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
