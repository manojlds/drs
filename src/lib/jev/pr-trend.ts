import { metricKeys, type JevEvaluation, type MetricKey } from './types.js';

const BASELINE_MARKER = 'drs-jev-pr-baseline-v1';
const MAX_ENCODED_BASELINE_LENGTH = 20_000;
const MEANINGFUL_DELTA = 0.75;

type BaselineMetric = { applicable: false } | { applicable: true; score: number };

export interface JevPrBaseline {
  version: 1;
  model: string;
  headSha?: string;
  metrics: Record<MetricKey, BaselineMetric>;
}

export type JevPrTrendDirection =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'newly-applicable'
  | 'no-longer-applicable';

export interface JevPrTrendEntry {
  metric: MetricKey;
  baselineScore?: number;
  currentScore?: number;
  delta?: number;
  direction: JevPrTrendDirection;
}

export interface JevPrTrend {
  comparable: boolean;
  baselineCaptured: boolean;
  reason?: 'model-changed';
  baselineHeadSha?: string;
  currentHeadSha?: string;
  baselineModel: string;
  currentModel: string;
  entries: JevPrTrendEntry[];
}

export function createJevPrBaseline(evaluation: JevEvaluation, headSha?: string): JevPrBaseline {
  return {
    version: 1,
    model: evaluation.model,
    ...(headSha ? { headSha } : {}),
    metrics: Object.fromEntries(
      metricKeys.map((metric) => {
        const value = evaluation.metrics[metric];
        return [
          metric,
          value.applicable ? { applicable: true, score: value.score } : { applicable: false },
        ];
      })
    ) as JevPrBaseline['metrics'],
  };
}

export function encodeJevPrBaselineMarker(baseline: JevPrBaseline): string {
  const encoded = Buffer.from(JSON.stringify(baseline), 'utf8').toString('base64url');
  if (encoded.length > MAX_ENCODED_BASELINE_LENGTH) {
    throw new Error('Jev PR baseline exceeds the safe comment marker length.');
  }
  return `<!-- ${BASELINE_MARKER}: ${encoded} -->`;
}

export function extractJevPrBaseline(body: string): JevPrBaseline | undefined {
  const match = new RegExp(
    `<!-- ${BASELINE_MARKER}: ([A-Za-z0-9_-]{1,${MAX_ENCODED_BASELINE_LENGTH}}) -->\\s*$`
  ).exec(body);
  if (!match) return undefined;

  try {
    const decoded = Buffer.from(match[1], 'base64url');
    if (decoded.toString('base64url') !== match[1]) return undefined;
    return parseBaseline(JSON.parse(decoded.toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
}

export function createJevPrTrend(
  baseline: JevPrBaseline,
  current: JevEvaluation,
  currentHeadSha?: string,
  baselineCaptured = false
): JevPrTrend {
  const common = {
    baselineCaptured,
    baselineHeadSha: baseline.headSha,
    currentHeadSha,
    baselineModel: baseline.model,
    currentModel: current.model,
  };
  if (baseline.model !== current.model) {
    return { ...common, comparable: false, reason: 'model-changed', entries: [] };
  }

  const entries = metricKeys.flatMap((metric): JevPrTrendEntry[] => {
    const before = baseline.metrics[metric];
    const after = current.metrics[metric];
    if (!before.applicable) {
      return after.applicable
        ? [{ metric, currentScore: after.score, direction: 'newly-applicable' }]
        : [];
    }
    if (!after.applicable) {
      return [{ metric, baselineScore: before.score, direction: 'no-longer-applicable' }];
    }

    const delta = round(after.score - before.score);
    return [
      {
        metric,
        baselineScore: before.score,
        currentScore: after.score,
        delta,
        direction:
          delta >= MEANINGFUL_DELTA
            ? 'improved'
            : delta <= -MEANINGFUL_DELTA
              ? 'regressed'
              : 'unchanged',
      },
    ];
  });

  return { ...common, comparable: true, entries };
}

function parseBaseline(value: unknown): JevPrBaseline {
  if (!isRecord(value)) throw new Error('Invalid Jev PR baseline.');
  assertOnlyKeys(value, ['version', 'model', 'headSha', 'metrics']);
  if (
    value.version !== 1 ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.length > 200
  ) {
    throw new Error('Invalid Jev PR baseline identity.');
  }
  if (
    value.headSha !== undefined &&
    (typeof value.headSha !== 'string' || !value.headSha || value.headSha.length > 200)
  ) {
    throw new Error('Invalid Jev PR baseline head.');
  }
  if (!isRecord(value.metrics)) throw new Error('Invalid Jev PR baseline metrics.');
  if (
    Object.keys(value.metrics).length !== metricKeys.length ||
    Object.keys(value.metrics).some((key) => !metricKeys.includes(key as MetricKey))
  ) {
    throw new Error('Invalid Jev PR baseline metric set.');
  }

  const metrics = {} as JevPrBaseline['metrics'];
  for (const metric of metricKeys) {
    const entry = value.metrics[metric];
    if (!isRecord(entry) || typeof entry.applicable !== 'boolean') {
      throw new Error('Invalid Jev PR baseline metric.');
    }
    if (!entry.applicable) {
      assertOnlyKeys(entry, ['applicable']);
      metrics[metric] = { applicable: false };
      continue;
    }
    assertOnlyKeys(entry, ['applicable', 'score']);
    if (!isBoundedNumber(entry.score, 1, 10)) {
      throw new Error('Invalid Jev PR baseline metric range.');
    }
    metrics[metric] = {
      applicable: true,
      score: entry.score,
    };
  }

  return {
    version: 1,
    model: value.model,
    ...(value.headSha ? { headSha: value.headSha } : {}),
    metrics,
  };
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error('Invalid Jev PR baseline fields.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
