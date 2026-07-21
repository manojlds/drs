import { describe, expect, it } from 'vitest';
import { createIssueFingerprint } from './comment-manager.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import { createReviewArtifactPayload, reviewArtifactToReviewResult } from './review-artifact.js';
import { createWorkflowArtifact } from './workflow-artifacts.js';
import type { ReviewResult, ReviewSource } from './review-orchestrator.js';

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

describe('review artifact posting validation', () => {
  it('converts a valid canonical envelope to a review result', () => {
    expect(reviewArtifactToReviewResult(createEnvelope(), target)).toEqual({
      issues: [issue],
      summary: calculateSummary(1, [issue]),
      filesReviewed: 1,
      usage: undefined,
    });
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
});
