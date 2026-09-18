import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFile, readFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { formatReviewJson, writeReviewJson, printReviewJson } from './json-output.js';
import type { ReviewIssue, ReviewSummary } from './comment-formatter.js';
import type { JevEvaluation } from './jev/types.js';

// ── Fixtures ─────────────────────────────────────────────────────

const SUMMARY: ReviewSummary = {
  filesReviewed: 5,
  issuesFound: 2,
  bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0 },
  byCategory: { SECURITY: 1, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
};

const ISSUES: ReviewIssue[] = [
  {
    category: 'SECURITY',
    severity: 'HIGH',
    title: 'SQL Injection',
    file: 'src/db.ts',
    line: 42,
    problem: 'Unsanitized query',
    solution: 'Use parameterized queries',
    agent: 'security',
  },
  {
    category: 'QUALITY',
    severity: 'MEDIUM',
    title: 'Missing null check',
    file: 'src/utils.ts',
    problem: 'Possible null dereference',
    solution: 'Add null guard',
    agent: 'quality',
  },
];

const JEV_EVALUATION = {
  model: 'jev-latest',
  metrics: {
    correctness: { applicable: true, score: 7.5, confidence: 0.8, summary: 'Correctness signal.' },
  },
  priorities: [{ metric: 'correctness', severity: 'low', reason: 'Boundary checks.' }],
  usage: { inputTokens: 10, outputTokens: 5 },
} as unknown as JevEvaluation;

// ── formatReviewJson ─────────────────────────────────────────────

describe('formatReviewJson', () => {
  it('creates output with timestamp, summary, and issues', () => {
    const result = formatReviewJson(SUMMARY, ISSUES);

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.summary).toEqual(SUMMARY);
    expect(result.issues).toEqual(ISSUES);
    expect(result.usage).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it('includes metadata when provided', () => {
    const metadata = {
      source: 'MR !42',
      project: 'org/repo',
      branch: { source: 'feature', target: 'main' },
    };
    const result = formatReviewJson(SUMMARY, ISSUES, metadata);

    expect(result.metadata).toEqual(metadata);
  });

  it('includes usage when provided', () => {
    const usage = {
      total: {
        input: 1000,
        output: 200,
        cacheRead: 50,
        cacheWrite: 10,
        totalTokens: 1260,
        cost: 0.005,
      },
      agents: [],
    };
    const result = formatReviewJson(SUMMARY, ISSUES, undefined, usage);

    expect(result.usage).toEqual(usage);
  });

  it('omits mode and evaluations by default but includes them when Jev participates', () => {
    const legacy = formatReviewJson(SUMMARY, ISSUES);
    expect(legacy).not.toHaveProperty('mode');
    expect(legacy).not.toHaveProperty('evaluations');

    const withJev = formatReviewJson(SUMMARY, [], undefined, undefined, {
      mode: 'jev',
      evaluations: { jev: { status: 'completed', evaluation: JEV_EVALUATION } },
    });

    expect(withJev).toMatchObject({
      mode: 'jev',
      issues: [],
      evaluations: { jev: { status: 'completed', evaluation: JEV_EVALUATION } },
    });
  });

  it('handles empty issues array', () => {
    const emptySummary: ReviewSummary = {
      filesReviewed: 3,
      issuesFound: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      byCategory: { SECURITY: 0, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
    };
    const result = formatReviewJson(emptySummary, []);

    expect(result.issues).toEqual([]);
    expect(result.summary.issuesFound).toBe(0);
  });
});

// ── writeReviewJson ──────────────────────────────────────────────

describe('writeReviewJson', () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('writes formatted JSON to the specified path', async () => {
    testDir = join(
      tmpdir(),
      `drs-json-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    const output = formatReviewJson(SUMMARY, ISSUES);
    const outputPath = 'review.json';

    await writeReviewJson(output, outputPath, testDir);

    const content = await readFile(join(testDir, outputPath), 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.summary.filesReviewed).toBe(5);
    expect(parsed.issues).toHaveLength(2);
    // Verify 2-space indent
    expect(content).toContain('  "timestamp"');
  });

  it('overwrites existing file', async () => {
    testDir = join(
      tmpdir(),
      `drs-json-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    const outputPath = 'review.json';
    await writeFile(join(testDir, outputPath), '{"old": true}');

    const output = formatReviewJson(SUMMARY, ISSUES);
    await writeReviewJson(output, outputPath, testDir);

    const content = await readFile(join(testDir, outputPath), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.old).toBeUndefined();
    expect(parsed.issues).toHaveLength(2);
  });

  it('refuses to write outside the working directory', async () => {
    testDir = join(
      tmpdir(),
      `drs-json-output-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    const output = formatReviewJson(SUMMARY, ISSUES);

    await expect(writeReviewJson(output, '../outside.json', testDir)).rejects.toThrow(
      'Refusing to write outside working directory'
    );
  });
});

// ── printReviewJson ──────────────────────────────────────────────

describe('printReviewJson', () => {
  it('prints formatted JSON to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const output = formatReviewJson(SUMMARY, ISSUES);
    printReviewJson(output);

    expect(spy).toHaveBeenCalledTimes(1);
    const printed = String(spy.mock.calls[0][0]);
    const parsed = JSON.parse(printed);
    expect(parsed.issues).toHaveLength(2);

    spy.mockRestore();
  });

  it('output is valid JSON with 2-space indent', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printReviewJson(formatReviewJson(SUMMARY, []));

    const printed = String(spy.mock.calls[0][0]);
    expect(printed).toContain('  "timestamp"');
    expect(() => JSON.parse(printed)).not.toThrow();

    spy.mockRestore();
  });
});
