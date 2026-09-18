import { rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import simpleGit from 'simple-git';
import { getUnifiedModelOverride } from './config.js';
import type { ReviewResult } from './review-orchestrator.js';
import { loadAgents } from '../runtime/agent-loader.js';
import { buildReviewPromptWithSources } from './context-loader.js';
import {
  analyzeJevPairs,
  loadBenchmarkSuite,
  loadBenchmarkCase,
  loadBenchmarkEvidence,
  adjudicationCandidates,
  summarizeBenchmarkCapabilities,
  runReviewBenchmark,
} from './review-benchmark.js';
import { metricKeys, type JevEvaluation } from './jev/types.js';

const root = process.cwd();
const output = 'out/review-benchmark-test';
const successfulReview = (model: string): ReviewResult => ({
  issues: [],
  summary: {} as never,
  filesReviewed: 1,
  usage: {
    total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    agents: [
      {
        agentType: 'review/unified-reviewer',
        model,
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
});
const jevEvaluation = (score: number, confidence = 0.8): JevEvaluation => ({
  model: 'jev-test',
  metrics: Object.fromEntries(
    metricKeys.map((metric) => [
      metric,
      metric === 'correctness'
        ? { applicable: true, score, confidence, summary: 'Synthetic benchmark signal.' }
        : { applicable: false },
    ])
  ) as JevEvaluation['metrics'],
  priorities: [],
  usage: { inputTokens: 11, outputTokens: 7 },
});
afterEach(() => rm(join(root, output), { recursive: true, force: true }));
describe('review benchmark fixtures', () => {
  it('loads the audited suite and rejects traversal', async () => {
    const loaded = await loadBenchmarkSuite(root, 'development-v1');
    expect(loaded.suite.cases).toHaveLength(10);
    await expect(loadBenchmarkSuite(root, '../package.json')).rejects.toThrow(
      /safe lowercase slug/
    );
  });
  it('identifies the historical suite as a DRS review-system regression suite', async () => {
    const loaded = await loadBenchmarkSuite(root, 'historical-v1');
    expect(loaded.suite.focus).toBe('drs-review-system');
    expect(loaded.suite.cases).toHaveLength(10);
    expect((await loadBenchmarkCase(root, loaded.suite.cases[0])).dimensions).toContain(
      'cross-file-context'
    );
    for (const id of loaded.suite.cases) {
      const evidence = await loadBenchmarkEvidence(root, id);
      expect(evidence.source).toMatch(/^https:\/\/github\.com\/manojlds\/drs\/pull\//);
      expect(evidence.proposedRevision).toMatch(/^[0-9a-f]{7,40}$/);
      expect(evidence.confirmingRevision).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });
  it('validates positive and negative cases', async () => {
    expect((await loadBenchmarkCase(root, 'inverted-condition')).expected).toHaveLength(1);
    expect((await loadBenchmarkCase(root, 'safe-refactor')).expected).toEqual([]);
  });
  it('preserves the review-relevant contracts in reduced historical fixtures', async () => {
    const fixture = (id: string, file: string) =>
      readFile(join(root, 'benchmarks/review/cases', id, file), 'utf8');
    await expect(fixture('q7m4-x2', 'base/src/temporal/workflows.ts')).resolves.toContain(
      'structuredClone'
    );
    await expect(fixture('l8q3-v9', 'change.patch')).resolves.toContain('await writeFile');
    await expect(fixture('u2k7-d5', 'change.patch')).resolves.toContain('await startGate');
    await expect(fixture('p3w8-h2', 'change.patch')).resolves.toContain('target: publish');
    await expect(fixture('p3w8-h2', 'change.patch')).resolves.toContain(
      "node.control === 'passThrough'"
    );
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

  it('loads the Jev calibration suite with paired and control cases', async () => {
    const loaded = await loadBenchmarkSuite(root, 'jev-calibration-v1');
    expect(loaded.suite.cases).toEqual(
      expect.arrayContaining([
        'inverted-condition',
        'corrected-condition',
        'incomplete-api-migration',
        'complete-api-docs-migration',
        'q7m4-x2',
        'x5j1-r7',
      ])
    );
    expect((await loadBenchmarkCase(root, 'inverted-condition')).comparison).toEqual({
      group: 'authorization-condition',
      variant: 'defect',
    });
  });

  it('computes paired per-dimension medians, direction, applicability, and confidence only', () => {
    const analysis = analyzeJevPairs([
      {
        caseId: 'bad',
        repeat: 1,
        comparison: { group: 'pair', variant: 'defect' },
        evaluation: jevEvaluation(0.2, 0.7),
      },
      {
        caseId: 'bad',
        repeat: 2,
        comparison: { group: 'pair', variant: 'defect' },
        evaluation: jevEvaluation(0.4, 0.9),
      },
      {
        caseId: 'fixed',
        repeat: 1,
        comparison: { group: 'pair', variant: 'fixed' },
        evaluation: jevEvaluation(0.8, 0.8),
      },
      {
        caseId: 'fixed',
        repeat: 2,
        comparison: { group: 'pair', variant: 'fixed' },
        evaluation: jevEvaluation(0.6, 1),
      },
    ]);

    expect(analysis).toHaveLength(1);
    expect(analysis[0]).not.toHaveProperty('overallScore');
    expect(analysis[0].dimensions.correctness).toEqual({
      direction: 'improved',
      medianDelta: 0.4,
      applicabilityConsistency: 1,
      confidence: 0.85,
      pairCount: 2,
    });
    expect(analysis[0].dimensions.security).toMatchObject({
      direction: 'inconclusive',
      medianDelta: null,
      applicabilityConsistency: 1,
      confidence: null,
      pairCount: 2,
    });
  });

  it('requires live execution and a Jev key before any Jev-containing run', async () => {
    const previous = process.env.JEV_API_KEY;
    delete process.env.JEV_API_KEY;
    let calls = 0;
    const executeReview = async () => {
      calls++;
      return {} as ReviewResult;
    };
    const base = {
      projectRoot: root,
      suite: 'jev-calibration-v1',
      models: [],
      reviewMode: 'jev' as const,
      profile: 'isolated' as const,
      repeat: 1,
      output,
    };
    try {
      await expect(runReviewBenchmark({ ...base, live: false }, { executeReview })).rejects.toThrow(
        /--live/
      );
      await expect(runReviewBenchmark({ ...base, live: true }, { executeReview })).rejects.toThrow(
        /JEV_API_KEY/
      );
      expect(calls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previous;
    }
  });

  it('runs Jev-only without a model or agent reviewer and separates Jev output', async () => {
    const previous = process.env.JEV_API_KEY;
    process.env.JEV_API_KEY = 'test-key';
    let calls = 0;
    try {
      const result = await runReviewBenchmark(
        {
          projectRoot: root,
          suite: 'jev-calibration-v1',
          models: [],
          reviewMode: 'jev',
          profile: 'isolated',
          repeat: 1,
          output,
          live: true,
        },
        {
          onWorkspaceReady: (_workspace, config) => {
            expect(getUnifiedModelOverride(config)['review/unified-reviewer']).toBeUndefined();
          },
          executeReview: async (_config, _source, options) => {
            calls++;
            expect(options).toEqual({ mode: 'jev' });
            return {
              issues: [],
              summary: {} as never,
              filesReviewed: 1,
              mode: 'jev',
              evaluations: { jev: { status: 'completed', evaluation: jevEvaluation(0.75) } },
              usage: {
                total: {
                  input: 11,
                  output: 7,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 18,
                  cost: 0,
                },
                agents: [
                  {
                    agentType: 'evaluator/jev',
                    model: 'jev-test',
                    success: true,
                    turns: 1,
                    usage: {
                      input: 11,
                      output: 7,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 18,
                      cost: 0,
                    },
                  },
                ],
              },
              parserDiagnostics: [],
            };
          },
        }
      );
      const report = result.report as any;
      expect(calls).toBe(6);
      expect(report.reviewMode).toBe('jev');
      expect(report.models).toEqual([]);
      expect(report.runs[0]).toMatchObject({
        requestedMode: 'jev',
        requestedModel: null,
        issues: [],
        adjudication: [],
        components: {
          agent: { status: 'not-requested', usage: null },
          jev: {
            status: 'success',
            model: 'jev-test',
            metrics: { correctness: { applicable: true, score: 0.75, confidence: 0.8 } },
            usage: { input: 11, output: 7, totalTokens: 18 },
          },
        },
      });
      expect(report).not.toHaveProperty('drsMetrics');
      expect(report).toHaveProperty('jevPairAnalysis');
      const markdown = await readFile(result.markdownPath, 'utf8');
      expect(markdown).toContain('Review mode: `jev`');
      expect(markdown).toContain('Agent issue findings: not requested');
      expect(markdown).toContain('## Jev dimension signals');
      expect(markdown).not.toContain('Recall/precision');
    } finally {
      if (previous === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previous;
    }
  }, 15_000);

  it('keeps combined agent adjudication and Jev signals and overhead separate', async () => {
    const previous = process.env.JEV_API_KEY;
    process.env.JEV_API_KEY = 'test-key';
    try {
      const result = await runReviewBenchmark(
        {
          projectRoot: root,
          suite: 'jev-calibration-v1',
          models: ['test/pinned'],
          reviewMode: 'combined',
          profile: 'isolated',
          repeat: 1,
          output,
          live: true,
        },
        {
          executeReview: async (_config, _source, options) => {
            expect(options).toEqual({ mode: 'combined' });
            const agent = successfulReview('test/pinned');
            const evaluatorUsage = {
              agentType: 'evaluator/jev',
              model: 'jev-test',
              success: true,
              turns: 1,
              usage: {
                input: 11,
                output: 7,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 18,
                cost: 0,
              },
            };
            agent.mode = 'combined';
            agent.evaluations = { jev: { status: 'completed', evaluation: jevEvaluation(0.75) } };
            agent.usage!.agents.push(evaluatorUsage);
            agent.usage!.total = evaluatorUsage.usage;
            return agent;
          },
        }
      );
      const report = result.report as any;
      const positive = report.runs.find((run: any) => run.caseId === 'inverted-condition');
      expect(positive.adjudication).toHaveLength(1);
      expect(positive.components.agent.usage.totalTokens).toBe(0);
      expect(positive.components.jev.usage.totalTokens).toBe(18);
      expect(report.combinedMetrics).toMatchObject({
        medianTotalTokens: 18,
        medianCost: 0,
      });
      expect(report.combinedMetrics).not.toHaveProperty('overallScore');
      expect(report.drsMetrics.recall).toBe('pending-adjudication');
    } finally {
      if (previous === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previous;
    }
  }, 15_000);

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
          ).not.toContain(workspace);
          await expect(
            readFile(join(workspace, '.drs/agents/review/unified-reviewer/agent.md'))
          ).rejects.toThrow();
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
    expect(report.schemaVersion).toBe(3);
    expect(report.systemUnderTest).toMatchObject({
      name: 'DRS review system',
      focus: 'drs-review-system',
    });
    expect(report.drsMetrics).toMatchObject({
      executionModel: 'test/one',
      runCount: 10,
      caseCount: 10,
      pipelineSuccessRate: 1,
      recall: 'pending-adjudication',
      precision: 'pending-adjudication',
    });
    expect(report.metricsByModel['test/one'].structuredOutputSuccessRate).toBe(1);
    expect(report.metricsByModel['test/two'].runtimeProviderSuccessRate).toBe(0);
    expect(
      report.runs
        .filter((run: any) => run.requestedModel === 'test/two')
        .every((run: any) => run.status === 'runtime/model-failure')
    ).toBe(true);
  }, 15_000);

  it('preserves capability fixture context, config, and skills while using the packaged reviewer', async () => {
    let seen = 0;
    const result = await runReviewBenchmark(
      {
        projectRoot: root,
        suite: 'capabilities-v1',
        models: ['test/pinned'],
        profile: 'isolated',
        repeat: 1,
        output,
        live: true,
      },
      {
        onWorkspaceReady: async (workspace, config) => {
          if (
            (await readFile(join(workspace, 'serializer.ts'), 'utf8').catch(() => '')) &&
            (await readFile(join(workspace, '.drs/skills/wire-contract/SKILL.md'), 'utf8').catch(
              () => ''
            ))
          ) {
            expect(config.review.ignorePatterns).toContain('generated/**');
            expect(
              await readFile(join(workspace, '.drs/skills/wire-contract/SKILL.md'), 'utf8')
            ).toContain('name: wire-contract');
            expect(
              loadAgents(workspace, config).find((agent) => agent.id === 'review/unified-reviewer')
                ?.path
            ).not.toContain(workspace);
            expect(await readFile(join(workspace, '.drs/drs.config.yaml'), 'utf8')).toContain(
              'css-layout'
            );
            seen++;
          }
        },
        executeReview: async (config, source) => {
          const result = successfulReview('test/pinned');
          result.usage!.agents[0].contextSources = buildReviewPromptWithSources(
            'review/unified-reviewer',
            'Review the change.',
            'Benchmark case',
            source.files,
            source.workingDir ?? root,
            config
          ).contextSources;
          return result;
        },
      }
    );
    expect(seen).toBe(1);
    expect((result.report as any).capabilityMetrics).toEqual({
      contextApplicationRate: 1,
      requiredSkillConfigurationRate: 1,
      requiredSkillAvailabilityRate: 1,
      requiredSkillActivationRate: 0,
      requiredInspectionCoverageRate: 0,
      expectedNotLoadedCleanRate: 1,
    });
  }, 15_000);

  it('summarizes trace observables without retaining prompts, thinking, results, or arguments', () => {
    const trace: any = {
      prompt: 'secret prompt',
      thinkingContent: 'secret thought',
      skillsLoaded: ['css-layout'],
      turns: [
        {
          toolCalls: [
            {
              toolName: 'read',
              args: { path: '.drs/skills/wire-contract/SKILL.md' },
              result: 'secret skill contents',
              isError: false,
            },
            {
              toolName: 'read',
              args: { path: 'contract.ts', token: 'secret' },
              result: '---\nname: css-layout\n---\nsecret result',
            },
            {
              toolName: 'read',
              args: { path: '.drs/skills/css-layout/SKILL.md' },
              isError: true,
            },
            {
              toolName: 'grep',
              args: { pattern: 'serializer.ts' },
              isError: false,
            },
          ],
        },
      ],
    };
    const summary = summarizeBenchmarkCapabilities(
      {
        capabilities: {
          requiredSkills: ['wire-contract'],
          expectedNotLoadedSkills: ['css-layout'],
          requiredInspectionPaths: ['contract.ts'],
        },
      },
      join(root, 'benchmarks/review/cases/m8q2-s7/base'),
      undefined,
      [trace],
      ['wire-contract', 'css-layout']
    );
    expect(summary).toMatchObject({
      loadedSkills: ['wire-contract'],
      toolCalls: { grep: 1, read: 3 },
      inspectedPaths: ['.drs/skills/wire-contract/SKILL.md', 'contract.ts'],
      requiredSkillActivation: { 'wire-contract': true },
      expectedNotLoadedViolations: [],
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('executes every historical fixture without exposing evidence to the reviewer', async () => {
    const seen: string[] = [];
    const result = await runReviewBenchmark(
      {
        projectRoot: root,
        suite: 'historical-v1',
        models: ['test/pinned'],
        profile: 'isolated',
        repeat: 1,
        output,
        live: true,
      },
      {
        onWorkspaceReady: async (workspace) => {
          expect(await simpleGit(workspace).diff()).not.toBe('');
          await expect(readFile(join(workspace, 'case.yaml'))).rejects.toThrow();
          await expect(readFile(join(workspace, 'evidence.yaml'))).rejects.toThrow();
          seen.push(workspace);
        },
        executeReview: async () => successfulReview('test/pinned'),
      }
    );
    const report = result.report as any;
    expect(seen).toHaveLength(10);
    expect(report.runs.filter((run: any) => run.expectedCount > 0)).toHaveLength(6);
    expect(report.runs.filter((run: any) => run.expectedCount === 0)).toHaveLength(4);
    expect(report.runs.every((run: any) => run.hashes.evidence)).toBe(true);
    expect(report.suiteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.systemUnderTest.sourceSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);

  it('discards a report when the suite changes during execution', async () => {
    const suitePath = join(root, 'benchmarks/review/suites/development-v1.yaml');
    const original = await readFile(suitePath, 'utf8');
    let changed = false;
    try {
      await expect(
        runReviewBenchmark(
          {
            projectRoot: root,
            suite: 'development-v1',
            models: ['test/pinned'],
            profile: 'isolated',
            repeat: 1,
            output,
            live: true,
          },
          {
            executeReview: async () => {
              if (!changed) {
                changed = true;
                await writeFile(suitePath, `${original}\n`);
              }
              return successfulReview('test/pinned');
            },
          }
        )
      ).rejects.toThrow(/changed during execution/);
    } finally {
      await writeFile(suitePath, original);
    }
  }, 15_000);
});
