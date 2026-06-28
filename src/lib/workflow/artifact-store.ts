import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolveWithinWorkingDir } from '../path-utils.js';

/**
 * Reference to a workflow artifact stored outside Temporal history.
 *
 * Large node outputs (diffs, review payloads, model responses) are persisted
 * to an artifact store and replaced with this ref in the Temporal event
 * history so history stays small and replayable.
 */
export interface TemporalArtifactRef {
  kind: 'artifact-ref';
  key: string;
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
}

/**
 * Metadata recorded alongside a stored artifact value.
 */
export interface ArtifactMetadata {
  contentType?: string;
}

/**
 * Policy controlling which node output values stay inline in workflow/results
 * and which are offloaded to the artifact store as refs.
 *
 * - `inline-only`: every value stays inline (local executor default).
 * - `ref-large-values`: values larger than `inlineMaxBytes` become refs
 *   (Temporal executor default).
 * - `ref-all-values`: every value becomes a ref (useful for debugging or
 *   strict-history-size scenarios).
 */
export type ArtifactInliningMode = 'inline-only' | 'ref-large-values' | 'ref-all-values';

export interface ArtifactInliningPolicy {
  mode: ArtifactInliningMode;
  inlineMaxBytes: number;
}

export const DEFAULT_ARTIFACT_POLICY: ArtifactInliningPolicy = {
  mode: 'ref-large-values',
  inlineMaxBytes: 64 * 1024,
};

/**
 * Backend for persisting and hydrating workflow artifact values.
 *
 * The local filesystem store is used for development and the Temporal MVP.
 * S3-compatible and other object stores can implement the same interface for
 * CI/production without changing workflow code.
 */
export interface WorkflowArtifactStore {
  put(key: string, value: unknown, metadata?: ArtifactMetadata): Promise<TemporalArtifactRef>;
  get(ref: TemporalArtifactRef): Promise<unknown>;
  exists(ref: TemporalArtifactRef): Promise<boolean>;
}

export function isArtifactRef(value: unknown): value is TemporalArtifactRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).kind === 'artifact-ref' &&
    typeof (value as Record<string, unknown>).key === 'string' &&
    typeof (value as Record<string, unknown>).uri === 'string'
  );
}

/**
 * Decide whether a value should stay inline or be offloaded to the store.
 */
export function shouldInline(serializedSize: number, policy: ArtifactInliningPolicy): boolean {
  if (policy.mode === 'inline-only') return true;
  if (policy.mode === 'ref-all-values') return false;
  return serializedSize <= policy.inlineMaxBytes;
}

function serialize(value: unknown): { bytes: Buffer; contentType: string } {
  if (typeof value === 'string') {
    return { bytes: Buffer.from(value, 'utf-8'), contentType: 'text/plain' };
  }
  return {
    bytes: Buffer.from(JSON.stringify(value, null, 2), 'utf-8'),
    contentType: 'application/json',
  };
}

function deserialize(buf: Buffer, contentType?: string): unknown {
  const text = buf.toString('utf-8');
  if (contentType === 'application/json') {
    return JSON.parse(text);
  }
  if (contentType === 'text/plain') {
    return text;
  }
  // Fallback: try JSON, then treat as string.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function slugSegment(value: string, fallback: string): string {
  const raw = value === undefined || value === '' ? fallback : String(value);
  const slug = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function sanitizeKey(key: string): string {
  const segments = key.split('/').map((seg) => slugSegment(seg, 'segment'));
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`Refusing to put artifact with unsafe key: ${key}`);
  }
  return segments.join('/');
}

/**
 * Local filesystem artifact store.
 *
 * Persists artifacts under `.drs/artifacts/temporal/<namespace>/<key>` within
 * the specified working directory. The `uri` in returned refs is a relative
 * path so the store works consistently across machines when the working
 * directory matches.
 */
export class LocalWorkflowArtifactStore implements WorkflowArtifactStore {
  private readonly baseDir: string;

  constructor(
    private readonly workingDir: string,
    namespace = 'default'
  ) {
    const slug = slugSegment(namespace, 'default');
    this.baseDir = `.drs/artifacts/temporal/${slug}`;
  }

  async put(
    key: string,
    value: unknown,
    metadata?: ArtifactMetadata
  ): Promise<TemporalArtifactRef> {
    const { bytes, contentType } = serialize(value);
    const resolvedContentType = metadata?.contentType ?? contentType;
    const hash = sha256(bytes);
    const safeKey = sanitizeKey(key);
    const relativePath = join(this.baseDir, `${safeKey}.json`);
    const fullPath = resolveWithinWorkingDir(this.workingDir, relativePath, 'write');

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes, 'utf-8');

    return {
      kind: 'artifact-ref',
      key,
      uri: relativePath,
      contentType: resolvedContentType,
      sizeBytes: bytes.length,
      sha256: hash,
    };
  }

  async get(ref: TemporalArtifactRef): Promise<unknown> {
    const fullPath = resolveWithinWorkingDir(this.workingDir, ref.uri, 'read');
    const bytes = await readFile(fullPath);
    return deserialize(bytes, ref.contentType);
  }

  async exists(ref: TemporalArtifactRef): Promise<boolean> {
    try {
      const fullPath = resolveWithinWorkingDir(this.workingDir, ref.uri, 'read');
      await readFile(fullPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
