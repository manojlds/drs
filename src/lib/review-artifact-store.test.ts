import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLatestReviewArtifact, reviewArtifactToJsonOutput } from './review-artifact-store.js';
import type { ReviewArtifactPayload } from './review-artifact.js';
import type { WorkflowArtifactEnvelope } from './workflow-artifacts.js';

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drs-review-artifact-store-'));
  tempDirs.push(dir);
  return dir;
}

function createPayload(reviewId: string, reviewedAt: string): ReviewArtifactPayload {
  return {
    schemaVersion: 1,
    reviewId,
    reviewedAt,
    summary: {
      filesReviewed: 1,
      issuesFound: 1,
      bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
    },
    findings: [
      {
        id: 'F001',
        fingerprint: 'fp',
        state: 'open',
        disposition: 'confirmed',
        source: 'agent',
        createdAt: reviewedAt,
        updatedAt: reviewedAt,
        issue: {
          category: 'QUALITY',
          severity: 'HIGH',
          title: 'Bug',
          file: 'src/app.ts',
          line: 12,
          problem: 'Problem',
          solution: 'Solution',
          agent: 'quality',
        },
      },
    ],
  };
}

function createEnvelope(
  id: string,
  updatedAt: string,
  payload: ReviewArtifactPayload
): WorkflowArtifactEnvelope<ReviewArtifactPayload> {
  return {
    schemaVersion: 1,
    kind: 'review',
    id,
    createdAt: updatedAt,
    updatedAt,
    scope: { platform: 'local', projectId: 'project', subject: 'default' },
    payload,
  };
}

describe('review-artifact-store', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('loads the newest canonical review artifact', async () => {
    const workingDir = await createTempProject();
    const olderDir = join(workingDir, '.drs/artifacts/local/project/default/review');
    const newerDir = join(workingDir, '.drs/artifacts/github/org-repo/pr-1/review');
    await mkdir(olderDir, { recursive: true });
    await mkdir(newerDir, { recursive: true });
    await writeFile(
      join(olderDir, 'latest.json'),
      JSON.stringify(
        createEnvelope(
          'art_old',
          '2026-01-01T00:00:00.000Z',
          createPayload('rev_old', '2026-01-01T00:00:00.000Z')
        )
      )
    );
    await writeFile(
      join(newerDir, 'latest.json'),
      JSON.stringify(
        createEnvelope(
          'art_new',
          '2026-01-02T00:00:00.000Z',
          createPayload('rev_new', '2026-01-02T00:00:00.000Z')
        )
      )
    );

    const loaded = await loadLatestReviewArtifact(workingDir);

    expect(loaded?.artifact.id).toBe('art_new');
    expect(loaded?.artifact.payload.reviewId).toBe('rev_new');
  });

  it('skips malformed latest review artifacts', async () => {
    const workingDir = await createTempProject();
    const malformedDir = join(workingDir, '.drs/artifacts/local/project/default/review');
    const validDir = join(workingDir, '.drs/artifacts/github/org-repo/pr-1/review');
    await mkdir(malformedDir, { recursive: true });
    await mkdir(validDir, { recursive: true });
    await writeFile(join(malformedDir, 'latest.json'), '{');
    await writeFile(
      join(validDir, 'latest.json'),
      JSON.stringify(
        createEnvelope(
          'art_valid',
          '2026-01-02T00:00:00.000Z',
          createPayload('rev_valid', '2026-01-02T00:00:00.000Z')
        )
      )
    );

    const loaded = await loadLatestReviewArtifact(workingDir);

    expect(loaded?.artifact.id).toBe('art_valid');
  });

  it('converts review artifact payload to legacy JSON output shape with finding metadata', () => {
    const output = reviewArtifactToJsonOutput(createPayload('rev_1', '2026-01-01T00:00:00.000Z'));

    expect(output.summary.issuesFound).toBe(1);
    expect(output.issues[0]).toMatchObject({
      title: 'Bug',
      findingId: 'F001',
      findingState: 'open',
      findingDisposition: 'confirmed',
    });
  });
});
