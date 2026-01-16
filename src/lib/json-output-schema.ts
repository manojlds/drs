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

export const reviewOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['timestamp', 'summary', 'issues'],
  properties: {
    timestamp: { type: 'string', minLength: 1 },
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
  },
} as const;
