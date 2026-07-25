import { rm, readFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import simpleGit from 'simple-git';
import { getUnifiedModelOverride } from './config.js';
import { loadAgents } from '../runtime/agent-loader.js';
import {
  loadBenchmarkSuite,
  loadBenchmarkCase,
  adjudicationCandidates,
  runReviewBenchmark,
} from './review-benchmark.js';

const root = process.cwd();
const output = 'out/review-benchmark-test';
afterEach(() => rm(join(root, output), { recursive: true, force: true }));
describe('review benchmark fixtures', () => {
  it('loads the audited suite and rejects traversal', async () => {
    const loaded = await loadBenchmarkSuite(root, 'development-v1');
    expect(loaded.suite.cases).toHaveLength(10);
    await expect(loadBenchmarkSuite(root, '../package.json')).rejects.toThrow(
      /safe lowercase slug/
    );
  });
  it('validates positive and negative cases', async () => {
    expect((await loadBenchmarkCase(root, 'inverted-condition')).expected).toHaveLength(1);
    expect((await loadBenchmarkCase(root, 'safe-refactor')).expected).toEqual([]);
  });
  it('marks misses as ineffective without inventing semantic matches', () => {
    const expected = [
      { id: 'X', description: 'x', severity: 'HIGH', category: 'QUALITY', file: 'x.ts' },
    ];
    expect(adjudicationCandidates(expected, [], true)).toEqual([
      {
        expectedId: 'X',
        actualIndex: null,
        status: 'ineffective-review',
        semanticMatch: 'pending',
      },
    ]);
  });

  it('runs provider-free with isolated config, opaque workspace, agent pinning and model checks', async () => {
    const seen: string[] = [];
    const result = await runReviewBenchmark(
      {
        projectRoot: root,
        suite: 'development-v1',
        models: ['test/one', 'test/two'],
        profile: 'isolated',
        repeat: 1,
        output,
        live: true,
      },
      {
        onWorkspaceReady: async (workspace, config, source) => {
          expect(workspace).not.toMatch(/inverted-condition|safe-refactor/);
          expect(source.name).toBe('Calibration case');
          expect(source.thinkingLevel).toBe('medium');
          expect(config.review.describe?.enabled).toBe(false);
          expect(getUnifiedModelOverride(config)['review/unified-reviewer']).toMatch(/^test\//);
          expect(
            loadAgents(workspace, config).find((a) => a.id === 'review/unified-reviewer')?.path
          ).toBe(join(workspace, '.drs/agents/review/unified-reviewer/agent.md'));
          expect(await simpleGit(workspace).diff()).not.toBe('');
          expect(await readFile(join(workspace, '.drs/drs.config.yaml'), 'utf8')).not.toContain(
            '\\n'
          );
          seen.push(workspace);
        },
        executeReview: async (config) => {
          const requested = getUnifiedModelOverride(config)['review/unified-reviewer'];
          return {
            issues: [],
            summary: {} as never,
            filesReviewed: 1,
            usage: {
              total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
              agents: [
                {
                  agentType: 'review/unified-reviewer',
                  model: requested === 'test/two' ? 'test/wrong' : requested,
                  turns: 1,
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: 0,
                  },
                },
              ],
            },
            parserDiagnostics: [
              {
                rawResponsePresent: true,
                validJson: true,
                validReviewSchema: true,
                emittedCount: 0,
                validCount: 0,
                invalidCount: 0,
                errors: [],
              },
            ],
          };
        },
      }
    );
    expect(seen).toHaveLength(20);
    const report = result.report as any;
    expect(report.metricsByModel['test/one'].structuredOutputSuccessRate).toBe(1);
    expect(report.metricsByModel['test/two'].runtimeProviderSuccessRate).toBe(0);
    expect(
      report.runs
        .filter((run: any) => run.requestedModel === 'test/two')
        .every((run: any) => run.status === 'runtime/model-failure')
    ).toBe(true);
  }, 15_000);
});
