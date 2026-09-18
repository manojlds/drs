import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { describeOutputSchema, reviewOutputSchema } from './json-output-schema.js';
import { metricKeys } from './jev/types.js';

const ajv = new Ajv({ allErrors: true });
const validateDescribe = ajv.compile(describeOutputSchema);
const validateReview = ajv.compile(reviewOutputSchema);

describe('json-output schemas', () => {
  it('validates describe output schema', () => {
    const payload = {
      type: 'feature',
      title: 'Add describe output validation tooling',
      summary: ['Adds schema validation for describe output'],
      walkthrough: [
        {
          file: 'src/lib/describe-core.ts',
          changeType: 'modified',
          semanticLabel: 'feature',
          title: 'Require tool-based output',
          changes: ['Adds write_json_output requirement'],
          significance: 'major',
        },
      ],
      labels: ['feature', 'describe'],
      recommendations: ['Add unit tests for schema validation'],
    };

    const isValid = validateDescribe(payload);
    expect(isValid).toBe(true);
    expect(validateDescribe.errors).toBeNull();
  });

  it('rejects describe output with invalid type', () => {
    const payload = {
      type: 'invalid',
      title: 'Bad type',
      summary: ['Invalid type'],
    };

    const isValid = validateDescribe(payload);
    expect(isValid).toBe(false);
  });

  it('validates review output schema', () => {
    const payload = {
      timestamp: new Date().toISOString(),
      summary: {
        filesReviewed: 3,
        issuesFound: 2,
        bySeverity: {
          CRITICAL: 0,
          HIGH: 1,
          MEDIUM: 1,
          LOW: 0,
        },
        byCategory: {
          SECURITY: 1,
          QUALITY: 1,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 0,
        },
      },
      issues: [
        {
          category: 'SECURITY',
          severity: 'HIGH',
          title: 'Avoid plaintext secrets',
          file: 'src/config.ts',
          problem: 'Secret is stored in code.',
          solution: 'Use environment variables.',
          agent: 'review/security',
        },
      ],
      metadata: {
        source: 'PR #123',
        project: 'org/repo',
        branch: {
          source: 'feature',
          target: 'main',
        },
      },
    };

    const isValid = validateReview(payload);
    expect(isValid).toBe(true);
    expect(validateReview.errors).toBeNull();
  });

  it('validates review output with a Jev scorecard and no findings', () => {
    const payload = {
      timestamp: new Date().toISOString(),
      mode: 'jev',
      summary: {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      issues: [],
      evaluations: {
        jev: {
          status: 'completed',
          evaluation: {
            model: 'jev-latest',
            metrics: Object.fromEntries(
              metricKeys.map((metric) => [
                metric,
                metric === 'security'
                  ? { applicable: false }
                  : {
                      applicable: true,
                      score: 8,
                      confidence: 0.9,
                      summary: `${metric} is strong.`,
                    },
              ])
            ),
            priorities: [{ metric: 'correctness', severity: 'low', reason: 'Boundary behavior.' }],
            usage: { inputTokens: 100, outputTokens: 20 },
          },
        },
      },
    };

    expect(validateReview(payload)).toBe(true);
    expect(validateReview.errors).toBeNull();
  });

  it('rejects incomplete, extra, and internally inconsistent Jev metrics', () => {
    const validMetrics = Object.fromEntries(
      metricKeys.map((metric) => [
        metric,
        { applicable: true, score: 8, confidence: 0.9, summary: `${metric} is strong.` },
      ])
    );
    const base = {
      timestamp: new Date().toISOString(),
      mode: 'jev',
      summary: {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      issues: [],
      evaluations: {
        jev: {
          status: 'completed',
          evaluation: {
            model: 'jev-latest',
            metrics: validMetrics,
            priorities: [],
            usage: { inputTokens: 100, outputTokens: 20 },
          },
        },
      },
    };

    const missing = structuredClone(base);
    delete missing.evaluations.jev.evaluation.metrics.correctness;
    expect(validateReview(missing)).toBe(false);

    const extra = structuredClone(base);
    extra.evaluations.jev.evaluation.metrics.unknownMetric = {
      applicable: true,
      score: 8,
      confidence: 0.9,
      summary: 'Unknown.',
    };
    expect(validateReview(extra)).toBe(false);

    const inconsistent = structuredClone(base);
    inconsistent.evaluations.jev.evaluation.metrics.security = {
      applicable: false,
      score: 8,
      confidence: 0.9,
      summary: 'Must be absent.',
    };
    expect(validateReview(inconsistent)).toBe(false);

    const outOfRange = structuredClone(base);
    outOfRange.evaluations.jev.evaluation.metrics.correctness.score = 0;
    expect(validateReview(outOfRange)).toBe(false);
  });

  it('rejects review output with missing summary', () => {
    const payload = {
      timestamp: new Date().toISOString(),
      issues: [],
    };

    const isValid = validateReview(payload);
    expect(isValid).toBe(false);
  });
});
