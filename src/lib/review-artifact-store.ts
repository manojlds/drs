import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { isReviewArtifactPayload, type ReviewArtifactPayload } from './review-artifact.js';
import { resolveWithinWorkingDir } from './path-utils.js';
import type { WorkflowArtifactEnvelope } from './workflow-artifacts.js';
import type { ReviewJsonOutput } from './json-output.js';

export interface LoadedReviewArtifact {
  artifact: WorkflowArtifactEnvelope<ReviewArtifactPayload>;
  path: string;
}

function isReviewArtifactEnvelope(
  value: unknown
): value is WorkflowArtifactEnvelope<ReviewArtifactPayload> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<WorkflowArtifactEnvelope>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.kind === 'review' &&
    typeof candidate.id === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    !!candidate.scope &&
    typeof candidate.scope === 'object' &&
    isReviewArtifactPayload(candidate.payload)
  );
}

async function collectLatestReviewArtifactPaths(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'review') {
        paths.push(join(entryPath, 'latest.json'));
      } else {
        paths.push(...(await collectLatestReviewArtifactPaths(entryPath)));
      }
    }
  }
  return paths;
}

export async function loadLatestReviewArtifact(
  workingDir: string
): Promise<LoadedReviewArtifact | null> {
  const artifactsRoot = resolveWithinWorkingDir(workingDir, '.drs/artifacts', 'read');
  const latestPaths = await collectLatestReviewArtifactPaths(artifactsRoot);
  const candidates: LoadedReviewArtifact[] = [];

  for (const path of latestPaths) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
      if (isReviewArtifactEnvelope(parsed)) {
        candidates.push({ artifact: parsed, path });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  candidates.sort((a, b) => b.artifact.updatedAt.localeCompare(a.artifact.updatedAt));
  return candidates[0] ?? null;
}

export function reviewArtifactToJsonOutput(
  artifact: ReviewArtifactPayload
): ReviewJsonOutput & { artifact?: { reviewId: string; path?: string } } {
  return {
    timestamp: artifact.reviewedAt,
    summary: artifact.summary,
    issues: artifact.findings.map((finding) => ({
      ...finding.issue,
      findingId: finding.id,
      findingState: finding.state,
      findingDisposition: finding.disposition,
    })),
    usage: artifact.usage,
    metadata: artifact.metadata,
    artifact: {
      reviewId: artifact.reviewId,
    },
  };
}

export function toRepoRelativePath(workingDir: string, path: string): string {
  return relative(workingDir, path).replace(/\\/g, '/');
}
