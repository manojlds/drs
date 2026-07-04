import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseReviewOutput } from './review-parser.js';
import type { ReviewArtifactPayload } from './review-artifact.js';
import type { WorkflowArtifactEnvelope } from './workflow-artifacts.js';

// ── Helpers ──────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `drs-review-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(join(testDir, '.drs'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const REVIEW_JSON = {
  issues: [
    {
      category: 'SECURITY',
      severity: 'HIGH',
      title: 'SQL Injection',
      file: 'src/db.ts',
      line: 10,
      problem: 'Unsanitized input',
      solution: 'Use parameterized queries',
    },
  ],
};

function createReviewArtifact(reviewedAt: string): WorkflowArtifactEnvelope<ReviewArtifactPayload> {
  return {
    schemaVersion: 1,
    kind: 'review',
    id: 'art_1',
    createdAt: reviewedAt,
    updatedAt: reviewedAt,
    scope: { platform: 'local', projectId: 'local', subject: 'default' },
    payload: {
      schemaVersion: 1,
      reviewId: 'rev_1',
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
            title: 'Canonical issue',
            file: 'src/app.ts',
            line: 12,
            problem: 'Problem',
            solution: 'Solution',
            agent: 'quality',
          },
        },
      ],
    },
  };
}

// ── parseReviewOutput ────────────────────────────────────────────

describe('parseReviewOutput', () => {
  describe('rawOutput inline JSON', () => {
    it('parses raw output with JSON in a fenced code block', async () => {
      const raw = `Here are my findings:

\`\`\`json
${JSON.stringify(REVIEW_JSON, null, 2)}
\`\`\`

That's it.`;
      const result = await parseReviewOutput(testDir, false, raw);
      expect(result).toEqual(REVIEW_JSON);
    });

    it('parses simple non-nested JSON from raw output', async () => {
      // Simple JSON without nested objects parses correctly
      const simpleReview = { summary: 'No issues found', issueCount: 0 };
      const raw = JSON.stringify(simpleReview);
      const result = await parseReviewOutput(testDir, false, raw);
      expect(result).toEqual(simpleReview);
    });

    it('prefers inline JSON when raw output has fenced JSON', async () => {
      const raw = `\`\`\`json\n${JSON.stringify(REVIEW_JSON, null, 2)}\n\`\`\``;
      const result = await parseReviewOutput(testDir, false, raw);
      expect(result).toEqual(REVIEW_JSON);
    });
  });

  describe('output pointer', () => {
    it('throws for outputType-only pointers', async () => {
      const raw = JSON.stringify({ outputType: 'describe_output' });
      await expect(parseReviewOutput(testDir, false, raw)).rejects.toThrow(
        'Unexpected output type for review output'
      );
    });

    it('follows outputPath pointer to custom file', async () => {
      const customPath = '.drs/custom-review.json';
      await writeFile(join(testDir, customPath), JSON.stringify(REVIEW_JSON));

      const raw = JSON.stringify({ outputPath: customPath });
      const result = await parseReviewOutput(testDir, false, raw);
      expect(result).toEqual(REVIEW_JSON);
    });

    it('falls back to canonical artifacts when pointer file does not exist', async () => {
      const artifactDir = join(testDir, '.drs/artifacts/local/local/default/review');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, 'latest.json'),
        JSON.stringify(createReviewArtifact('2026-01-01T00:00:00.000Z'))
      );
      const raw = JSON.stringify({ outputPath: '.drs/missing.json' });
      const result = await parseReviewOutput(testDir, false, raw);
      expect(result).toMatchObject({ issues: [{ title: 'Canonical issue' }] });
    });

    it('throws when outputType is combined with outputPath', async () => {
      const raw = JSON.stringify({ outputType: 'describe_output', outputPath: '.drs/custom.json' });
      await expect(parseReviewOutput(testDir, false, raw)).rejects.toThrow(
        'Unexpected output type for review output'
      );
    });
  });

  describe('canonical artifact fallback', () => {
    it('reads canonical review artifacts when raw output is unavailable', async () => {
      const artifactDir = join(testDir, '.drs/artifacts/local/local/default/review');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, 'latest.json'),
        JSON.stringify(createReviewArtifact('2026-01-01T00:00:00.000Z'))
      );

      const result = await parseReviewOutput(testDir, false);

      expect(result).toMatchObject({
        issues: [
          {
            title: 'Canonical issue',
            findingId: 'F001',
            findingState: 'open',
          },
        ],
        artifact: {
          reviewId: 'rev_1',
          path: '.drs/artifacts/local/local/default/review/latest.json',
        },
      });
    });

    it('throws when raw output and canonical artifacts are missing', async () => {
      await expect(parseReviewOutput(testDir, false)).rejects.toThrow(
        'Review output not found in raw output or canonical review artifacts'
      );
    });
  });

  describe('debug logging', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let consoleSpy: any;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('logs when loading from pointer path', async () => {
      const customPath = '.drs/custom-review.json';
      await writeFile(join(testDir, customPath), JSON.stringify(REVIEW_JSON));

      const raw = JSON.stringify({ outputPath: customPath });
      await parseReviewOutput(testDir, true, raw);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Review output loaded from'));
    });

    it('logs parse failure for invalid JSON in raw output', async () => {
      const artifactDir = join(testDir, '.drs/artifacts/local/local/default/review');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, 'latest.json'),
        JSON.stringify(createReviewArtifact('2026-01-01T00:00:00.000Z'))
      );

      await parseReviewOutput(testDir, true, 'not valid json at all');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Review output pointer parse failed')
      );
    });

    it('logs fallback when pointer file is missing', async () => {
      const artifactDir = join(testDir, '.drs/artifacts/local/local/default/review');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, 'latest.json'),
        JSON.stringify(createReviewArtifact('2026-01-01T00:00:00.000Z'))
      );

      const raw = JSON.stringify({ outputPath: '.drs/nonexistent.json' });
      await parseReviewOutput(testDir, true, raw);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('not found at .drs/nonexistent.json')
      );
    });
  });

  describe('security', () => {
    it('rejects path traversal in outputPath', async () => {
      const raw = JSON.stringify({ outputPath: '../../../etc/passwd' });
      await expect(parseReviewOutput(testDir, false, raw)).rejects.toThrow(
        'Refusing to read outside working directory'
      );
    });

    it('rejects absolute path in outputPath', async () => {
      const raw = JSON.stringify({ outputPath: '/etc/passwd' });
      await expect(parseReviewOutput(testDir, false, raw)).rejects.toThrow(
        'Refusing to read outside working directory'
      );
    });
  });
});
