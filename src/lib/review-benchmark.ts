import { createHash } from 'crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import YAML from 'yaml';
import simpleGit from 'simple-git';
import {
  getDefaultThinkingLevel,
  getUnifiedModelOverride,
  loadConfig,
  type DRSConfig,
} from './config.js';
import { parseDiff, getChangedFiles, getFilesWithDiffs } from './diff-parser.js';
import { executeReview, type ReviewResult, type ReviewSource } from './review-orchestrator.js';
import { ReviewAgentExecutionError } from './review-core.js';
import type { ReviewIssueParserDiagnostics } from './issue-parser.js';
import type { ReviewUsageSummary } from './review-usage.js';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const MODEL = /^[^/\s]+\/[^/\s]+$/;
const PR_URL = /^https:\/\/github\.com\/manojlds\/drs\/pull\/[1-9][0-9]*$/;
const GIT_REVISION = /^[0-9a-f]{7,40}$/;
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const CATEGORIES = new Set(['SECURITY', 'QUALITY', 'STYLE', 'PERFORMANCE', 'DOCUMENTATION']);
const THINKING_LEVEL = 'medium';
const MODEL_ENV_VARS = [
  'DRS_AGENT_REVIEW_UNIFIED_REVIEWER_MODEL',
  'REVIEW_AGENT_REVIEW_UNIFIED_REVIEWER_MODEL',
  'REVIEW_UNIFIED_MODEL',
  'DRS_REVIEW_AGENT',
  'REVIEW_AGENTS',
  'DRS_DEFAULT_MODEL',
  'REVIEW_DEFAULT_MODEL',
] as const;

export type ExpectedFinding = {
  id: string;
  description: string;
  severity: string;
  category: string;
  file: string;
  line?: number;
  endLine?: number;
};
export type BenchmarkCase = {
  id: string;
  description: string;
  dimensions?: string[];
  expected: ExpectedFinding[];
};
export type BenchmarkSuite = {
  name: string;
  description?: string;
  focus?: 'drs-review-system';
  cases: string[];
};
export type BenchmarkEvidence = {
  provenance: 'historical' | 'derived-historical';
  source: string;
  proposedRevision: string;
  confirmingRevision: string;
  rationale: string;
};
export type BenchmarkOptions = {
  projectRoot: string;
  suite: string;
  models: string[];
  profile: 'isolated';
  repeat: number;
  output: string;
  live: boolean;
};
export type BenchmarkDependencies = {
  executeReview?: (config: DRSConfig, source: ReviewSource) => Promise<ReviewResult>;
  onWorkspaceReady?: (
    workspace: string,
    config: DRSConfig,
    source: ReviewSource
  ) => void | Promise<void>;
};

type BenchmarkStatus = 'success' | 'parser-failure' | 'runtime/model-failure';

interface BenchmarkRun {
  caseId: string;
  requestedModel: string;
  actualModel: string | null;
  thinkingLevel: string;
  repeat: number;
  expectedCount: number;
  status: BenchmarkStatus;
  issues: ReviewResult['issues'];
  usage: ReviewUsageSummary | null;
  durationMs: number;
  parserDiagnostics: ReviewIssueParserDiagnostics[];
  hashes: Record<string, string>;
  adjudication: Record<string, unknown>[];
  errors: string[];
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
}

function safeRelative(value: string, label: string): void {
  if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..'))
    throw new Error(`${label} must be a safe relative path.`);
}

function resolveWithin(root: string, value: string, label: string): string {
  const target = resolve(root, value);
  const rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} must be inside ${root}.`);
  return target;
}

export async function loadBenchmarkSuite(
  root: string,
  value: string
): Promise<{ suite: BenchmarkSuite; path: string }> {
  if (!SLUG.test(value)) throw new Error('Suite name must be a safe lowercase slug.');
  const benchmarkRoot = resolve(root, 'benchmarks/review');
  const candidate = resolveWithin(benchmarkRoot, `suites/${value}.yaml`, 'Suite');
  const parsed: unknown = YAML.parse(await readFile(candidate, 'utf8'));
  assertObject(parsed, 'Suite');
  if (
    parsed.name !== value ||
    !SLUG.test(String(parsed.name)) ||
    ((parsed.description !== undefined || parsed.focus !== undefined) &&
      (typeof parsed.description !== 'string' || parsed.focus !== 'drs-review-system')) ||
    !Array.isArray(parsed.cases) ||
    parsed.cases.some((x) => typeof x !== 'string' || !SLUG.test(x))
  )
    throw new Error('Suite requires a matching safe name and safe string case IDs.');
  if (new Set(parsed.cases).size !== parsed.cases.length)
    throw new Error('Suite case IDs must be unique.');
  return { suite: parsed as BenchmarkSuite, path: candidate };
}

export async function loadBenchmarkCase(root: string, id: string): Promise<BenchmarkCase> {
  if (!SLUG.test(id)) throw new Error(`Unsafe case ID: ${id}`);
  const parsed: unknown = YAML.parse(
    await readFile(join(root, 'benchmarks/review/cases', id, 'case.yaml'), 'utf8')
  );
  assertObject(parsed, `Case ${id}`);
  if (
    parsed.id !== id ||
    typeof parsed.description !== 'string' ||
    (parsed.dimensions !== undefined &&
      (!Array.isArray(parsed.dimensions) ||
        parsed.dimensions.some(
          (dimension) => typeof dimension !== 'string' || !SLUG.test(dimension)
        ))) ||
    !Array.isArray(parsed.expected)
  )
    throw new Error(`Invalid case schema: ${id}`);
  const ids = new Set<string>();
  for (const finding of parsed.expected) {
    assertObject(finding, `Expected finding in ${id}`);
    if (
      !['id', 'description', 'severity', 'category', 'file'].every(
        (key) => typeof finding[key] === 'string'
      )
    )
      throw new Error(`Invalid expected finding in ${id}`);
    if (ids.has(finding.id as string)) throw new Error(`Duplicate expected finding ID in ${id}.`);
    ids.add(finding.id as string);
    if (!SEVERITIES.has(finding.severity as string) || !CATEGORIES.has(finding.category as string))
      throw new Error(`Invalid severity/category in ${id}.`);
    safeRelative(finding.file as string, `Expected file in ${id}`);
    for (const key of ['line', 'endLine'] as const)
      if (
        finding[key] !== undefined &&
        (!Number.isInteger(finding[key]) || (finding[key] as number) < 1)
      )
        throw new Error(`${key} must be a positive integer in ${id}.`);
    if (finding.endLine !== undefined && finding.line === undefined)
      throw new Error(`endLine requires line in ${id}.`);
    if (
      (finding.endLine as number | undefined) !== undefined &&
      (finding.endLine as number) < (finding.line as number)
    )
      throw new Error(`endLine must not precede line in ${id}.`);
  }
  return parsed as BenchmarkCase;
}

export async function loadBenchmarkEvidence(root: string, id: string): Promise<BenchmarkEvidence> {
  if (!SLUG.test(id)) throw new Error(`Unsafe case ID: ${id}`);
  const parsed: unknown = YAML.parse(
    await readFile(join(root, 'benchmarks/review/cases', id, 'evidence.yaml'), 'utf8')
  );
  assertObject(parsed, `Evidence for ${id}`);
  if (
    !['historical', 'derived-historical'].includes(String(parsed.provenance)) ||
    !PR_URL.test(String(parsed.source)) ||
    !GIT_REVISION.test(String(parsed.proposedRevision)) ||
    !GIT_REVISION.test(String(parsed.confirmingRevision)) ||
    !['source', 'proposedRevision', 'confirmingRevision', 'rationale'].every(
      (key) => typeof parsed[key] === 'string' && parsed[key].length > 0
    )
  )
    throw new Error(`Invalid evidence schema: ${id}`);
  return parsed as BenchmarkEvidence;
}

const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function hashTree(root: string): Promise<string> {
  const digest = createHash('sha256');
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir)).sort()) {
      const absolute = join(dir, entry);
      const info = await stat(absolute);
      if (info.isDirectory()) await visit(absolute);
      else {
        const rel = relative(root, absolute).split('\\').join('/');
        digest.update(`${Buffer.byteLength(rel)}:${rel}:${info.size}:`);
        digest.update(await readFile(absolute));
      }
    }
  }
  await visit(root);
  return digest.digest('hex');
}

export function adjudicationCandidates(
  expected: ExpectedFinding[],
  actual: ReviewResult['issues'],
  ineffective: boolean
) {
  const candidates: Record<string, unknown>[] = [];
  if (expected.length === 0)
    actual.forEach((_issue, actualIndex) =>
      candidates.push({
        expectedId: null,
        actualIndex,
        status: 'false-positive-candidate',
        semanticMatch: 'pending',
      })
    );
  for (const finding of expected) {
    if (actual.length === 0)
      candidates.push({
        expectedId: finding.id,
        actualIndex: null,
        status: ineffective ? 'ineffective-review' : 'unmatched',
        semanticMatch: 'pending',
      });
    else
      actual.forEach((issue, actualIndex) =>
        candidates.push({
          expectedId: finding.id,
          actualIndex,
          status: 'pending',
          semanticMatch: 'pending',
          objective: {
            file: finding.file === issue.file,
            severity: finding.severity === issue.severity,
            category: finding.category === issue.category,
            line: finding.line === undefined || finding.line === issue.line,
          },
        })
      );
  }
  return candidates;
}

function validateOptions(options: BenchmarkOptions): void {
  if (!options.live)
    throw new Error('Live provider execution requires explicit --live acknowledgement.');
  if (options.profile !== 'isolated') throw new Error('Only --profile isolated is supported.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1)
    throw new Error('--repeat must be a positive integer.');
  if (!options.models.length) throw new Error('At least one explicit --model is required.');
  if (options.models.some((model) => !MODEL.test(model)))
    throw new Error('Models must use provider/model form.');
  if (new Set(options.models).size !== options.models.length)
    throw new Error('Duplicate models are not allowed.');
  const active = MODEL_ENV_VARS.filter((name) => process.env[name] !== undefined);
  if (active.length)
    throw new Error(`Unset model-affecting environment variables: ${active.join(', ')}.`);
}

function structuredSuccess(result: ReviewResult | undefined): boolean {
  const diagnostics = result?.parserDiagnostics;
  return (
    !!diagnostics &&
    diagnostics.length === 1 &&
    diagnostics.every(
      (d) =>
        d.rawResponsePresent &&
        d.validJson &&
        d.validReviewSchema &&
        d.invalidCount === 0 &&
        d.errors.length === 0
    )
  );
}

export async function runReviewBenchmark(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies = {}
): Promise<{ jsonPath: string; markdownPath: string; report: Record<string, unknown> }> {
  validateOptions(options);
  const projectRoot = resolve(options.projectRoot);
  const loaded = await loadBenchmarkSuite(projectRoot, options.suite);
  const agentSource = join(projectRoot, '.pi/agents/review/unified-reviewer.md');
  const agentText = await readFile(agentSource);
  const captureIdentity = async () => {
    const git = simpleGit(projectRoot);
    const agentHash = hash(agentText);
    return {
      revision: (await git.revparse(['HEAD'])).trim(),
      dirty: (await git.status()).files.length > 0,
      agentHash,
      sourceSnapshotHash: hash(
        [
          await hashTree(join(projectRoot, 'src')),
          agentHash,
          hash(await readFile(join(projectRoot, 'package-lock.json'))),
          hash(await readFile(join(projectRoot, '.drs/drs.config.yaml'))),
        ].join(':')
      ),
      suiteHash: hash(
        [
          hash(await readFile(loaded.path)),
          ...(await Promise.all(
            loaded.suite.cases.map((id) =>
              hashTree(join(projectRoot, 'benchmarks/review/cases', id))
            )
          )),
        ].join(':')
      ),
    };
  };
  const initialIdentity = await captureIdentity();
  const execute = dependencies.executeReview ?? executeReview;
  const runs: BenchmarkRun[] = [];
  for (const requestedModel of options.models)
    for (let repeat = 1; repeat <= options.repeat; repeat++)
      for (const id of loaded.suite.cases) {
        const fixture = await loadBenchmarkCase(projectRoot, id);
        const caseRoot = join(projectRoot, 'benchmarks/review/cases', id);
        const caseYaml = await readFile(join(caseRoot, 'case.yaml'));
        let evidence: Buffer | undefined;
        if (loaded.suite.focus) {
          await loadBenchmarkEvidence(projectRoot, id);
          evidence = await readFile(join(caseRoot, 'evidence.yaml'));
        }
        const patchText = await readFile(join(caseRoot, 'change.patch'), 'utf8');
        const baseHash = await hashTree(join(caseRoot, 'base'));
        const workspace = await mkdtemp(join(tmpdir(), 'drs-calibration-'));
        const started = Date.now();
        try {
          await cp(join(caseRoot, 'base'), workspace, { recursive: true });
          const overridePath = join(workspace, '.drs/agents/review/unified-reviewer');
          await mkdir(overridePath, { recursive: true });
          const configObject = {
            agents: {
              default: { model: requestedModel, thinkingLevel: THINKING_LEVEL },
              overrides: {
                'review/unified-reviewer': { model: requestedModel, thinkingLevel: THINKING_LEVEL },
              },
            },
            review: {
              agent: 'review/unified-reviewer',
              unified: { model: requestedModel },
              describe: { enabled: false },
            },
          };
          const isolatedConfig = YAML.stringify(configObject);
          await writeFile(join(overridePath, 'agent.md'), agentText);
          await writeFile(join(workspace, '.drs/drs.config.yaml'), isolatedConfig);
          const git = simpleGit(workspace);
          await git.init();
          await git.addConfig('user.name', 'Calibration Runner');
          await git.addConfig('user.email', 'calibration@invalid');
          await git.add('.');
          await git.commit('base snapshot');
          await writeFile(join(workspace, '.change.patch'), patchText);
          await git.raw(['apply', '.change.patch']);
          await rm(join(workspace, '.change.patch'));
          const diffText = await git.diff();
          const parsed = parseDiff(diffText);
          const config = loadConfig(workspace, configObject as unknown as Partial<DRSConfig>);
          if (getUnifiedModelOverride(config)['review/unified-reviewer'] !== requestedModel)
            throw new Error('Programmatic model override did not resolve exactly.');
          const source: ReviewSource = {
            name: 'Calibration case',
            files: getChangedFiles(parsed),
            filesWithDiffs: getFilesWithDiffs(parsed),
            context: {},
            workingDir: workspace,
            thinkingLevel: THINKING_LEVEL,
          };
          await dependencies.onWorkspaceReady?.(workspace, config, source);
          let result: ReviewResult | undefined;
          let runtimeError: string | undefined;
          let parserError = false;
          let failedUsage: ReviewUsageSummary | undefined;
          let failedDiagnostics: ReviewIssueParserDiagnostics[] = [];
          try {
            result = await execute(config, source);
          } catch (cause) {
            runtimeError = cause instanceof Error ? cause.message : String(cause);
            if (cause instanceof ReviewAgentExecutionError) {
              parserError = cause.code === 'REVIEW_AGENT_PARSE_ERROR';
              failedUsage = cause.reviewUsage;
              failedDiagnostics = cause.agentResult.parserDiagnostics
                ? [cause.agentResult.parserDiagnostics]
                : [];
            }
          }
          const usage = result?.usage ?? failedUsage;
          const actualModels = [
            ...new Set(
              (usage?.agents ?? [])
                .filter((a) => a.agentType === 'review/unified-reviewer')
                .map((a) => a.model)
                .filter((x): x is string => !!x)
            ),
          ];
          const actualModel = actualModels.length === 1 ? actualModels[0] : null;
          const modelFailure = actualModel !== requestedModel;
          const parserFailure = parserError || (!runtimeError && !structuredSuccess(result));
          const status: BenchmarkStatus =
            modelFailure || (runtimeError && !parserError)
              ? 'runtime/model-failure'
              : parserFailure
                ? 'parser-failure'
                : 'success';
          const ineffective = status !== 'success';
          runs.push({
            caseId: id,
            requestedModel,
            actualModel,
            thinkingLevel: getDefaultThinkingLevel(config) ?? THINKING_LEVEL,
            repeat,
            expectedCount: fixture.expected.length,
            status,
            issues: result?.issues ?? [],
            usage: usage ?? null,
            durationMs: Date.now() - started,
            parserDiagnostics: result?.parserDiagnostics ?? failedDiagnostics,
            hashes: {
              baseTree: baseHash,
              caseYaml: hash(caseYaml),
              ...(evidence ? { evidence: hash(evidence) } : {}),
              patch: hash(patchText),
              appliedDiff: hash(diffText),
              config: hash(isolatedConfig),
              agent: hash(agentText),
            },
            adjudication: adjudicationCandidates(
              fixture.expected,
              result?.issues ?? [],
              ineffective
            ),
            errors: [
              ...(runtimeError ? [runtimeError] : []),
              ...(modelFailure
                ? [
                    `Actual model ${actualModel ?? 'missing'} did not match requested model ${requestedModel}.`,
                  ]
                : []),
            ],
          });
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
  const metrics = Object.fromEntries(
    options.models.map((model) => {
      const selected = runs.filter((r) => r.requestedModel === model);
      const negatives = selected.filter((r) => r.expectedCount === 0);
      const success = selected.filter((r) => r.status === 'success');
      return [
        model,
        {
          runCount: selected.length,
          caseCount: new Set(selected.map((r) => r.caseId)).size,
          failureCount: selected.length - success.length,
          runtimeProviderSuccessRate:
            selected.filter((r) => r.status !== 'runtime/model-failure').length / selected.length,
          structuredOutputSuccessRate: success.length / selected.length,
          negativeCleanPassRate: negatives.length
            ? negatives.filter((r) => r.status === 'success' && r.issues.length === 0).length /
              negatives.length
            : null,
          ratesAre: 'run-level',
          recall: 'pending-adjudication',
          precision: 'pending-adjudication',
        },
      ];
    })
  );
  const primaryModel = options.models[0];
  const primaryRuns = runs.filter((run) => run.requestedModel === primaryModel);
  const successfulRuns = primaryRuns.filter((run) => run.status === 'success');
  const negativeRuns = primaryRuns.filter((run) => run.expectedCount === 0);
  const drsMetrics = {
    executionModel: primaryModel,
    runCount: primaryRuns.length,
    caseCount: new Set(primaryRuns.map((run) => run.caseId)).size,
    pipelineSuccessRate: successfulRuns.length / primaryRuns.length,
    cleanCasePassRate: negativeRuns.length
      ? negativeRuns.filter((run) => run.status === 'success' && run.issues.length === 0).length /
        negativeRuns.length
      : null,
    recall: 'pending-adjudication',
    precision: 'pending-adjudication',
    note: 'Primary DRS pipeline metrics. Model breakdowns are secondary diagnostics.',
  };
  const finalIdentity = await captureIdentity();
  if (JSON.stringify(finalIdentity) !== JSON.stringify(initialIdentity))
    throw new Error('DRS source or benchmark suite changed during execution; discarding report.');
  const { revision, dirty, agentHash, sourceSnapshotHash, suiteHash } = initialIdentity;
  const report = {
    schemaVersion: 2,
    suite: loaded.suite.name,
    suiteHash,
    systemUnderTest: {
      name: 'DRS review system',
      focus: loaded.suite.focus ?? 'drs-review-system',
      primaryDimensions: [
        'review-code',
        'review-prompt',
        'context-and-tool-use',
        'structured-output-pipeline',
      ],
      revision,
      dirty,
      sourceSnapshotHash,
      agentHash,
    },
    profile: options.profile,
    models: options.models,
    repeat: options.repeat,
    thinkingLevel: THINKING_LEVEL,
    drsMetrics,
    metricsByModel: metrics,
    runs,
  };
  const output = resolveWithin(projectRoot, options.output, 'Output');
  await mkdir(output, { recursive: true });
  const configHash = hash(`isolated-v1:${THINKING_LEVEL}`).slice(0, 8);
  const shortAgentHash = agentHash.slice(0, 8);
  const modelListHash = hash(JSON.stringify(options.models)).slice(0, 8);
  const base = `${loaded.suite.name}-${options.profile}-r${options.repeat}-s${suiteHash.slice(0, 8)}-d${sourceSnapshotHash.slice(0, 8)}-c${configHash}-a${shortAgentHash}-m${modelListHash}`;
  const jsonPath = join(output, `${base}.json`);
  const markdownPath = join(output, `${base}.md`);
  try {
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    throw new Error(`Refusing to overwrite benchmark output: ${jsonPath}`, { cause: error });
  }
  try {
    const rows = runs
      .map(
        (r) =>
          `| ${r.caseId} | ${r.requestedModel} | ${r.repeat} | ${r.status} | ${r.issues.length} |`
      )
      .join('\n');
    await writeFile(
      markdownPath,
      `# DRS review-system regression: ${loaded.suite.name}\n\nPrimary system under test: **DRS review code, prompt, context/tool behavior, and structured-output pipeline**.  \nRevision: \`${revision}${dirty ? ' (dirty)' : ''}\`  \nSource snapshot: \`${sourceSnapshotHash}\`  \nPinned execution model: \`${primaryModel}\`  \nThinking: ${THINKING_LEVEL}  \nAdditional model breakdowns are secondary diagnostics. Recall/precision: **pending manual adjudication**.\n\n## DRS pipeline\n\n- Pipeline success: ${successfulRuns.length}/${primaryRuns.length}\n- Clean-case passes: ${negativeRuns.filter((run) => run.status === 'success' && run.issues.length === 0).length}/${negativeRuns.length}\n\n| Case | Execution model | Repeat | Pipeline status | Issues |\n|---|---|---:|---|---:|\n${rows}\n`,
      { flag: 'wx' }
    );
  } catch (error) {
    await rm(jsonPath, { force: true });
    throw new Error(`Refusing to overwrite benchmark output: ${markdownPath}`, { cause: error });
  }
  return { jsonPath, markdownPath, report };
}
