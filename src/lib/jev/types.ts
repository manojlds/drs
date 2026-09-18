export const metricKeys = [
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
] as const;

export type MetricKey = (typeof metricKeys)[number];
export type JevPrioritySeverity = 'low' | 'medium' | 'high';

export interface JevMetricIssue {
  severity: JevPrioritySeverity;
  description: string;
  suggestion?: string;
}

export type JevMetricEvaluation =
  | {
      applicable: false;
    }
  | {
      applicable: true;
      score: number;
      confidence: number;
      summary: string;
      issues?: JevMetricIssue[];
    };

export interface JevPriority {
  metric: MetricKey;
  severity: JevPrioritySeverity;
  reason: string;
}

export interface JevComparisonEntry {
  metric: MetricKey;
  previousScore: number;
  currentScore: number;
  delta: number;
  direction: 'improved' | 'regressed' | 'unchanged';
}

export interface JevEvaluation {
  model: string;
  metrics: Record<MetricKey, JevMetricEvaluation>;
  priorities: JevPriority[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  improvements?: string[];
  regressions?: string[];
  comparison?: JevComparisonEntry[];
}
