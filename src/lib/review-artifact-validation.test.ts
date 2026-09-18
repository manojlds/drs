import { describe, expect, it } from 'vitest';
import {
  createIssueFingerprint,
  createIssueStableSignature,
  createLegacyIssueFingerprint,
} from './comment-manager.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import {
  createReviewArtifactPayload,
  reviewArtifactToReviewResult,
  updateReviewArtifactFindings,
} from './review-artifact.js';
import { createWorkflowArtifact } from './workflow-artifacts.js';
import type { ReviewResult, ReviewSource } from './review-orchestrator.js';
import type { JevEvaluation } from './jev/types.js';

const issue: ReviewIssue = {
  category: 'QUALITY',
  severity: 'HIGH',
  title: 'Validate input',
  file: 'src/app.ts',
  line: 4,
  problem: 'Input is used without validation.',
  solution: 'Validate it before use.',
  references: [],
  agent: 'review/quality',
};

const review: ReviewResult = {
  issues: [issue],
  summary: calculateSummary(1, [issue]),
  filesReviewed: 1,
};

const source: ReviewSource = {
  name: 'GitHub PR owner/repo#7',
  files: ['src/app.ts'],
  context: {
    platform: 'github',
    projectId: 'owner/repo',
    pullRequest: {
      headSha: 'abc123',
      sourceBranch: 'feature',
      targetBranch: 'main',
    },
  },
};

const target = {
  platform: 'github',
  projectId: 'owner/repo',
  changeKind: 'pr',
  changeNumber: 7,
  expectedHeadSha: 'abc123',
  currentHeadSha: 'abc123',
  changedFiles: ['src/app.ts'],
};

const jevEvaluation: JevEvaluation = {
  model: 'jev-latest',
  metrics: Object.fromEntries(
    (
      [
        'correctness',
        'cognitiveComplexity',
        'readability',
        'modularity',
        'coupling',
        'changeability',
        'abstractionQuality',
        'projectStructure',
        'duplication',
        'maintainability',
        'testQuality',
        'reliability',
        'security',
        'consistency',
        'documentation',
        'performance',
        'scalability',
        'compatibility',
        'observability',
      ] as const
    ).map((key) => [
      key,
      { applicable: true, score: 8.2, confidence: 0.9, summary: `${key} is strong.` },
    ])
  ) as JevEvaluation['metrics'],
  priorities: [{ metric: 'security', severity: 'medium', reason: 'Escaping needs review.' }],
  usage: { inputTokens: 111, outputTokens: 22 },
};

function createEnvelope() {
  return createWorkflowArtifact({
    kind: 'review',
    scope: {
      platform: 'github',
      projectId: 'owner/repo',
      changeKind: 'pr',
      changeNumber: 7,
    },
    payload: createReviewArtifactPayload(structuredClone(review), source),
  });
}

function createJevEnvelope() {
  return createWorkflowArtifact({
    kind: 'review',
    scope: {
      platform: 'github',
      projectId: 'owner/repo',
      changeKind: 'pr',
      changeNumber: 7,
    },
    payload: createReviewArtifactPayload(
      {
        issues: [],
        summary: calculateSummary(1, []),
        filesReviewed: 1,
        mode: 'jev',
        evaluations: { jev: { status: 'completed', evaluation: structuredClone(jevEvaluation) } },
      },
      source
    ),
  });
}

describe('review artifact posting validation', () => {
  it('converts a valid canonical envelope to a review result', () => {
    const envelope = createEnvelope();

    expect(envelope.payload.findings[0].fingerprint).toMatch(/^v2:/);
    expect(envelope.payload.findings[0].stableSignature).toMatch(/^sig1:/);
    expect(reviewArtifactToReviewResult(envelope, target)).toEqual({
      issues: [issue],
      summary: calculateSummary(1, [issue]),
      filesReviewed: 1,
      usage: undefined,
    });
  });

  it('round-trips Jev scorecards without turning priorities into findings', () => {
    const envelope = createJevEnvelope();

    expect(envelope.payload.findings).toEqual([]);
    expect(envelope.payload.evaluations).toEqual({
      jev: { status: 'completed', evaluation: jevEvaluation },
    });
    expect(reviewArtifactToReviewResult(envelope, target)).toMatchObject({
      issues: [],
      mode: 'jev',
      evaluations: { jev: { status: 'completed', evaluation: jevEvaluation } },
    });
  });

  it('rejects malformed Jev metrics, comparisons, and review modes', () => {
    const extraMetric = createJevEnvelope();
    const extraEvaluation = (
      extraMetric.payload.evaluations?.jev as { status: 'completed'; evaluation: JevEvaluation }
    ).evaluation as unknown as { metrics: Record<string, unknown> };
    extraEvaluation.metrics.unrecognized = { applicable: false };
    expect(() => reviewArtifactToReviewResult(extraMetric, target)).toThrow(/metrics/i);

    const inconsistentMetric = createJevEnvelope();
    const inconsistentEvaluation = (
      inconsistentMetric.payload.evaluations?.jev as {
        status: 'completed';
        evaluation: JevEvaluation;
      }
    ).evaluation as unknown as { metrics: Record<string, unknown> };
    inconsistentEvaluation.metrics.security = {
      applicable: false,
      score: 9,
      confidence: 1,
      summary: 'Invalid extra fields.',
    };
    expect(() => reviewArtifactToReviewResult(inconsistentMetric, target)).toThrow(
      /metric security/i
    );

    const outOfRangeMetric = createJevEnvelope();
    const outOfRangeEvaluation = (
      outOfRangeMetric.payload.evaluations?.jev as {
        status: 'completed';
        evaluation: JevEvaluation;
      }
    ).evaluation;
    const correctness = outOfRangeEvaluation.metrics.correctness;
    if (correctness.applicable) correctness.score = 0;
    expect(() => reviewArtifactToReviewResult(outOfRangeMetric, target)).toThrow(/out of range/i);

    const invalidComparison = createJevEnvelope();
    const comparisonEvaluation = (
      invalidComparison.payload.evaluations?.jev as {
        status: 'completed';
        evaluation: JevEvaluation;
      }
    ).evaluation;
    comparisonEvaluation.comparison = [
      {
        metric: 'correctness',
        previousScore: 7,
        currentScore: 8,
        delta: 99,
        direction: 'improved',
      },
    ];
    expect(() => reviewArtifactToReviewResult(invalidComparison, target)).toThrow(/comparison/i);

    const invalidMode = createJevEnvelope();
    (invalidMode.payload as unknown as Record<string, unknown>).mode = 'unsupported';
    expect(() => reviewArtifactToReviewResult(invalidMode, target)).toThrow(/mode/i);
  });

  it('accepts an existing artifact with a valid legacy fingerprint and no signature', () => {
    const envelope = createEnvelope();
    envelope.payload.findings[0].fingerprint = createLegacyIssueFingerprint(issue);
    delete envelope.payload.findings[0].stableSignature;

    expect(reviewArtifactToReviewResult(envelope, target).issues).toEqual([issue]);
  });

  it('preserves a file-level finding without a line number', () => {
    const envelope = createEnvelope();
    delete envelope.payload.findings[0].issue.line;
    envelope.payload.findings[0].fingerprint = createIssueFingerprint(
      envelope.payload.findings[0].issue
    );

    const result = reviewArtifactToReviewResult(envelope, target);

    expect(result.issues[0]).not.toHaveProperty('line');
    expect(result.issues[0].file).toBe('src/app.ts');
  });

  it('rejects scope and head mismatches', () => {
    const wrongScope = createEnvelope();
    wrongScope.scope.changeNumber = 8;
    expect(() => reviewArtifactToReviewResult(wrongScope, target)).toThrow(/scope does not match/);

    expect(() =>
      reviewArtifactToReviewResult(createEnvelope(), { ...target, currentHeadSha: 'new-head' })
    ).toThrow(/head changed/);

    const wrongReviewedHead = createEnvelope();
    wrongReviewedHead.payload.reviewedSha = 'other-head';
    expect(() => reviewArtifactToReviewResult(wrongReviewedHead, target)).toThrow(
      /head does not match/
    );
  });

  it('rejects findings outside the current change and inconsistent summaries', () => {
    const wrongFile = createEnvelope();
    wrongFile.payload.findings[0].issue.file = 'src/other.ts';
    wrongFile.payload.findings[0].fingerprint = createIssueFingerprint(
      wrongFile.payload.findings[0].issue
    );
    expect(() => reviewArtifactToReviewResult(wrongFile, target)).toThrow(/changed file/);

    const wrongSummary = createEnvelope();
    wrongSummary.payload.summary.issuesFound = 2;
    expect(() => reviewArtifactToReviewResult(wrongSummary, target)).toThrow(
      /summary does not match/
    );
  });

  it('rejects duplicate or tampered finding fingerprints', () => {
    const envelope = createEnvelope();
    envelope.payload.findings[0].fingerprint = 'tampered';

    expect(() => reviewArtifactToReviewResult(envelope, target)).toThrow(/fingerprint/);
  });

  it('rejects duplicate findings represented by mixed exact aliases', () => {
    const envelope = createEnvelope();
    envelope.payload.findings.push({
      ...structuredClone(envelope.payload.findings[0]),
      id: 'F002',
      fingerprint: createLegacyIssueFingerprint(issue),
    });
    envelope.payload.summary = calculateSummary(1, [issue, issue]);

    expect(() => reviewArtifactToReviewResult(envelope, target)).toThrow(/duplicate fingerprint/);
  });

  it('matches exact fingerprint selectors across artifact generations', () => {
    const legacyArtifact = createEnvelope().payload;
    legacyArtifact.findings[0].fingerprint = createLegacyIssueFingerprint(issue);
    const legacyResult = updateReviewArtifactFindings(legacyArtifact, {
      fingerprints: [createIssueFingerprint(issue)],
      state: 'attempted',
    });

    const currentArtifact = createEnvelope().payload;
    const currentResult = updateReviewArtifactFindings(currentArtifact, {
      fingerprints: [createLegacyIssueFingerprint(issue)],
      state: 'attempted',
    });

    expect(legacyResult.updatedIds).toEqual(['F001']);
    expect(currentResult.updatedIds).toEqual(['F001']);
  });

  it('rejects a tampered stable signature', () => {
    const envelope = createEnvelope();
    envelope.payload.findings[0].stableSignature = 'sig1:tampered';

    expect(() => reviewArtifactToReviewResult(envelope, target)).toThrow(/stable signature/);

    envelope.payload.findings[0].stableSignature = createIssueStableSignature(issue);
    expect(() => reviewArtifactToReviewResult(envelope, target)).not.toThrow();
  });
});
