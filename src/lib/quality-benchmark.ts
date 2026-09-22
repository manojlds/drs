import { createHash } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import simpleGit from 'simple-git';
import { loadConfig } from './config.js';
import { formatCompressionSummary, prepareDiffsForAgent } from './context-compression.js';
import { getFilesWithDiffs, parseDiff } from './diff-parser.js';
import { createJevClientFromEnvironment } from './jev/client.js';
import { evaluateQualityWithLlm, type LlmQualityEvaluationResult } from './jev/llm-evaluator.js';
import { buildJevQuestions } from './jev/questions.js';
import { buildJevReviewState, type JevReviewState } from './jev/review.js';
import { toJevEvaluation } from './jev/transform.js';
import { metricKeys, type JevEvaluation, type MetricKey } from './jev/types.js';
import {
  analyzeJevExpectedSignals,
  analyzeJevPairs,
  loadBenchmarkCase,
  loadBenchmarkSuite,
  type BenchmarkCase,
  type JevPairRun,
} from './review-benchmark.js';
import { createRuntimeClientInstance, type SimpleCompletionResult } from '../runtime/client.js';

const MODEL = /^[^/\s]+\/[^/\s]+$/;

export interface QualityBenchmarkOptions {
  projectRoot: string;
  suite: string;
  models: string[];
  profile: 'isolated';
  repeat: number;
  output: string;
  live: boolean;
}

export interface QualityBenchmarkDependencies {
  evaluateJev?: (state: JevReviewState) => Promise<JevEvaluation>;
  evaluateLlm?: (model: string, stateJson: string) => Promise<LlmQualityEvaluationResult>;
  onProgress?: (message: string) => void;
}

type QualityRunStatus = 'success' | 'runtime-failure' | 'parser-failure';

interface QualityBenchmarkRun {
  caseId: string;
  repeat: number;
  evaluator: {
    id: string;
    kind: 'jev' | 'llm';
    requestedModel: string | null;
    actualModel: string | null;
  };
  status: QualityRunStatus;
  stateSha256: string;
  stateBytes: number;
  expectedWeakDimensions: MetricKey[];
  comparison?: BenchmarkCase['comparison'];
  evaluation?: JevEvaluation;
  latencyMs: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number | null;
  } | null;
  error?: string;
}

interface QualityEvaluatorAnalysis {
  runCount: number;
  successRate: number | null;
  expectedSignals: ReturnType<typeof analyzeJevExpectedSignals>;
  pairAnalysis: ReturnType<typeof analyzeJevPairs>;
  cleanControlPriorityFreeRate: number | null;
  medianCleanControlPriorities: number | null;
  stability: {
    applicabilityFlipRate: number | null;
    meanApplicableScoreRange: number | null;
    prioritySetFlipRate: number | null;
  };
  performance: {
    medianLatencyMs: number | null;
    medianInputTokens: number | null;
    medianOutputTokens: number | null;
    medianCost: number | null;
  };
}

interface QualityAgreement {
  pairedRuns: number;
  applicabilityAgreement: number | null;
  scoreMeanAbsoluteDifference: number | null;
  meanPriorityJaccard: number | null;
}

export async function runQualityBenchmark(
  options: QualityBenchmarkOptions,
  dependencies: QualityBenchmarkDependencies = {}
): Promise<{ jsonPath: string; markdownPath: string; report: Record<string, unknown> }> {
  validateOptions(options);
  const projectRoot = resolve(options.projectRoot);
  const loaded = await loadBenchmarkSuite(projectRoot, options.suite);
  const questions = buildJevQuestions();
  const rubricHash = hash(JSON.stringify(questions));
  const suiteHash = await hashSuite(projectRoot, loaded.path, loaded.suite.cases);
  const git = simpleGit(projectRoot);
  const revision = (await git.revparse(['HEAD'])).trim();
  const dirty = (await git.status()).files.length > 0;
  const fixtures = new Map<string, BenchmarkCase>();
  const runs: QualityBenchmarkRun[] = [];
  const progress = dependencies.onProgress ?? ((message: string) => console.log(message));

  const jevClient = dependencies.evaluateJev ? undefined : createJevClientFromEnvironment();
  const config = dependencies.evaluateLlm ? undefined : loadConfig(projectRoot);
  const runtime = dependencies.evaluateLlm
    ? undefined
    : await createRuntimeClientInstance({ directory: projectRoot, config });
  if (runtime) {
    const unavailable = options.models.filter(
      (model) => runtime.getModelContextWindow(model) === undefined
    );
    if (unavailable.length) {
      await runtime.shutdown();
      throw new Error(`Models unavailable in the Pi runtime: ${unavailable.join(', ')}.`);
    }
  }

  const evaluateJev =
    dependencies.evaluateJev ??
    (async (state: JevReviewState) => toJevEvaluation(await jevClient!.evaluate(state, questions)));
  const evaluateLlm =
    dependencies.evaluateLlm ??
    (async (model: string, stateJson: string) =>
      evaluateQualityWithLlm(runtime!, model, stateJson, {
        onBatchStart: (batch, total) =>
          progress(`[quality] ${model}: starting rubric batch ${batch}/${total}`),
        onBatchComplete: (batch, total) =>
          progress(`[quality] ${model}: completed rubric batch ${batch}/${total}`),
      }));

  try {
    for (const caseId of loaded.suite.cases) {
      const fixture = await loadBenchmarkCase(projectRoot, caseId);
      fixtures.set(caseId, fixture);
      const patch = await readFile(
        join(projectRoot, 'benchmarks/review/cases', caseId, 'change.patch'),
        'utf8'
      );
      const prepared = prepareDiffsForAgent(getFilesWithDiffs(parseDiff(patch)));
      const state = buildJevReviewState({
        label: 'Calibration case',
        files: prepared.files,
        compressionSummary: formatCompressionSummary(prepared),
      });
      const stateJson = JSON.stringify(state);
      const stateSha256 = hash(stateJson);
      const stateBytes = Buffer.byteLength(stateJson);

      for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
        progress(`[quality] ${caseId} repeat ${repeat}: evaluating with Jev`);
        runs.push(
          await executeEvaluator({
            caseId,
            repeat,
            evaluatorId: 'jev',
            kind: 'jev',
            requestedModel: null,
            state,
            stateJson,
            stateSha256,
            stateBytes,
            fixture,
            execute: () => evaluateJev(state),
          })
        );

        for (const model of options.models) {
          progress(`[quality] ${caseId} repeat ${repeat}: evaluating with ${model}`);
          runs.push(
            await executeEvaluator({
              caseId,
              repeat,
              evaluatorId: `llm:${model}`,
              kind: 'llm',
              requestedModel: model,
              state,
              stateJson,
              stateSha256,
              stateBytes,
              fixture,
              execute: () => evaluateLlm(model, stateJson),
            })
          );
        }
      }
    }
  } finally {
    await runtime?.shutdown();
  }

  if ((await hashSuite(projectRoot, loaded.path, loaded.suite.cases)) !== suiteHash) {
    throw new Error('Benchmark suite changed during execution; discarding report.');
  }

  const evaluatorIds = ['jev', ...options.models.map((model) => `llm:${model}`)];
  const evaluatorAnalysis = Object.fromEntries(
    evaluatorIds.map((evaluatorId) => {
      const selected = runs.filter((run) => run.evaluator.id === evaluatorId);
      const successful = selected.filter(
        (run): run is QualityBenchmarkRun & { evaluation: JevEvaluation } =>
          run.status === 'success' && run.evaluation !== undefined
      );
      const analysisRuns: JevPairRun[] = successful.map((run) => ({
        caseId: run.caseId,
        repeat: run.repeat,
        model: evaluatorId,
        comparison: run.comparison,
        expectedWeakDimensions: run.expectedWeakDimensions,
        evaluation: run.evaluation,
      }));
      const cleanRuns = successful.filter((run) => fixtures.get(run.caseId)?.expected.length === 0);
      return [
        evaluatorId,
        {
          runCount: selected.length,
          successRate: selected.length ? successful.length / selected.length : null,
          expectedSignals: analyzeJevExpectedSignals(analysisRuns),
          pairAnalysis: analyzeJevPairs(analysisRuns),
          cleanControlPriorityFreeRate: rate(
            cleanRuns.map((run) => run.evaluation.priorities.length === 0)
          ),
          medianCleanControlPriorities: median(
            cleanRuns.map((run) => run.evaluation.priorities.length)
          ),
          stability: analyzeStability(successful),
          performance: {
            medianLatencyMs: median(successful.map((run) => run.latencyMs)),
            medianInputTokens: median(
              successful.flatMap((run) => (run.usage ? [run.usage.input] : []))
            ),
            medianOutputTokens: median(
              successful.flatMap((run) => (run.usage ? [run.usage.output] : []))
            ),
            medianCost: median(
              successful.flatMap((run) =>
                run.usage?.cost === null || run.usage?.cost === undefined ? [] : [run.usage.cost]
              )
            ),
          },
        },
      ];
    })
  ) as Record<string, QualityEvaluatorAnalysis>;
  const agreement = Object.fromEntries(
    options.models.map((model) => {
      const evaluatorId = `llm:${model}`;
      return [evaluatorId, analyzeAgreement(runs, evaluatorId)];
    })
  ) as Record<string, QualityAgreement>;

  const report = {
    schemaVersion: 1,
    suite: loaded.suite.name,
    suiteHash,
    rubricHash,
    revision,
    dirty,
    profile: options.profile,
    repeat: options.repeat,
    preparedStateGuarantee:
      'Every evaluator run for a case and repetition used the same serialized state bytes. LLM rubric batches repeat those bytes; request framing differs by evaluator protocol.',
    uncertaintyNote:
      'LLM rubric evaluators do not emit comparable probabilities; synthetic confidence fields are structural only and are excluded from comparisons.',
    evaluators: evaluatorIds,
    evaluatorAnalysis,
    agreementWithJev: agreement,
    runs,
  };

  const output = resolve(projectRoot, options.output);
  const relativeOutput = relative(projectRoot, output);
  if (!relativeOutput || relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
    throw new Error('Output must be a directory inside the project root.');
  }
  await mkdir(output, { recursive: true });
  const modelHash = hash(JSON.stringify(options.models)).slice(0, 8);
  const base = `${loaded.suite.name}-quality-r${options.repeat}-s${suiteHash.slice(0, 8)}-q${rubricHash.slice(0, 8)}-m${modelHash}`;
  const jsonPath = join(output, `${base}.json`);
  const markdownPath = join(output, `${base}.md`);
  await writeExclusive(jsonPath, JSON.stringify(report, null, 2) + '\n');
  try {
    await writeExclusive(
      markdownPath,
      formatMarkdown(loaded.suite.name, revision, dirty, evaluatorAnalysis, agreement, runs)
    );
  } catch (error) {
    await rm(jsonPath, { force: true });
    throw error;
  }
  return { jsonPath, markdownPath, report };
}

async function executeEvaluator(options: {
  caseId: string;
  repeat: number;
  evaluatorId: string;
  kind: 'jev' | 'llm';
  requestedModel: string | null;
  state: JevReviewState;
  stateJson: string;
  stateSha256: string;
  stateBytes: number;
  fixture: BenchmarkCase;
  execute: () => Promise<JevEvaluation | LlmQualityEvaluationResult>;
}): Promise<QualityBenchmarkRun> {
  const started = Date.now();
  try {
    const result = await options.execute();
    const isLlm = 'evaluation' in result;
    const evaluation = isLlm ? result.evaluation : result;
    const completion = isLlm ? result.completion : undefined;
    return {
      caseId: options.caseId,
      repeat: options.repeat,
      evaluator: {
        id: options.evaluatorId,
        kind: options.kind,
        requestedModel: options.requestedModel,
        actualModel: evaluation.model,
      },
      status: 'success',
      stateSha256: options.stateSha256,
      stateBytes: options.stateBytes,
      expectedWeakDimensions: options.fixture.jev?.expectedWeakDimensions ?? [],
      comparison: options.fixture.comparison,
      evaluation,
      latencyMs: Date.now() - started,
      usage: completion ? completionUsage(completion) : jevUsage(evaluation),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      caseId: options.caseId,
      repeat: options.repeat,
      evaluator: {
        id: options.evaluatorId,
        kind: options.kind,
        requestedModel: options.requestedModel,
        actualModel: null,
      },
      status: /JSON|metric|weakness|score|applicable|stopped with reason/.test(message)
        ? 'parser-failure'
        : 'runtime-failure',
      stateSha256: options.stateSha256,
      stateBytes: options.stateBytes,
      expectedWeakDimensions: options.fixture.jev?.expectedWeakDimensions ?? [],
      comparison: options.fixture.comparison,
      latencyMs: Date.now() - started,
      usage: null,
      error: message,
    };
  }
}

function completionUsage(
  completion: SimpleCompletionResult
): NonNullable<QualityBenchmarkRun['usage']> {
  return {
    input: completion.usage.input,
    output: completion.usage.output,
    cacheRead: completion.usage.cacheRead,
    cacheWrite: completion.usage.cacheWrite,
    totalTokens: completion.usage.totalTokens,
    cost: completion.usage.cost.total,
  };
}

function jevUsage(evaluation: JevEvaluation): NonNullable<QualityBenchmarkRun['usage']> {
  return {
    input: evaluation.usage.inputTokens,
    output: evaluation.usage.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: evaluation.usage.inputTokens + evaluation.usage.outputTokens,
    cost: null,
  };
}

function analyzeAgreement(runs: QualityBenchmarkRun[], llmEvaluatorId: string) {
  const pairs = runs.flatMap((jev) => {
    if (jev.evaluator.id !== 'jev' || jev.status !== 'success' || !jev.evaluation) return [];
    const llm = runs.find(
      (candidate) =>
        candidate.evaluator.id === llmEvaluatorId &&
        candidate.caseId === jev.caseId &&
        candidate.repeat === jev.repeat &&
        candidate.status === 'success' &&
        candidate.evaluation
    );
    return llm?.evaluation ? [{ jev: jev.evaluation, llm: llm.evaluation }] : [];
  });
  const applicability = pairs.flatMap(({ jev, llm }) =>
    metricKeys.map((metric) => jev.metrics[metric].applicable === llm.metrics[metric].applicable)
  );
  const scoreDifferences = pairs.flatMap(({ jev, llm }) =>
    metricKeys.flatMap((metric) => {
      const left = jev.metrics[metric];
      const right = llm.metrics[metric];
      return left.applicable && right.applicable ? [Math.abs(left.score - right.score)] : [];
    })
  );
  const priorityOverlap = pairs.map(({ jev, llm }) => {
    const left = new Set(jev.priorities.map((priority) => priority.metric));
    const right = new Set(llm.priorities.map((priority) => priority.metric));
    const union = new Set([...left, ...right]);
    if (union.size === 0) return 1;
    return [...left].filter((metric) => right.has(metric)).length / union.size;
  });
  return {
    pairedRuns: pairs.length,
    applicabilityAgreement: rate(applicability),
    scoreMeanAbsoluteDifference: mean(scoreDifferences),
    meanPriorityJaccard: mean(priorityOverlap),
  };
}

function analyzeStability(runs: Array<QualityBenchmarkRun & { evaluation: JevEvaluation }>) {
  const metricGroups = new Map<string, Array<{ applicable: boolean; score: number | null }>>();
  const priorityGroups = new Map<string, string[]>();
  for (const run of runs) {
    priorityGroups.set(
      `${run.caseId}:${run.repeat}`,
      run.evaluation.priorities.map((priority) => priority.metric).sort()
    );
    for (const metric of metricKeys) {
      const evaluation = run.evaluation.metrics[metric];
      const key = `${run.caseId}:${metric}`;
      const values = metricGroups.get(key) ?? [];
      values.push({
        applicable: evaluation.applicable,
        score: evaluation.applicable ? evaluation.score : null,
      });
      metricGroups.set(key, values);
    }
  }
  const comparableMetrics = [...metricGroups.values()].filter((values) => values.length > 1);
  const scoreRanges = comparableMetrics.flatMap((values) => {
    const scores = values.flatMap((value) => (value.score === null ? [] : [value.score]));
    return scores.length > 1 ? [Math.max(...scores) - Math.min(...scores)] : [];
  });
  const priorityByCase = new Map<string, string[]>();
  for (const [key, priorities] of priorityGroups) {
    const caseId = key.slice(0, key.lastIndexOf(':'));
    const values = priorityByCase.get(caseId) ?? [];
    values.push(priorities.join(','));
    priorityByCase.set(caseId, values);
  }
  return {
    applicabilityFlipRate: rate(
      comparableMetrics.map((values) => new Set(values.map((value) => value.applicable)).size > 1)
    ),
    meanApplicableScoreRange: mean(scoreRanges),
    prioritySetFlipRate: rate(
      [...priorityByCase.values()]
        .filter((values) => values.length > 1)
        .map((values) => new Set(values).size > 1)
    ),
  };
}

function formatMarkdown(
  suite: string,
  revision: string,
  dirty: boolean,
  evaluatorAnalysis: Record<string, QualityEvaluatorAnalysis>,
  agreement: Record<string, QualityAgreement>,
  runs: QualityBenchmarkRun[]
): string {
  const percent = (value: number | null): string =>
    value === null ? 'n/a' : `${Math.round(value * 100)}%`;
  const number = (value: number | null): string =>
    value === null ? 'n/a' : String(Number(value.toFixed(4)));
  const evaluatorRows = Object.entries(evaluatorAnalysis)
    .map(([id, value]) => {
      const expected = value.expectedSignals;
      return `| ${id} | ${percent(value.successRate)} | ${percent(expected.applicableRate)} | ${percent(expected.priorityHitRate)} | ${percent(value.cleanControlPriorityFreeRate)} | ${percent(value.stability.applicabilityFlipRate)} | ${number(value.performance.medianLatencyMs)} | ${number(value.performance.medianCost)} |`;
    })
    .join('\n');
  const agreementRows = Object.entries(agreement)
    .map(
      ([id, value]) =>
        `| ${id} | ${value.pairedRuns} | ${percent(value.applicabilityAgreement)} | ${number(value.scoreMeanAbsoluteDifference)} | ${number(value.meanPriorityJaccard)} |`
    )
    .join('\n');
  const runRows = runs
    .map((run) => {
      const applicable = run.evaluation
        ? Object.values(run.evaluation.metrics).filter((metric) => metric.applicable).length
        : 0;
      return `| ${run.caseId} | ${run.repeat} | ${run.evaluator.id} | ${run.status} | ${applicable} | ${run.evaluation?.priorities.length ?? 0} | ${run.stateSha256.slice(0, 12)} |`;
    })
    .join('\n');
  return `# Quality evaluator comparison: ${suite}\n\nRevision: \`${revision}${dirty ? ' (dirty)' : ''}\`  \nThe prepared state bytes are identical across evaluators for each case. Request framing differs by protocol.  \nLLM confidence is synthetic and is not compared with Jev probabilities. No overall quality score is calculated.\n\n## Ground-truth signals\n\n| Evaluator | Success | Expected applicable | Expected priority hit | Clean controls priority-free | Applicability flips | Median latency ms | Median cost |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${evaluatorRows}\n\n## Agreement with Jev\n\nAgreement describes similarity, not correctness.\n\n| LLM evaluator | Paired runs | Applicability agreement | Score MAE | Priority Jaccard |\n|---|---:|---:|---:|---:|\n${agreementRows}\n\n## Runs\n\n| Case | Repeat | Evaluator | Status | Applicable dimensions | Priorities | State hash |\n|---|---:|---|---|---:|---:|---|\n${runRows}\n`;
}

function validateOptions(options: QualityBenchmarkOptions): void {
  if (!options.live)
    throw new Error('Live provider execution requires explicit --live acknowledgement.');
  if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is required for quality benchmarks.');
  if (options.profile !== 'isolated') throw new Error('Only --profile isolated is supported.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1) {
    throw new Error('--repeat must be a positive integer.');
  }
  if (!options.models.length) throw new Error('At least one explicit --model is required.');
  if (options.models.some((model) => !MODEL.test(model))) {
    throw new Error('Models must use provider/model form.');
  }
  if (new Set(options.models).size !== options.models.length) {
    throw new Error('Duplicate models are not allowed.');
  }
}

async function hashSuite(root: string, suitePath: string, caseIds: string[]): Promise<string> {
  const digest = createHash('sha256');
  digest.update(await readFile(suitePath));
  for (const caseId of [...caseIds].sort()) {
    const caseRoot = join(root, 'benchmarks/review/cases', caseId);
    for (const filename of ['case.yaml', 'change.patch', 'evidence.yaml']) {
      try {
        digest.update(await readFile(join(caseRoot, filename)));
      } catch {
        if (filename !== 'evidence.yaml') throw new Error(`Missing ${filename} for ${caseId}.`);
      }
    }
  }
  return digest.digest('hex');
}

async function writeExclusive(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx' });
  } catch (error) {
    throw new Error(`Refusing to overwrite benchmark output: ${path}`, { cause: error });
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function rate(values: boolean[]): number | null {
  return values.length ? values.filter(Boolean).length / values.length : null;
}
