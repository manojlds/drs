import { metricDefinitions, type MetricDefinition } from './metrics.js';
import { questionId } from './questions.js';
import type { JevResponse } from './schema.js';
import type { JevEvaluation, JevMetricEvaluation, MetricKey } from './types.js';

const MEANINGFUL_DELTA = 0.75;

export class JevEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevEvaluationError';
  }
}

export function toJevEvaluation(response: JevResponse, previous?: JevEvaluation): JevEvaluation {
  const metrics = {} as JevEvaluation['metrics'];

  for (const definition of metricDefinitions) {
    metrics[definition.key] = transformMetric(response, definition);
  }

  const priorities = metricDefinitions
    .map((definition) => ({ definition, evaluation: metrics[definition.key] }))
    .filter(
      (
        entry
      ): entry is {
        definition: MetricDefinition;
        evaluation: JevMetricEvaluation & { applicable: true; score: number };
      } => entry.evaluation.applicable && entry.evaluation.score < 8
    )
    .sort((left, right) => {
      const leftRank = left.evaluation.score - left.definition.priorityWeight * 0.35;
      const rightRank = right.evaluation.score - right.definition.priorityWeight * 0.35;
      return leftRank - rightRank || left.definition.key.localeCompare(right.definition.key);
    })
    .slice(0, 5)
    .map(({ definition, evaluation }) => ({
      metric: definition.key,
      severity: severityFor(evaluation.score),
      reason:
        evaluation.issues?.[0]?.description ??
        evaluation.summary ??
        `${definition.label} remains weak.`,
    }));

  const result: JevEvaluation = {
    model: response.model,
    metrics,
    priorities,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };

  if (previous?.model === result.model) addComparison(result, previous);
  return result;
}

function transformMetric(response: JevResponse, definition: MetricDefinition): JevMetricEvaluation {
  const applicability = response.answers[questionId(definition.key, 'applicable')];
  const scoreAnswer = response.answers[questionId(definition.key, 'score')];
  const weakness = response.answers[questionId(definition.key, 'weakness')];

  if (applicability?.type !== 'noul') {
    throw new JevEvaluationError(`Jev omitted the applicability decision for ${definition.key}.`);
  }
  if (scoreAnswer?.type !== 'score') {
    throw new JevEvaluationError(`Jev omitted the score for ${definition.key}.`);
  }
  if (weakness?.type !== 'choice') {
    throw new JevEvaluationError(`Jev omitted the weakness decision for ${definition.key}.`);
  }

  const selectedWeakness = definition.weaknesses[weakness.choice];
  if (selectedWeakness === undefined) {
    throw new JevEvaluationError(
      `Jev selected an unknown weakness category for ${definition.key}.`
    );
  }

  const applicable = applicability.noul >= 0.5;
  if (!applicable) return { applicable: false };

  const score = round(scoreAnswer.score + 1, 1);
  const applicabilityCertainty = 0.5 + Math.abs(applicability.noul - 0.5);
  const confidence = round(Math.min(scoreAnswer.confidence, applicabilityCertainty), 2);
  const summary = `${definition.label} is ${scoreBand(score)} based on the supplied change context.`;
  const hasIssue = score < 8 && weakness.choice !== 'no_material_issue';

  const evaluation: JevMetricEvaluation = {
    applicable: true,
    score,
    confidence,
    summary,
  };

  if (hasIssue) {
    evaluation.issues = [
      {
        severity: severityFor(score),
        description: selectedWeakness,
        suggestion: definition.suggestion,
      },
    ];
  }

  return evaluation;
}

function addComparison(current: JevEvaluation, previous: JevEvaluation): void {
  const comparison: NonNullable<JevEvaluation['comparison']> = [];
  const improvements: string[] = [];
  const regressions: string[] = [];

  for (const definition of metricDefinitions) {
    const before = previous.metrics[definition.key];
    const after = current.metrics[definition.key];
    if (!before.applicable || !after.applicable) continue;

    const delta = round(after.score - before.score, 1);
    const direction =
      delta >= MEANINGFUL_DELTA
        ? 'improved'
        : delta <= -MEANINGFUL_DELTA
          ? 'regressed'
          : 'unchanged';

    comparison.push({
      metric: definition.key,
      previousScore: before.score,
      currentScore: after.score,
      delta,
      direction,
    });

    if (direction === 'improved') {
      improvements.push(`${definition.label}: ${before.score} -> ${after.score}`);
    } else if (direction === 'regressed') {
      regressions.push(`${definition.label}: ${before.score} -> ${after.score}`);
    }
  }

  current.comparison = comparison;
  current.improvements = improvements;
  current.regressions = regressions;
}

function scoreBand(score: number): string {
  if (score <= 3) return 'seriously weak';
  if (score <= 5) return 'meaningfully weak';
  if (score <= 7) return 'acceptable but improvable';
  if (score < 10) return 'strong';
  return 'exceptional';
}

function severityFor(score: number): 'low' | 'medium' | 'high' {
  if (score <= 3) return 'high';
  if (score <= 5) return 'medium';
  return 'low';
}

export function getMetricDefinition(key: MetricKey): MetricDefinition {
  const definition = metricDefinitions.find((entry) => entry.key === key);
  if (definition === undefined) throw new Error(`Unknown metric: ${key}`);
  return definition;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
