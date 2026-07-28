import { createHash } from 'crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import YAML from 'yaml';
import simpleGit from 'simple-git';
import {
  getDefaultThinkingLevel,
  getUnifiedModelOverride,
  loadConfig,
  resolveAgentSkills,
  type DRSConfig,
} from './config.js';
import { parseDiff, getChangedFiles, getFilesWithDiffs } from './diff-parser.js';
import { executeReview, type ReviewResult, type ReviewSource } from './review-orchestrator.js';
import { ReviewAgentExecutionError } from './review-core.js';
import type { ReviewIssueParserDiagnostics } from './issue-parser.js';
import type { ReviewUsageSummary } from './review-usage.js';
import { TraceCollector, type AgentTrace } from './trace-collector.js';
import { loadAgents } from '../runtime/agent-loader.js';
import { resolveAgentPaths } from '../runtime/path-config.js';

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
  comparison?: { group: string; variant: string };
  capabilities?: {
    contextSources?: string[];
    requiredSkills?: string[];
    expectedNotLoadedSkills?: string[];
    requiredInspectionPaths?: string[];
  };
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
  comparison?: BenchmarkCase['comparison'];
  capabilities: CapabilityObservation;
}

export interface CapabilityObservation {
  configuredSkills: string[];
  availableSkills: string[];
  loadedSkills: string[];
  contextSources: Array<{ path: string; sha256: string; applied: boolean }>;
  toolCalls: Record<string, number>;
  inspectedPaths: string[];
  requiredSkillConfiguration: Record<string, boolean>;
  requiredSkillAvailability: Record<string, boolean>;
  requiredSkillActivation: Record<string, boolean>;
  expectedNotLoadedResults: Record<string, boolean>;
  expectedNotLoadedViolations: string[];
  requiredInspectionCoverage: Record<string, boolean>;
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
  if (parsed.comparison !== undefined) {
    assertObject(parsed.comparison, `Comparison in ${id}`);
    if (
      !SLUG.test(String(parsed.comparison.group)) ||
      !SLUG.test(String(parsed.comparison.variant))
    )
      throw new Error(`Invalid comparison in ${id}.`);
  }
  if (parsed.capabilities !== undefined) {
    assertObject(parsed.capabilities, `Capabilities in ${id}`);
    const base = join(root, 'benchmarks/review/cases', id, 'base');
    const capability = parsed.capabilities;
    for (const key of [
      'contextSources',
      'requiredSkills',
      'expectedNotLoadedSkills',
      'requiredInspectionPaths',
    ] as const) {
      const values = capability[key];
      if (values === undefined) continue;
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== 'string') ||
        new Set(values).size !== values.length
      )
        throw new Error(`Invalid or duplicate ${key} in ${id}.`);
      for (const value of values) {
        if (key.includes('Skills')) {
          if (!SLUG.test(value)) throw new Error(`Unsafe skill in ${id}.`);
        } else safeRelative(value, `${key} in ${id}`);
      }
    }
    for (const path of (capability.contextSources as string[] | undefined) ?? [])
      await stat(resolveWithin(base, path, 'Context source'));
    for (const path of (capability.requiredInspectionPaths as string[] | undefined) ?? [])
      await stat(resolveWithin(base, path, 'Inspection path'));
    const skillNames = [
      ...((capability.requiredSkills as string[] | undefined) ?? []),
      ...((capability.expectedNotLoadedSkills as string[] | undefined) ?? []),
    ];
    let skillDirectories = ['.drs/skills', '.agents/skills', '.pi/skills'];
    const fixtureConfigPath = join(base, '.drs/drs.config.yaml');
    if (existsSync(fixtureConfigPath)) {
      const config = sanitizeFixtureConfig(YAML.parse(await readFile(fixtureConfigPath, 'utf8')));
      const configuredPath = (
        (config.agents as Record<string, unknown> | undefined)?.paths as
          | Record<string, unknown>
          | undefined
      )?.skills;
      if (typeof configuredPath === 'string') skillDirectories = [configuredPath];
    }
    for (const skill of skillNames) {
      const candidates = skillDirectories.map((dir) => join(base, dir, skill, 'SKILL.md'));
      if (
        !(
          await Promise.all(
            candidates.map(async (path) =>
              stat(path).then(
                () => true,
                () => false
              )
            )
          )
        ).some(Boolean)
      )
        throw new Error(`Declared skill ${skill} does not exist in ${id}.`);
    }
  }
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

function collectAvailableSkills(workspace: string, searchPaths?: string[]): string[] {
  const names = new Set<string>();
  const parents =
    searchPaths ??
    ['.drs/skills', '.agents/skills', '.pi/skills'].map((path) => join(workspace, path));
  for (const parent of parents) {
    try {
      for (const name of readdirSync(parent))
        if (existsSync(join(parent, name, 'SKILL.md'))) names.add(name);
    } catch {
      /* absent search path */
    }
  }
  return [...names].sort();
}

export function summarizeBenchmarkCapabilities(
  fixture: Pick<BenchmarkCase, 'capabilities'>,
  workspace: string,
  usage: ReviewUsageSummary | undefined,
  traces: AgentTrace[],
  configured: string[] = [],
  skillSearchPaths?: string[]
): CapabilityObservation {
  const declared = fixture.capabilities ?? {};
  const configuredSkills = [...new Set(configured)].sort();
  const reviewerTraces = traces.filter(
    (trace) => trace.agentId === 'review/unified-reviewer' || !trace.agentId
  );
  const appliedContextSources = new Set(
    (usage?.agents ?? [])
      .filter((agent) => agent.agentType === 'review/unified-reviewer')
      .flatMap((agent) => agent.contextSources ?? [])
  );
  const searchPaths =
    skillSearchPaths ??
    ['.drs/skills', '.agents/skills', '.pi/skills'].map((path) => join(workspace, path));
  const availableSkills = collectAvailableSkills(workspace, searchPaths);
  const workspaceFile = (value: unknown): { absolute: string; relative: string } | undefined => {
    if (typeof value !== 'string') return undefined;
    const absolute = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
    const rel = relative(resolve(workspace), absolute).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute)) return undefined;
    try {
      return statSync(absolute).isFile() ? { absolute, relative: rel } : undefined;
    } catch {
      return undefined;
    }
  };
  const loadedSkillNames = new Set<string>();
  for (const trace of reviewerTraces)
    for (const turn of trace.turns)
      for (const call of turn.toolCalls) {
        if (call.isError || !call.args || typeof call.args !== 'object') continue;
        const args = call.args as Record<string, unknown>;
        if (call.toolName.toLowerCase() === 'read') {
          const file = workspaceFile(args.path ?? args.filePath ?? args.file_path);
          if (!file) continue;
          for (const root of searchPaths) {
            const skillPath = relative(resolve(root), file.absolute).replaceAll('\\', '/');
            const [skill, filename, ...rest] = skillPath.split('/');
            if (
              rest.length === 0 &&
              filename?.toLowerCase() === 'skill.md' &&
              configuredSkills.includes(skill) &&
              availableSkills.includes(skill)
            )
              loadedSkillNames.add(skill);
          }
        } else if (call.toolName.toLowerCase() === 'skill') {
          const skill = args.skill ?? args.name ?? args.skillName;
          if (
            typeof skill === 'string' &&
            configuredSkills.includes(skill) &&
            availableSkills.includes(skill)
          )
            loadedSkillNames.add(skill);
        }
      }
  const loadedSkills = [...loadedSkillNames].sort();
  const toolCalls: Record<string, number> = {};
  for (const trace of reviewerTraces)
    for (const turn of trace.turns)
      for (const call of turn.toolCalls)
        toolCalls[call.toolName] = (toolCalls[call.toolName] ?? 0) + 1;
  for (const agent of (usage?.agents ?? []).filter(
    (candidate) => candidate.agentType === 'review/unified-reviewer'
  ))
    for (const [name, count] of Object.entries(agent.toolCalls ?? {}))
      toolCalls[name] = Math.max(toolCalls[name] ?? 0, count);
  const requiredPaths = declared.requiredInspectionPaths ?? [];
  const pathCandidates = new Set<string>();
  const addInspectionPath = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(addInspectionPath);
    const file = workspaceFile(value);
    if (file) pathCandidates.add(file.relative);
  };
  for (const trace of reviewerTraces)
    for (const turn of trace.turns)
      for (const call of turn.toolCalls) {
        if (call.isError || !call.args || typeof call.args !== 'object') continue;
        const args = call.args as Record<string, unknown>;
        switch (call.toolName.toLowerCase()) {
          case 'read':
            addInspectionPath(args.path ?? args.filePath ?? args.file_path);
            break;
          case 'grep':
            addInspectionPath(args.path);
            break;
          case 'git_diff':
            addInspectionPath(args.path ?? args.paths ?? args.file ?? args.files);
            break;
        }
      }
  const inspectedPaths = [...pathCandidates].sort();
  return {
    configuredSkills,
    availableSkills,
    loadedSkills,
    contextSources: (declared.contextSources ?? []).map((path) => ({
      path,
      sha256: hash(readFileSync(join(workspace, path))),
      applied: appliedContextSources.has(path),
    })),
    toolCalls: Object.fromEntries(Object.entries(toolCalls).sort()),
    inspectedPaths,
    requiredSkillConfiguration: Object.fromEntries(
      (declared.requiredSkills ?? []).map((skill) => [skill, configuredSkills.includes(skill)])
    ),
    requiredSkillAvailability: Object.fromEntries(
      (declared.requiredSkills ?? []).map((skill) => [skill, availableSkills.includes(skill)])
    ),
    requiredSkillActivation: Object.fromEntries(
      (declared.requiredSkills ?? []).map((skill) => [skill, loadedSkills.includes(skill)])
    ),
    expectedNotLoadedResults: Object.fromEntries(
      (declared.expectedNotLoadedSkills ?? []).map((skill) => [
        skill,
        !loadedSkills.includes(skill),
      ])
    ),
    expectedNotLoadedViolations: (declared.expectedNotLoadedSkills ?? []).filter((skill) =>
      loadedSkills.includes(skill)
    ),
    requiredInspectionCoverage: Object.fromEntries(
      requiredPaths.map((path) => [path, inspectedPaths.includes(path)])
    ),
  };
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

function mergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
      const left = base[key];
      const right = override[key];
      const value =
        left &&
        right &&
        typeof left === 'object' &&
        typeof right === 'object' &&
        !Array.isArray(left) &&
        !Array.isArray(right)
          ? mergeRecords(left as Record<string, unknown>, right as Record<string, unknown>)
          : right !== undefined
            ? right
            : left;
      return [key, value];
    })
  );
}

function sanitizeFixtureConfig(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  assertObject(value, 'Fixture DRS config');
  const unexpectedTopLevel = Object.keys(value).filter(
    (key) => !['agents', 'review'].includes(key)
  );
  if (unexpectedTopLevel.length)
    throw new Error(`Unsupported benchmark fixture config: ${unexpectedTopLevel.join(', ')}.`);

  const result: Record<string, unknown> = {};
  if (value.agents !== undefined) {
    assertObject(value.agents, 'Fixture agents config');
    const agents = value.agents;
    const unexpected = Object.keys(agents).filter(
      (key) => !['paths', 'default', 'namespaces', 'overrides'].includes(key)
    );
    if (unexpected.length)
      throw new Error(`Unsupported benchmark fixture agents config: ${unexpected.join(', ')}.`);

    const sanitizeSkillSettings = (settings: unknown, label: string): Record<string, unknown> => {
      assertObject(settings, label);
      const invalid = Object.keys(settings).filter(
        (key) => !['skills', 'skillsPromptFormat'].includes(key)
      );
      if (invalid.length) throw new Error(`Unsupported ${label}: ${invalid.join(', ')}.`);
      if (
        settings.skills !== undefined &&
        (!Array.isArray(settings.skills) ||
          settings.skills.some((skill) => typeof skill !== 'string' || !SLUG.test(skill)))
      )
        throw new Error(`${label}.skills must contain safe skill names.`);
      if (
        settings.skillsPromptFormat !== undefined &&
        (typeof settings.skillsPromptFormat !== 'string' ||
          !['text', 'xml'].includes(settings.skillsPromptFormat))
      )
        throw new Error(`${label}.skillsPromptFormat must be text or xml.`);
      return settings;
    };

    const sanitizedAgents: Record<string, unknown> = {};
    if (agents.paths !== undefined) {
      assertObject(agents.paths, 'Fixture agent paths');
      if (Object.keys(agents.paths).some((key) => key !== 'skills'))
        throw new Error('Benchmark fixtures may only customize agents.paths.skills.');
      if (typeof agents.paths.skills !== 'string')
        throw new Error('Fixture agents.paths.skills must be a relative path.');
      safeRelative(agents.paths.skills, 'Fixture agents.paths.skills');
      sanitizedAgents.paths = { skills: agents.paths.skills };
    }
    if (agents.default !== undefined)
      sanitizedAgents.default = sanitizeSkillSettings(agents.default, 'fixture agents.default');
    for (const section of ['namespaces', 'overrides'] as const) {
      if (agents[section] === undefined) continue;
      assertObject(agents[section], `Fixture agents.${section}`);
      const allowed = section === 'namespaces' ? 'review' : 'review/unified-reviewer';
      if (Object.keys(agents[section]).some((key) => key !== allowed))
        throw new Error(`Fixture agents.${section} may only configure ${allowed}.`);
      sanitizedAgents[section] = {
        [allowed]: sanitizeSkillSettings(
          agents[section][allowed],
          `fixture agents.${section}.${allowed}`
        ),
      };
    }
    result.agents = sanitizedAgents;
  }
  if (value.review !== undefined) {
    assertObject(value.review, 'Fixture review config');
    const invalid = Object.keys(value.review).filter(
      (key) => !['ignorePatterns', 'includePatterns'].includes(key)
    );
    if (invalid.length)
      throw new Error(`Unsupported fixture review config: ${invalid.join(', ')}.`);
    for (const key of ['ignorePatterns', 'includePatterns'] as const)
      if (
        value.review[key] !== undefined &&
        (!Array.isArray(value.review[key]) ||
          value.review[key].some((pattern) => typeof pattern !== 'string'))
      )
        throw new Error(`Fixture review.${key} must be a string array.`);
    result.review = value.review;
  }
  return result;
}

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
  const captureIdentity = async () => {
    const git = simpleGit(projectRoot);
    const agentHash = hash(await readFile(agentSource));
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
          await mkdir(join(workspace, '.drs'), { recursive: true });
          const fixtureConfigPath = join(workspace, '.drs/drs.config.yaml');
          const fixtureConfig = existsSync(fixtureConfigPath)
            ? sanitizeFixtureConfig(YAML.parse(await readFile(fixtureConfigPath, 'utf8')))
            : {};
          const forcedConfig = {
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
          const configObject = mergeRecords(fixtureConfig, forcedConfig);
          const isolatedConfig = YAML.stringify(configObject);
          await writeFile(fixtureConfigPath, isolatedConfig);
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
          const config = loadConfig(workspace, configObject);
          if (getUnifiedModelOverride(config)['review/unified-reviewer'] !== requestedModel)
            throw new Error('Programmatic model override did not resolve exactly.');
          const reviewer = loadAgents(workspace, config).find(
            (agent) => agent.id === 'review/unified-reviewer'
          );
          if (
            !reviewer ||
            (await realpath(reviewer.path)) !== (await realpath(agentSource)) ||
            hash(await readFile(reviewer.path)) !== initialIdentity.agentHash
          )
            throw new Error('Benchmark reviewer did not resolve to the pinned packaged agent.');
          const traceCollector = new TraceCollector();
          traceCollector.setContext('benchmark-review', reviewer.id, '');
          const source: ReviewSource = {
            name: 'Calibration case',
            files: getChangedFiles(parsed),
            filesWithDiffs: getFilesWithDiffs(parsed),
            context: { traceCollector },
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
              agent: initialIdentity.agentHash,
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
            comparison: fixture.comparison,
            capabilities: summarizeBenchmarkCapabilities(
              fixture,
              workspace,
              usage,
              traceCollector.getTraces(),
              resolveAgentSkills(config, reviewer.id, reviewer.skills ?? []),
              resolveAgentPaths(workspace, config).skillSearchPaths
            ),
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
  const rate = (checks: boolean[]): number | null =>
    checks.length ? checks.filter(Boolean).length / checks.length : null;
  const summarizeCapabilityMetrics = (selected: BenchmarkRun[]) => ({
    contextApplicationRate: rate(
      selected.flatMap((run) => run.capabilities.contextSources.map((source) => source.applied))
    ),
    requiredSkillConfigurationRate: rate(
      selected.flatMap((run) => Object.values(run.capabilities.requiredSkillConfiguration))
    ),
    requiredSkillAvailabilityRate: rate(
      selected.flatMap((run) => Object.values(run.capabilities.requiredSkillAvailability))
    ),
    requiredSkillActivationRate: rate(
      selected.flatMap((run) => Object.values(run.capabilities.requiredSkillActivation))
    ),
    requiredInspectionCoverageRate: rate(
      selected.flatMap((run) => Object.values(run.capabilities.requiredInspectionCoverage))
    ),
    expectedNotLoadedCleanRate: rate(
      selected.flatMap((run) => Object.values(run.capabilities.expectedNotLoadedResults))
    ),
  });
  const capabilityMetrics = summarizeCapabilityMetrics(primaryRuns);
  const capabilityMetricsByModel = Object.fromEntries(
    options.models.map((model) => [
      model,
      summarizeCapabilityMetrics(runs.filter((run) => run.requestedModel === model)),
    ])
  );
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
    schemaVersion: 3,
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
    capabilityMetrics,
    capabilityMetricsByModel,
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
    const displayRate = (value: number | null): string =>
      value === null ? 'n/a' : `${Math.round(value * 100)}%`;
    await writeFile(
      markdownPath,
      `# DRS review-system regression: ${loaded.suite.name}\n\nPrimary system under test: **DRS review code, prompt, context/tool behavior, and structured-output pipeline**.  \nRevision: \`${revision}${dirty ? ' (dirty)' : ''}\`  \nSource snapshot: \`${sourceSnapshotHash}\`  \nPinned execution model: \`${primaryModel}\`  \nThinking: ${THINKING_LEVEL}  \nAdditional model breakdowns are secondary diagnostics. Recall/precision: **pending manual adjudication**.\n\n## DRS pipeline\n\n- Pipeline success: ${successfulRuns.length}/${primaryRuns.length}\n- Clean-case passes: ${negativeRuns.filter((run) => run.status === 'success' && run.issues.length === 0).length}/${negativeRuns.length}\n\n## Capability behavior\n\n- Context application: ${displayRate(capabilityMetrics.contextApplicationRate)}\n- Required skill configuration: ${displayRate(capabilityMetrics.requiredSkillConfigurationRate)}\n- Required skill availability: ${displayRate(capabilityMetrics.requiredSkillAvailabilityRate)}\n- Required skill activation: ${displayRate(capabilityMetrics.requiredSkillActivationRate)}\n- Required inspection coverage: ${displayRate(capabilityMetrics.requiredInspectionCoverageRate)}\n- Irrelevant skill avoidance: ${displayRate(capabilityMetrics.expectedNotLoadedCleanRate)}\n\n| Case | Execution model | Repeat | Pipeline status | Issues |\n|---|---|---:|---|---:|\n${rows}\n`,
      { flag: 'wx' }
    );
  } catch (error) {
    await rm(jsonPath, { force: true });
    throw new Error(`Refusing to overwrite benchmark output: ${markdownPath}`, { cause: error });
  }
  return { jsonPath, markdownPath, report };
}
