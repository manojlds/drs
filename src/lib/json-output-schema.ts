import { metricKeys } from './jev/types.js';

export const describeOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'summary'],
  properties: {
    type: {
      type: 'string',
      enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore', 'perf'],
    },
    title: { type: 'string', minLength: 1 },
    summary: { type: 'array', items: { type: 'string' }, minItems: 1 },
    walkthrough: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'changeType', 'semanticLabel', 'title'],
        properties: {
          file: { type: 'string', minLength: 1 },
          changeType: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed'] },
          semanticLabel: {
            type: 'string',
            enum: [
              'feature',
              'bugfix',
              'refactor',
              'test',
              'docs',
              'infrastructure',
              'configuration',
            ],
          },
          title: { type: 'string', minLength: 1 },
          changes: { type: 'array', items: { type: 'string' } },
          significance: { type: 'string', enum: ['major', 'minor'] },
        },
      },
    },
    labels: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
} as const;

const jevMetricSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['applicable'],
      properties: { applicable: { const: false } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['applicable', 'score', 'confidence', 'summary'],
      properties: {
        applicable: { const: true },
        score: { type: 'number', minimum: 1, maximum: 10 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        summary: { type: 'string', minLength: 1 },
        issues: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'description'],
            properties: {
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              description: { type: 'string', minLength: 1 },
              suggestion: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
  ],
} as const;

const jevMetricProperties = Object.fromEntries(
  metricKeys.map((metric) => [metric, jevMetricSchema])
);

const jevEvaluationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'metrics', 'priorities', 'usage'],
  properties: {
    model: { type: 'string', minLength: 1 },
    metrics: {
      type: 'object',
      additionalProperties: false,
      required: metricKeys,
      properties: jevMetricProperties,
    },
    priorities: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['metric', 'severity', 'reason'],
        properties: {
          metric: { type: 'string', enum: metricKeys },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['inputTokens', 'outputTokens'],
      properties: {
        inputTokens: { type: 'integer', minimum: 0 },
        outputTokens: { type: 'integer', minimum: 0 },
      },
    },
    improvements: { type: 'array', items: { type: 'string' } },
    regressions: { type: 'array', items: { type: 'string' } },
    comparison: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['metric', 'previousScore', 'currentScore', 'delta', 'direction'],
        properties: {
          metric: { type: 'string', enum: metricKeys },
          previousScore: { type: 'number', minimum: 1, maximum: 10 },
          currentScore: { type: 'number', minimum: 1, maximum: 10 },
          delta: { type: 'number', minimum: -9, maximum: 9 },
          direction: { type: 'string', enum: ['improved', 'regressed', 'unchanged'] },
        },
      },
    },
  },
} as const;

export const reviewOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['timestamp', 'summary', 'issues'],
  properties: {
    timestamp: { type: 'string', minLength: 1 },
    mode: { type: 'string', enum: ['agent', 'jev', 'combined'] },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['filesReviewed', 'issuesFound', 'bySeverity', 'byCategory'],
      properties: {
        filesReviewed: { type: 'number' },
        issuesFound: { type: 'number' },
        bySeverity: {
          type: 'object',
          additionalProperties: false,
          required: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
          properties: {
            CRITICAL: { type: 'number' },
            HIGH: { type: 'number' },
            MEDIUM: { type: 'number' },
            LOW: { type: 'number' },
          },
        },
        byCategory: {
          type: 'object',
          additionalProperties: false,
          required: ['SECURITY', 'QUALITY', 'STYLE', 'PERFORMANCE', 'DOCUMENTATION'],
          properties: {
            SECURITY: { type: 'number' },
            QUALITY: { type: 'number' },
            STYLE: { type: 'number' },
            PERFORMANCE: { type: 'number' },
            DOCUMENTATION: { type: 'number' },
          },
        },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'severity', 'title', 'file', 'problem', 'solution', 'agent'],
        properties: {
          category: {
            type: 'string',
            enum: ['SECURITY', 'QUALITY', 'STYLE', 'PERFORMANCE', 'DOCUMENTATION'],
          },
          severity: {
            type: 'string',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
          },
          title: { type: 'string', minLength: 1 },
          file: { type: 'string', minLength: 1 },
          line: { type: 'number' },
          problem: { type: 'string', minLength: 1 },
          solution: { type: 'string', minLength: 1 },
          references: { type: 'array', items: { type: 'string' } },
          agent: { type: 'string', minLength: 1 },
        },
      },
    },
    evaluations: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jev: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'evaluation'],
              properties: {
                status: { type: 'string', enum: ['completed'] },
                evaluation: jevEvaluationSchema,
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'error'],
              properties: {
                status: { type: 'string', enum: ['failed'] },
                error: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['code', 'message'],
                  properties: {
                    code: { type: 'string', minLength: 1 },
                    message: { type: 'string', minLength: 1 },
                  },
                },
              },
            },
          ],
        },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string' },
        project: { type: 'string' },
        branch: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
          },
        },
      },
    },
    verification: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'disposition'],
            properties: {
              id: { type: 'string', minLength: 1 },
              disposition: {
                type: 'string',
                enum: ['resolved', 'still_open', 'partial'],
              },
              rationale: { type: 'string' },
              issue: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['category', 'severity', 'title', 'file', 'problem', 'solution', 'agent'],
                properties: {
                  category: {
                    type: 'string',
                    enum: ['SECURITY', 'QUALITY', 'STYLE', 'PERFORMANCE', 'DOCUMENTATION'],
                  },
                  severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
                  title: { type: 'string', minLength: 1 },
                  file: { type: 'string', minLength: 1 },
                  line: { type: 'number' },
                  problem: { type: 'string', minLength: 1 },
                  solution: { type: 'string', minLength: 1 },
                  references: { type: 'array', items: { type: 'string' } },
                  agent: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
