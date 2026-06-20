import type { ReviewResult, ReviewSource } from './review-orchestrator.js';
import type { ReviewIssue } from './comment-formatter.js';
import type { ReviewUsageSummary } from './review-usage.js';
import { createIssueFingerprint } from './comment-manager.js';

export type ReviewFindingState = 'open' | 'attempted' | 'resolved';
export type ReviewFindingDisposition =
  | 'confirmed'
  | 'uncertain'
  | 'pre_existing'
  | 'partial'
  | 'regression'
  | 'resolved';
export type ReviewFindingSource = 'agent' | 'manual' | 'external';

export interface ReviewFinding {
  id: string;
  fingerprint: string;
  issue: ReviewIssue;
  state: ReviewFindingState;
  disposition: ReviewFindingDisposition;
  source: ReviewFindingSource;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewArtifactPayload {
  schemaVersion: 1;
  reviewId: string;
  reviewedAt: string;
  reviewedSha?: string;
  baseBranch?: string;
  headBranch?: string;
  summary: ReviewResult['summary'];
  findings: ReviewFinding[];
  usage?: ReviewUsageSummary;
  metadata?: {
    source?: string;
    project?: string;
    branch?: {
      source?: string;
      target?: string;
    };
  };
}

export interface ReviewArtifactStatus {
  reviewId: string;
  reviewedAt: string;
  reviewedSha?: string;
  totalFindings: number;
  byState: Record<ReviewFindingState, number>;
  byDisposition: Record<ReviewFindingDisposition, number>;
  bySeverity: ReviewResult['summary']['bySeverity'];
  openFindings: number;
}

export interface ReviewFindingSelector {
  ids?: string[];
  fingerprints?: string[];
  severity?: string;
  minSeverity?: string;
}

export interface UpdateReviewFindingsOptions extends ReviewFindingSelector {
  state?: ReviewFindingState;
  disposition?: ReviewFindingDisposition;
}

function createReviewId(date: Date): string {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '');
  const random = Math.random().toString(36).slice(2, 8);
  return `rev_${timestamp}_${random}`;
}

function getSourceString(source: ReviewSource | undefined): string | undefined {
  return source?.name;
}

function getSourceProject(source: ReviewSource | undefined): string | undefined {
  const projectId = source?.context.projectId;
  return typeof projectId === 'string' ? projectId : undefined;
}

function getSourcePullRequest(source: ReviewSource | undefined): {
  headSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
} {
  const pullRequest = source?.context.pullRequest;
  if (!pullRequest || typeof pullRequest !== 'object') {
    return {};
  }
  const record = pullRequest as Record<string, unknown>;
  return {
    headSha: typeof record.headSha === 'string' ? record.headSha : undefined,
    sourceBranch: typeof record.sourceBranch === 'string' ? record.sourceBranch : undefined,
    targetBranch: typeof record.targetBranch === 'string' ? record.targetBranch : undefined,
  };
}

function findingId(index: number): string {
  return `F${String(index + 1).padStart(3, '0')}`;
}

const SEVERITY_RANKS: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function severityRank(severity: string): number {
  return SEVERITY_RANKS[severity.toUpperCase()] ?? 0;
}

function nextFindingId(findings: ReviewFinding[]): string {
  const max = findings.reduce((currentMax, finding) => {
    const match = /^F(\d+)$/.exec(finding.id);
    return match ? Math.max(currentMax, Number.parseInt(match[1] ?? '0', 10)) : currentMax;
  }, 0);
  return findingId(max);
}

function selectorMatches(finding: ReviewFinding, selector: ReviewFindingSelector): boolean {
  const hasIds = selector.ids !== undefined && selector.ids.length > 0;
  const hasFingerprints = selector.fingerprints !== undefined && selector.fingerprints.length > 0;
  const hasSeverity = selector.severity !== undefined && selector.severity !== '';
  const minSeverity = selector.minSeverity;
  const hasMinSeverity = minSeverity !== undefined && minSeverity !== '';

  if (!hasIds && !hasFingerprints && !hasSeverity && !hasMinSeverity) {
    return true;
  }

  return (
    (hasIds && (selector.ids?.includes(finding.id) ?? false)) ||
    (hasFingerprints && (selector.fingerprints?.includes(finding.fingerprint) ?? false)) ||
    (hasSeverity && finding.issue.severity === selector.severity) ||
    (hasMinSeverity && severityRank(finding.issue.severity) >= severityRank(minSeverity))
  );
}

export function createReviewArtifactPayload(
  review: ReviewResult,
  source?: ReviewSource,
  date: Date = new Date()
): ReviewArtifactPayload {
  const now = date.toISOString();
  const pullRequest = getSourcePullRequest(source);
  const findings = review.issues.map(
    (issue, index): ReviewFinding => ({
      id: findingId(index),
      fingerprint: createIssueFingerprint(issue),
      issue,
      state: 'open',
      disposition: 'confirmed',
      source: 'agent',
      createdAt: now,
      updatedAt: now,
    })
  );

  return {
    schemaVersion: 1,
    reviewId: createReviewId(date),
    reviewedAt: now,
    reviewedSha: pullRequest.headSha,
    baseBranch: pullRequest.targetBranch,
    headBranch: pullRequest.sourceBranch,
    summary: review.summary,
    findings,
    usage: review.usage,
    metadata: {
      source: getSourceString(source),
      project: getSourceProject(source),
      branch:
        pullRequest.sourceBranch || pullRequest.targetBranch
          ? {
              source: pullRequest.sourceBranch,
              target: pullRequest.targetBranch,
            }
          : undefined,
    },
  };
}

export function isReviewArtifactPayload(value: unknown): value is ReviewArtifactPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ReviewArtifactPayload>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.reviewId === 'string' &&
    typeof candidate.reviewedAt === 'string' &&
    typeof candidate.summary === 'object' &&
    Array.isArray(candidate.findings)
  );
}

export function getReviewArtifactStatus(artifact: ReviewArtifactPayload): ReviewArtifactStatus {
  const byState: Record<ReviewFindingState, number> = { open: 0, attempted: 0, resolved: 0 };
  const byDisposition: Record<ReviewFindingDisposition, number> = {
    confirmed: 0,
    uncertain: 0,
    pre_existing: 0,
    partial: 0,
    regression: 0,
    resolved: 0,
  };

  for (const finding of artifact.findings) {
    byState[finding.state] += 1;
    byDisposition[finding.disposition] += 1;
  }

  return {
    reviewId: artifact.reviewId,
    reviewedAt: artifact.reviewedAt,
    reviewedSha: artifact.reviewedSha,
    totalFindings: artifact.findings.length,
    byState,
    byDisposition,
    bySeverity: artifact.summary.bySeverity,
    openFindings: byState.open,
  };
}

export function addReviewArtifactFinding(
  artifact: ReviewArtifactPayload,
  issue: ReviewIssue,
  source: ReviewFindingSource = 'manual',
  date: Date = new Date()
): ReviewArtifactPayload {
  const now = date.toISOString();
  const finding: ReviewFinding = {
    id: nextFindingId(artifact.findings),
    fingerprint: createIssueFingerprint(issue),
    issue,
    state: 'open',
    disposition: 'confirmed',
    source,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...artifact,
    findings: [...artifact.findings, finding],
    summary: {
      ...artifact.summary,
      issuesFound: artifact.summary.issuesFound + 1,
      bySeverity: {
        ...artifact.summary.bySeverity,
        [issue.severity]: (artifact.summary.bySeverity[issue.severity] ?? 0) + 1,
      },
      byCategory: {
        ...artifact.summary.byCategory,
        [issue.category]: (artifact.summary.byCategory[issue.category] ?? 0) + 1,
      },
    },
  };
}

export function updateReviewArtifactFindings(
  artifact: ReviewArtifactPayload,
  options: UpdateReviewFindingsOptions,
  date: Date = new Date()
): { artifact: ReviewArtifactPayload; updatedIds: string[] } {
  const now = date.toISOString();
  const updatedIds: string[] = [];
  const findings = artifact.findings.map((finding) => {
    if (!selectorMatches(finding, options)) {
      return finding;
    }
    updatedIds.push(finding.id);
    return {
      ...finding,
      state: options.state ?? finding.state,
      disposition: options.disposition ?? finding.disposition,
      updatedAt: now,
    };
  });

  return {
    artifact: {
      ...artifact,
      findings,
    },
    updatedIds,
  };
}
