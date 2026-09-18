import type { ReviewResult, ReviewSource } from './review-orchestrator.js';
import {
  calculateSummary,
  type IssueCategory,
  type IssueSeverity,
  type ReviewIssue,
} from './comment-formatter.js';
import type { ReviewUsageSummary } from './review-usage.js';
import { metricKeys, type JevEvaluation, type MetricKey } from './jev/types.js';
import {
  createIssueFingerprint,
  createIssueStableSignature,
  createLegacyIssueFingerprint,
} from './comment-manager.js';
import { assertSafeArtifactId } from './workflow-artifacts.js';

export type ReviewFindingState = 'open' | 'attempted' | 'resolved';
export type ReviewFindingDisposition =
  | 'confirmed'
  | 'uncertain'
  | 'pre_existing'
  | 'partial'
  | 'still_open'
  | 'regression'
  | 'resolved';
export type ReviewFindingSource = 'agent' | 'manual' | 'external';

export interface ReviewFindingVerification {
  disposition: 'resolved' | 'still_open' | 'partial' | 'regression' | 'missing';
  rationale?: string;
  verifiedAt: string;
}

export interface ReviewFinding {
  id: string;
  fingerprint: string;
  stableSignature?: string;
  issue: ReviewIssue;
  state: ReviewFindingState;
  disposition: ReviewFindingDisposition;
  source: ReviewFindingSource;
  createdAt: string;
  updatedAt: string;
  verification?: ReviewFindingVerification;
}

export interface ReviewArtifactPayload {
  schemaVersion: 1;
  reviewId: string;
  reviewedAt: string;
  reviewedSha?: string;
  baseBranch?: string;
  headBranch?: string;
  summary: ReviewResult['summary'];
  mode?: ReviewResult['mode'];
  evaluations?: ReviewResult['evaluations'];
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
}

export interface UpdateReviewFindingsOptions extends ReviewFindingSelector {
  state?: ReviewFindingState;
  disposition?: ReviewFindingDisposition;
}

export interface ReviewArtifactPostingTarget {
  platform: string;
  projectId: string;
  changeKind: string;
  changeNumber: number | string;
  expectedHeadSha: string;
  currentHeadSha: string;
  changedFiles: string[];
}

const ISSUE_SEVERITIES = new Set<IssueSeverity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const ISSUE_CATEGORIES = new Set<IssueCategory>([
  'SECURITY',
  'QUALITY',
  'STYLE',
  'PERFORMANCE',
  'DOCUMENTATION',
]);
const FINDING_STATES = new Set<ReviewFindingState>(['open', 'attempted', 'resolved']);
const FINDING_DISPOSITIONS = new Set<ReviewFindingDisposition>([
  'confirmed',
  'uncertain',
  'pre_existing',
  'partial',
  'still_open',
  'regression',
  'resolved',
]);
const FINDING_SOURCES = new Set<ReviewFindingSource>(['agent', 'manual', 'external']);
const REVIEW_ID_PATTERN = /^rev_[0-9]+_[a-z0-9]+$/;
const MAX_FINDINGS = 1000;
const MAX_ISSUE_TEXT_LENGTH = 20_000;
const JEV_PRIORITY_SEVERITIES = new Set(['low', 'medium', 'high']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength = MAX_ISSUE_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Review artifact ${field} must be a non-empty bounded string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 100);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Review artifact ${field} must be a valid timestamp.`);
  }
  return timestamp;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Review artifact ${field} must be a non-negative number.`);
  }
  return value;
}

function validateIssue(value: unknown, changedFiles: Set<string>, index: number): ReviewIssue {
  if (!isRecord(value)) {
    throw new Error(`Review artifact finding ${index + 1} issue is invalid.`);
  }
  if (!ISSUE_SEVERITIES.has(value.severity as IssueSeverity)) {
    throw new Error(`Review artifact finding ${index + 1} has invalid severity.`);
  }
  if (!ISSUE_CATEGORIES.has(value.category as IssueCategory)) {
    throw new Error(`Review artifact finding ${index + 1} has invalid category.`);
  }

  const file = requireString(value.file, `finding ${index + 1} file`, 4096);
  if (
    file.startsWith('/') ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').includes('..') ||
    !changedFiles.has(file)
  ) {
    throw new Error(`Review artifact finding ${index + 1} does not target a changed file.`);
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || (value.line as number) <= 0)) {
    throw new Error(`Review artifact finding ${index + 1} has invalid line.`);
  }
  if (
    value.references !== undefined &&
    (!Array.isArray(value.references) ||
      value.references.length > 100 ||
      value.references.some(
        (reference) => typeof reference !== 'string' || reference.length > 2000
      ))
  ) {
    throw new Error(`Review artifact finding ${index + 1} has invalid references.`);
  }

  return {
    category: value.category as IssueCategory,
    severity: value.severity as IssueSeverity,
    title: requireString(value.title, `finding ${index + 1} title`, 1000),
    file,
    ...(value.line !== undefined ? { line: value.line as number } : {}),
    problem: requireString(value.problem, `finding ${index + 1} problem`),
    solution: requireString(value.solution, `finding ${index + 1} solution`),
    ...(value.references !== undefined ? { references: value.references as string[] } : {}),
    agent: requireString(value.agent, `finding ${index + 1} agent`, 1000),
  };
}

function validateReviewUsage(value: unknown): ReviewUsageSummary | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value.total) || !Array.isArray(value.agents)) {
    throw new Error('Review artifact usage is invalid.');
  }
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost']) {
    requireNonNegativeNumber(value.total[field], `usage.total.${field}`);
  }
  if (value.agents.length > 100) {
    throw new Error('Review artifact usage has too many agents.');
  }
  for (const [index, agent] of value.agents.entries()) {
    if (!isRecord(agent) || !isRecord(agent.usage)) {
      throw new Error(`Review artifact usage agent ${index + 1} is invalid.`);
    }
    requireString(agent.agentType, `usage agent ${index + 1} type`, 1000);
    requireNonNegativeNumber(agent.turns, `usage agent ${index + 1} turns`);
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost']) {
      requireNonNegativeNumber(agent.usage[field], `usage agent ${index + 1}.${field}`);
    }
  }
  return value as unknown as ReviewUsageSummary;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Review artifact ${field} contains unsupported fields.`);
  }
}

function validateStringArray(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > metricKeys.length ||
      value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 2000))
  ) {
    throw new Error(`Review artifact ${field} is invalid.`);
  }
}

function validateJevEvaluation(value: unknown): JevEvaluation {
  if (!isRecord(value)) {
    throw new Error('Review artifact Jev evaluation is invalid.');
  }
  assertOnlyKeys(
    value,
    ['model', 'metrics', 'priorities', 'usage', 'improvements', 'regressions', 'comparison'],
    'Jev evaluation'
  );
  requireString(value.model, 'evaluations.jev.evaluation.model', 200);
  if (!isRecord(value.metrics)) {
    throw new Error('Review artifact Jev metrics are invalid.');
  }
  const metrics = value.metrics;
  const metricKeySet = new Set<string>(metricKeys);
  if (
    Object.keys(metrics).length !== metricKeys.length ||
    Object.keys(metrics).some((key) => !metricKeySet.has(key))
  ) {
    throw new Error('Review artifact Jev metrics must contain exactly the supported metrics.');
  }
  for (const key of metricKeys) {
    const metric = metrics[key];
    if (!isRecord(metric) || typeof metric.applicable !== 'boolean') {
      throw new Error(`Review artifact Jev metric ${key} is invalid.`);
    }
    if (!metric.applicable) {
      assertOnlyKeys(metric, ['applicable'], `Jev metric ${key}`);
      continue;
    }
    assertOnlyKeys(
      metric,
      ['applicable', 'score', 'confidence', 'summary', 'issues'],
      `Jev metric ${key}`
    );
    const score = requireNonNegativeNumber(metric.score, `evaluations.jev.metrics.${key}.score`);
    const confidence = requireNonNegativeNumber(
      metric.confidence,
      `evaluations.jev.metrics.${key}.confidence`
    );
    requireString(metric.summary, `evaluations.jev.metrics.${key}.summary`, 2000);
    if (score < 1 || score > 10 || confidence > 1) {
      throw new Error(`Review artifact Jev metric ${key} is out of range.`);
    }
    if (metric.issues !== undefined) {
      if (!Array.isArray(metric.issues) || metric.issues.length > 20) {
        throw new Error(`Review artifact Jev metric ${key} issues are invalid.`);
      }
      for (const [index, issue] of metric.issues.entries()) {
        if (!isRecord(issue)) {
          throw new Error(`Review artifact Jev metric ${key} issue ${index + 1} is invalid.`);
        }
        assertOnlyKeys(issue, ['severity', 'description', 'suggestion'], `Jev metric ${key} issue`);
        if (!JEV_PRIORITY_SEVERITIES.has(String(issue.severity))) {
          throw new Error(
            `Review artifact Jev metric ${key} issue ${index + 1} has invalid severity.`
          );
        }
        requireString(
          issue.description,
          `evaluations.jev.metrics.${key}.issues.${index + 1}.description`,
          2000
        );
        if (issue.suggestion !== undefined) {
          requireString(
            issue.suggestion,
            `evaluations.jev.metrics.${key}.issues.${index + 1}.suggestion`,
            2000
          );
        }
      }
    }
  }
  if (!Array.isArray(value.priorities) || value.priorities.length > 5) {
    throw new Error('Review artifact Jev priorities are invalid.');
  }
  const priorityMetrics = new Set<string>();
  for (const [index, priority] of value.priorities.entries()) {
    if (!isRecord(priority) || !metricKeys.includes(priority.metric as MetricKey)) {
      throw new Error(`Review artifact Jev priority ${index + 1} is invalid.`);
    }
    assertOnlyKeys(priority, ['metric', 'severity', 'reason'], `Jev priority ${index + 1}`);
    if (priorityMetrics.has(String(priority.metric))) {
      throw new Error(`Review artifact Jev priority ${index + 1} duplicates a metric.`);
    }
    priorityMetrics.add(String(priority.metric));
    if (!JEV_PRIORITY_SEVERITIES.has(String(priority.severity))) {
      throw new Error(`Review artifact Jev priority ${index + 1} has invalid severity.`);
    }
    requireString(priority.reason, `evaluations.jev.priorities.${index + 1}.reason`, 2000);
  }
  if (!isRecord(value.usage)) {
    throw new Error('Review artifact Jev usage is invalid.');
  }
  assertOnlyKeys(value.usage, ['inputTokens', 'outputTokens'], 'Jev usage');
  const inputTokens = requireNonNegativeNumber(
    value.usage.inputTokens,
    'evaluations.jev.usage.inputTokens'
  );
  const outputTokens = requireNonNegativeNumber(
    value.usage.outputTokens,
    'evaluations.jev.usage.outputTokens'
  );
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) {
    throw new Error('Review artifact Jev usage token counts must be integers.');
  }
  validateStringArray(value.improvements, 'Jev improvements');
  validateStringArray(value.regressions, 'Jev regressions');
  if (value.comparison !== undefined) {
    if (!Array.isArray(value.comparison) || value.comparison.length > metricKeys.length) {
      throw new Error('Review artifact Jev comparison is invalid.');
    }
    const comparisonMetrics = new Set<string>();
    for (const [index, entry] of value.comparison.entries()) {
      if (!isRecord(entry) || !metricKeys.includes(entry.metric as MetricKey)) {
        throw new Error(`Review artifact Jev comparison ${index + 1} is invalid.`);
      }
      assertOnlyKeys(
        entry,
        ['metric', 'previousScore', 'currentScore', 'delta', 'direction'],
        `Jev comparison ${index + 1}`
      );
      if (comparisonMetrics.has(String(entry.metric))) {
        throw new Error(`Review artifact Jev comparison ${index + 1} duplicates a metric.`);
      }
      comparisonMetrics.add(String(entry.metric));
      const previousScore = requireNonNegativeNumber(
        entry.previousScore,
        `evaluations.jev.comparison.${index + 1}.previousScore`
      );
      const currentScore = requireNonNegativeNumber(
        entry.currentScore,
        `evaluations.jev.comparison.${index + 1}.currentScore`
      );
      if (
        previousScore < 1 ||
        previousScore > 10 ||
        currentScore < 1 ||
        currentScore > 10 ||
        typeof entry.delta !== 'number' ||
        !Number.isFinite(entry.delta)
      ) {
        throw new Error(`Review artifact Jev comparison ${index + 1} is out of range.`);
      }
      const expectedDelta = Math.round((currentScore - previousScore) * 10) / 10;
      const expectedDirection =
        expectedDelta >= 0.75 ? 'improved' : expectedDelta <= -0.75 ? 'regressed' : 'unchanged';
      if (entry.delta !== expectedDelta || entry.direction !== expectedDirection) {
        throw new Error(`Review artifact Jev comparison ${index + 1} is inconsistent.`);
      }
    }
  }
  return value as unknown as JevEvaluation;
}

function validateEvaluations(value: unknown): ReviewResult['evaluations'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('Review artifact evaluations are invalid.');
  }
  assertOnlyKeys(value, ['jev'], 'evaluations');
  const jev = value.jev;
  if (jev === undefined) return {};
  if (!isRecord(jev) || (jev.status !== 'completed' && jev.status !== 'failed')) {
    throw new Error('Review artifact Jev evaluation status is invalid.');
  }
  if (jev.status === 'completed') {
    assertOnlyKeys(jev, ['status', 'evaluation'], 'completed Jev evaluation');
    return { jev: { status: 'completed', evaluation: validateJevEvaluation(jev.evaluation) } };
  }
  assertOnlyKeys(jev, ['status', 'error'], 'failed Jev evaluation');
  if (!isRecord(jev.error)) {
    throw new Error('Review artifact Jev failure is invalid.');
  }
  assertOnlyKeys(jev.error, ['code', 'message'], 'Jev failure');
  return {
    jev: {
      status: 'failed',
      error: {
        code: requireString(jev.error.code, 'evaluations.jev.error.code', 100),
        message: requireString(jev.error.message, 'evaluations.jev.error.message', 2000),
      },
    },
  };
}

export function reviewArtifactToReviewResult(
  value: unknown,
  target: ReviewArtifactPostingTarget
): ReviewResult {
  if (!isRecord(value)) {
    throw new Error('Review artifact envelope is invalid.');
  }
  if (value.schemaVersion !== 1 || value.kind !== 'review') {
    throw new Error('Review artifact envelope has an unsupported schema or kind.');
  }
  assertSafeArtifactId(value.id, 'read');
  requireTimestamp(value.createdAt, 'createdAt');
  requireTimestamp(value.updatedAt, 'updatedAt');
  if (!isRecord(value.scope)) {
    throw new Error('Review artifact scope is invalid.');
  }
  if (
    value.scope.platform !== target.platform ||
    value.scope.projectId !== target.projectId ||
    value.scope.changeKind !== target.changeKind ||
    String(value.scope.changeNumber) !== String(target.changeNumber)
  ) {
    throw new Error('Review artifact scope does not match the posting target.');
  }
  if (target.currentHeadSha !== target.expectedHeadSha) {
    throw new Error('Pull request head changed after the review started.');
  }
  if (!isRecord(value.payload)) {
    throw new Error('Review artifact payload is invalid.');
  }
  const payload = value.payload;
  if (payload.schemaVersion !== 1 || !REVIEW_ID_PATTERN.test(String(payload.reviewId))) {
    throw new Error('Review artifact payload has an unsupported schema or review id.');
  }
  requireTimestamp(payload.reviewedAt, 'reviewedAt');
  if (payload.reviewedSha !== target.expectedHeadSha) {
    throw new Error('Review artifact head does not match the expected pull request head.');
  }
  if (!Array.isArray(payload.findings) || payload.findings.length > MAX_FINDINGS) {
    throw new Error('Review artifact findings are invalid or exceed the allowed limit.');
  }

  const changedFiles = new Set(target.changedFiles);
  const findingIds = new Set<string>();
  const canonicalFingerprints = new Set<string>();
  const issues = payload.findings.map((finding, index) => {
    if (!isRecord(finding)) {
      throw new Error(`Review artifact finding ${index + 1} is invalid.`);
    }
    const id = requireString(finding.id, `finding ${index + 1} id`, 100);
    if (!/^F[0-9]+$/.test(id) || findingIds.has(id)) {
      throw new Error(`Review artifact finding ${index + 1} has invalid or duplicate id.`);
    }
    findingIds.add(id);
    if (!FINDING_STATES.has(finding.state as ReviewFindingState)) {
      throw new Error(`Review artifact finding ${index + 1} has invalid state.`);
    }
    if (!FINDING_DISPOSITIONS.has(finding.disposition as ReviewFindingDisposition)) {
      throw new Error(`Review artifact finding ${index + 1} has invalid disposition.`);
    }
    if (!FINDING_SOURCES.has(finding.source as ReviewFindingSource)) {
      throw new Error(`Review artifact finding ${index + 1} has invalid source.`);
    }
    requireTimestamp(finding.createdAt, `finding ${index + 1} createdAt`);
    requireTimestamp(finding.updatedAt, `finding ${index + 1} updatedAt`);

    const issue = validateIssue(finding.issue, changedFiles, index);
    const fingerprint = requireString(
      finding.fingerprint,
      `finding ${index + 1} fingerprint`,
      5000
    );
    const canonicalFingerprint = createIssueFingerprint(issue);
    const validFingerprint =
      fingerprint === canonicalFingerprint || fingerprint === createLegacyIssueFingerprint(issue);
    if (!validFingerprint || canonicalFingerprints.has(canonicalFingerprint)) {
      throw new Error(
        `Review artifact finding ${index + 1} has an invalid or duplicate fingerprint.`
      );
    }
    canonicalFingerprints.add(canonicalFingerprint);
    if (finding.stableSignature !== undefined) {
      const stableSignature = requireString(
        finding.stableSignature,
        `finding ${index + 1} stable signature`,
        5000
      );
      if (stableSignature !== createIssueStableSignature(issue)) {
        throw new Error(`Review artifact finding ${index + 1} has an invalid stable signature.`);
      }
    }
    return issue;
  });

  if (!isRecord(payload.summary)) {
    throw new Error('Review artifact summary is invalid.');
  }
  const summary = payload.summary;
  const filesReviewed = requireNonNegativeNumber(summary.filesReviewed, 'summary.filesReviewed');
  if (!Number.isInteger(filesReviewed) || filesReviewed > changedFiles.size) {
    throw new Error('Review artifact summary has invalid filesReviewed.');
  }
  if (!isRecord(summary.bySeverity) || !isRecord(summary.byCategory)) {
    throw new Error('Review artifact summary counts are invalid.');
  }
  const bySeverity = summary.bySeverity;
  const byCategory = summary.byCategory;
  const expectedSummary = calculateSummary(filesReviewed, issues);
  if (
    summary.issuesFound !== expectedSummary.issuesFound ||
    [...ISSUE_SEVERITIES].some(
      (severity) => bySeverity[severity] !== expectedSummary.bySeverity[severity]
    ) ||
    [...ISSUE_CATEGORIES].some(
      (category) => byCategory[category] !== expectedSummary.byCategory[category]
    )
  ) {
    throw new Error('Review artifact summary does not match its findings.');
  }

  if (
    payload.mode !== undefined &&
    payload.mode !== 'agent' &&
    payload.mode !== 'jev' &&
    payload.mode !== 'parallel' &&
    payload.mode !== 'combined'
  ) {
    throw new Error('Review artifact mode is invalid.');
  }

  return {
    issues,
    summary: expectedSummary,
    filesReviewed,
    usage: validateReviewUsage(payload.usage),
    ...(payload.mode ? { mode: payload.mode } : {}),
    ...(payload.evaluations !== undefined
      ? { evaluations: validateEvaluations(payload.evaluations) }
      : {}),
  };
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

  if (!hasIds && !hasFingerprints && !hasSeverity) {
    return true;
  }

  const fingerprintAliases = new Set([
    finding.fingerprint,
    createIssueFingerprint(finding.issue),
    createLegacyIssueFingerprint(finding.issue),
  ]);
  return (
    (hasIds && (selector.ids?.includes(finding.id) ?? false)) ||
    (hasFingerprints &&
      (selector.fingerprints?.some((value) => fingerprintAliases.has(value)) ?? false)) ||
    (hasSeverity && finding.issue.severity === selector.severity)
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
      stableSignature: createIssueStableSignature(issue),
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
    ...(review.mode ? { mode: review.mode } : {}),
    ...(review.evaluations ? { evaluations: review.evaluations } : {}),
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
    !!candidate.summary &&
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
    still_open: 0,
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
    stableSignature: createIssueStableSignature(issue),
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
