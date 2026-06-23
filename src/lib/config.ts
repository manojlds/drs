import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { basename, extname, join, resolve } from 'path';
import * as yaml from 'yaml';
import { requireAgentId } from './agent-id.js';
import { getBuiltInWorkflowPaths } from '../runtime/built-in-paths.js';

// Canonical list of supported workflow actions. WorkflowNodeConfig['action']
// derives its union from this tuple so the schema and the load-time validator
// can never drift. Keep both this tuple and the validator in lockstep.
export const SUPPORTED_WORKFLOW_ACTIONS = [
  'write',
  'git-diff',
  'git-add',
  'git-branch',
  'git-commit',
  'git-push',
  'has-diff',
  'stack-guard',
  'review-threshold',
  'save-artifact',
  'load-artifact',
  'artifact-exists',
  'create-review-artifact',
  'review-artifact-status',
  'review-artifact-add-finding',
  'review-artifact-update-findings',
  'verify-fix',
  'review-artifact-promote-finding',
  'review-artifact-resolve-finding',
  'create-change-request',
  'create-pr',
  'create-mr',
  'change-source',
  'review',
  'review-context',
  'describe',
  'code-quality-report',
  'post-comment',
  'post-review-comments',
  'post-fix-status',
] as const;

export type WorkflowAction = (typeof SUPPORTED_WORKFLOW_ACTIONS)[number];

/**
 * Agent reference - supports both simple string and detailed object format.
 * Agent names are fully qualified ids like "review/security" or "task/docs-updater".
 */
export interface AgentConfig {
  name: string;
  model?: string;
  skills?: string[];
}

export interface AgentRunConfig {
  prompt?: string;
  promptFile?: string;
  output?: string;
  json?: boolean;
}

export type WorkflowInputConfig =
  | string
  | {
      type?: 'string' | 'boolean' | 'number' | 'enum';
      value?: string;
      file?: string;
      default?: string | number | boolean;
      required?: boolean;
      values?: Array<string | number | boolean>;
      description?: string;
    };

export type WorkflowControl = 'loop' | 'switch' | 'end' | 'passThrough';

export interface WorkflowNodeConfig {
  /** Agent id to run, for example "task/docs-updater". */
  agent?: string;
  /** Config path resolving to an agent list. Currently supports "review.agents". */
  agentsFrom?: string;
  /** Built-in workflow control node. */
  control?: WorkflowControl;
  /** Built-in workflow action. */
  action?: WorkflowAction;
  /** Action-specific options. */
  with?: Record<string, string | number | boolean | undefined>;
  /** Node ids that must complete before this node starts. */
  needs?: string[];
  /** Expression evaluated before running executable nodes. */
  if?: string;
  /** Alias for if on executable and loop nodes. */
  condition?: string;
  /** Target node when a loop continues. */
  target?: string;
  /** Target node when a loop exits. */
  exit?: string;
  /** Maximum loop iterations before failing or exiting. */
  maxIterations?: string | number;
  /** Behavior when maxIterations is reached. Defaults to fail. */
  onMaxIterations?: 'fail' | 'exit';
  /** Value expression for switch control nodes. */
  value?: string;
  /** Switch case target map. */
  cases?: Record<string, string>;
  /** Default target for switch control nodes. */
  default?: string;
  /** Prompt/content template. Supports {{inputs.key}}, {{nodes.id.response}}, and {{artifacts.key}}. */
  input?: string;
  /** Artifact name to expose this node's primary output as. */
  output?: string;
  /** Repo-relative path written by agent output or write action. */
  writes?: string;
  /** Emit JSON for an agent node when writing to a file. */
  json?: boolean;
}

export interface WorkflowConfig {
  description?: string;
  inputs?: Record<string, WorkflowInputConfig>;
  /** Artifact key to expose as the workflow output. Defaults to the last node output. */
  output?: string;
  nodes: Record<string, WorkflowNodeConfig>;
}

export type WorkflowSource = 'packaged' | 'project';

export interface AgentDefaultsConfig {
  model?: string;
  skills?: string[];
  skillsPromptFormat?: 'text' | 'xml';
  thinkingLevel?: string;
  tools?: Record<string, boolean>;
  run?: AgentRunConfig;
}

export interface AgentsConfig {
  /** Custom search paths for project agent and skill definitions. */
  paths?: {
    agents?: string;
    skills?: string;
  };
  /** Defaults applied to all agents unless a namespace or agent override is present. */
  default?: AgentDefaultsConfig;
  /** Per-namespace defaults. Keys are namespaces like "review" or "describe". */
  namespaces?: Record<string, AgentDefaultsConfig>;
  /** Per-agent overrides. Keys are fully qualified ids like "review/security". */
  overrides?: Record<string, AgentDefaultsConfig>;
}

/**
 * Model override mapping from agent name to model identifier
 */
export type ModelOverrides = Record<string, string>;

/**
 * Token pricing in USD per 1M tokens.
 */
export interface ModelPricingConfig {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface OpenAICompatibilityConfig {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
  thinkingFormat?: 'openai' | 'zai' | 'qwen';
  reasoningEffortMap?: Partial<Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', string>>;
  openRouterRouting?: {
    only?: string[];
    order?: string[];
    fallbacks?: string[];
  };
  vercelGatewayRouting?: {
    only?: string[];
    order?: string[];
  };
  supportsStrictMode?: boolean;
  [key: string]: unknown;
}

export interface CustomProviderModelConfig {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  cost?: ModelPricingConfig;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: OpenAICompatibilityConfig;
}

/**
 * Legacy model map entry format (keyed by model id in YAML).
 * Kept for backward compatibility with older DRS config files.
 */
export interface LegacyCustomProviderModelConfig {
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  cost?: ModelPricingConfig;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: OpenAICompatibilityConfig;
}

/**
 * Custom provider configuration (Pi models.json-compatible).
 *
 * Also supports legacy DRS fields (`options.baseURL`, `options.apiKey`, map-based models)
 * for backward compatibility.
 */
export interface CustomProvider {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  /**
   * Optional OpenAI compatibility defaults applied to all models in this provider.
   * Per-model compat values take precedence.
   */
  compat?: OpenAICompatibilityConfig;
  models?: CustomProviderModelConfig[] | Record<string, LegacyCustomProviderModelConfig>;

  // Legacy compatibility fields (deprecated)
  npm?: string;
  name?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
  };
}

export interface RuntimeConfig {
  [key: string]: unknown;
  provider?: Record<string, CustomProvider>;
  runtime?: {
    operationTimeoutMs?: number;
    streamTimeoutMs?: number;
    streamPollIntervalMs?: number;
  };
  retry?: {
    provider?: {
      timeoutMs?: number;
      maxRetries?: number;
      maxRetryDelayMs?: number;
    };
  };
}

export interface DRSConfig {
  // Pi runtime configuration
  pi: RuntimeConfig;

  // Generic agent configuration shared by review, describe, and task agents
  agents: AgentsConfig;

  // Effective workflow/DAG definitions loaded from workflow files.
  workflows?: Record<string, WorkflowConfig>;

  // Workflow run defaults and project-level workflow selection.
  workflow?: {
    default?: string;
  };

  /**
   * @deprecated Use `pi` instead. Kept as a compatibility alias for legacy configs.
   */
  opencode?: RuntimeConfig;

  // GitLab configuration
  gitlab: {
    url: string;
    token: string;
  };

  // GitHub configuration
  github: {
    token: string;
  };

  // Review behavior
  review: {
    agents: (string | AgentConfig)[];
    ignorePatterns: string[];
    includePatterns?: string[];
    unified?: {
      model?: string;
    };
    describe?: {
      enabled?: boolean;
    };
    cursorFixLinks?: {
      enabled?: boolean;
      /** Optional Cursor workspace/folder name used to route the deeplink. */
      workspace?: string;
    };
    skipRepoCheck?: boolean;
    skipBranchCheck?: boolean;
  };

  // Describe behavior (PR/MR description generation)
  describe?: {
    model?: string;
    includeProjectContext?: boolean;
  };

  // Context compression (diff size management)
  contextCompression?: {
    enabled?: boolean;
    maxTokens?: number;
    thresholdPercent?: number;
    softBufferTokens?: number;
    hardBufferTokens?: number;
    tokenEstimateDivisor?: number;
    summaryThresholdMultiplier?: number;
  };

  // Optional per-model pricing overrides in USD per 1M tokens.
  // Used when runtime-reported cost is missing/zero for a model.
  pricing?: {
    models?: Record<string, ModelPricingConfig>;
  };

  // Fix pipeline configuration (review-issue-fixer agent)
  fix?: FixConfig;
}

export interface FixCheckConfig {
  name: string;
  command: string;
  matchPaths?: string[];
  timeoutMs?: number;
}

export interface FixConfig {
  checks?: FixCheckConfig[];
}

const DEFAULT_CONFIG: DRSConfig = {
  pi: {},
  agents: {
    default: {
      model: getDefaultModelEnv() ?? 'anthropic/claude-sonnet-4-5-20250929',
      skills: [],
    },
  },
  gitlab: {
    url: process.env.GITLAB_URL ?? 'https://gitlab.com',
    token: process.env.GITLAB_TOKEN ?? '',
  },
  github: {
    token: process.env.GITHUB_TOKEN ?? '',
  },
  review: {
    agents: ['review/unified-reviewer'],
    ignorePatterns: [
      '*.test.ts',
      '*.spec.ts',
      '**/__tests__/**',
      '**/__mocks__/**',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ],
    describe: {
      enabled: false,
    },
    cursorFixLinks: {
      enabled: false,
    },
  },
  contextCompression: {
    enabled: true,
    maxTokens: 32000,
    thresholdPercent: 0.15,
    softBufferTokens: 1500,
    hardBufferTokens: 1000,
    tokenEstimateDivisor: 4,
    summaryThresholdMultiplier: 3,
  },
  describe: {
    includeProjectContext: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowFileName(fileName: string): boolean {
  return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
}

const SUPPORTED_ACTION_SET: ReadonlySet<string> = new Set(SUPPORTED_WORKFLOW_ACTIONS);

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    const tmp = previous;
    previous = current;
    current = tmp;
  }
  return previous[b.length];
}

function findClosestSupportedAction(input: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  // Cap at two edits so we never suggest a long action for a shorter typo.
  const threshold = 2;
  for (const supported of SUPPORTED_WORKFLOW_ACTIONS) {
    const distance = levenshteinDistance(input, supported);
    if (distance < bestDistance && distance <= threshold) {
      best = supported;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Validate every node's `action` value in a workflow against
 * SUPPORTED_WORKFLOW_ACTIONS. Throws with a did-you-mean hint on failure:
 *   - Near-miss typos get the closest supported action via Levenshtein.
 *   - Wholly unknown actions get a list of every supported action.
 *
 * Called from validateWorkflowDefinition so misconfigured YAML fails fast at
 * config-load time instead of partway through wave execution.
 */
export function validateWorkflowActions(
  workflowName: string,
  nodes: Record<string, WorkflowNodeConfig>
): void {
  for (const [nodeId, node] of Object.entries(nodes)) {
    const action = node.action;
    if (typeof action !== 'string') continue;
    if (SUPPORTED_ACTION_SET.has(action)) continue;

    let hint: string;
    const closest = findClosestSupportedAction(action);
    if (closest) {
      hint = "Did you mean '" + closest + "'?";
    } else {
      hint = 'Supported actions: ' + SUPPORTED_WORKFLOW_ACTIONS.join(', ') + '.';
    }
    throw new Error(
      'Workflow "' +
        workflowName +
        '" node "' +
        nodeId +
        '" has unsupported action "' +
        action +
        '". ' +
        hint
    );
  }
}

function validateWorkflowInputs(workflowName: string, inputs: unknown): void {
  if (inputs === undefined) return;
  if (!isRecord(inputs)) {
    throw new Error(`Workflow "${workflowName}" inputs must be an object.`);
  }

  for (const [inputName, input] of Object.entries(inputs)) {
    if (typeof input === 'string') continue;
    if (!isRecord(input)) {
      throw new Error(
        `Workflow "${workflowName}" input "${inputName}" must be a string or object.`
      );
    }

    const allowed = new Set([
      'type',
      'value',
      'file',
      'default',
      'required',
      'values',
      'description',
    ]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `Workflow "${workflowName}" input "${inputName}" has unsupported field(s): ${unknown.join(', ')}.`
      );
    }

    const rawType = input.type;
    if (rawType !== undefined && typeof rawType !== 'string') {
      throw new Error(`Workflow "${workflowName}" input "${inputName}" type must be a string.`);
    }
    const type = rawType ?? 'string';
    if (!['string', 'boolean', 'number', 'enum'].includes(type)) {
      throw new Error(
        `Workflow "${workflowName}" input "${inputName}" has unsupported type "${type}".`
      );
    }
    if (input.file !== undefined && (input.value !== undefined || input.default !== undefined)) {
      throw new Error(
        `Workflow "${workflowName}" input "${inputName}" cannot define file with value/default.`
      );
    }
    if (input.required !== undefined && typeof input.required !== 'boolean') {
      throw new Error(`Workflow "${workflowName}" input "${inputName}" required must be boolean.`);
    }
    if (input.description !== undefined && typeof input.description !== 'string') {
      throw new Error(
        `Workflow "${workflowName}" input "${inputName}" description must be string.`
      );
    }
    if (type === 'enum' && (!Array.isArray(input.values) || input.values.length === 0)) {
      throw new Error(
        `Workflow "${workflowName}" input "${inputName}" type enum must define values.`
      );
    }
  }
}

function validateWorkflowDefinition(
  workflowName: string,
  workflow: unknown,
  sourcePath: string
): WorkflowConfig {
  if (!isRecord(workflow) || !isRecord(workflow.nodes)) {
    throw new Error(`Workflow "${workflowName}" in ${sourcePath} must define a nodes object.`);
  }

  const typed = workflow as unknown as WorkflowConfig;
  validateWorkflowInputs(workflowName, typed.inputs);
  validateWorkflowActions(workflowName, typed.nodes);
  return typed;
}

function loadWorkflowFile(filePath: string): Record<string, WorkflowConfig> {
  const parsed = yaml.parse(readFileSync(filePath, 'utf-8')) ?? {};
  if (!isRecord(parsed)) {
    throw new Error(`Workflow file ${filePath} must contain a YAML object.`);
  }

  if (parsed.workflows !== undefined) {
    throw new Error(`Workflow file ${filePath} must define one workflow directly.`);
  }

  const workflowName =
    parsed.name === undefined ? basename(filePath, extname(filePath)) : parsed.name;
  if (typeof workflowName !== 'string' || !workflowName.trim()) {
    throw new Error(`Workflow file ${filePath} must use a non-empty string name.`);
  }

  const workflow = { ...parsed };
  delete workflow.name;
  return {
    [workflowName.trim()]: validateWorkflowDefinition(workflowName.trim(), workflow, filePath),
  };
}

function loadWorkflowFilesFromDirectory(
  directoryPath: string,
  source: WorkflowSource
): { workflows: Record<string, WorkflowConfig>; sources: Record<string, WorkflowSource> } {
  if (!existsSync(directoryPath)) {
    return { workflows: {}, sources: {} };
  }

  if (!statSync(directoryPath).isDirectory()) {
    throw new Error(`Workflow path ${directoryPath} exists but is not a directory.`);
  }

  const workflows: Record<string, WorkflowConfig> = {};
  const sources: Record<string, WorkflowSource> = {};
  for (const fileName of readdirSync(directoryPath).filter(isWorkflowFileName).sort()) {
    const fileWorkflows = loadWorkflowFile(join(directoryPath, fileName));
    for (const workflowName of Object.keys(fileWorkflows)) {
      sources[workflowName] = source;
    }
    Object.assign(workflows, fileWorkflows);
  }
  return { workflows, sources };
}

function loadBuiltInWorkflowFiles(): {
  workflows: Record<string, WorkflowConfig>;
  sources: Record<string, WorkflowSource>;
} {
  const result: {
    workflows: Record<string, WorkflowConfig>;
    sources: Record<string, WorkflowSource>;
  } = {
    workflows: {},
    sources: {},
  };
  for (const directory of getBuiltInWorkflowPaths()) {
    const loaded = loadWorkflowFilesFromDirectory(directory, 'packaged');
    Object.assign(result.workflows, loaded.workflows);
    Object.assign(result.sources, loaded.sources);
  }
  return result;
}

/**
 * Load map of workflow names to their source origin (packaged or project).
 */
export function loadWorkflowSources(projectPath?: string): Record<string, WorkflowSource> {
  const basePath = projectPath ?? process.cwd();
  const builtIn = loadBuiltInWorkflowFiles();
  const project = loadWorkflowFilesFromDirectory(resolve(basePath, '.drs/workflows'), 'project');

  // Project workflows take precedence, so they override packaged sources.
  return { ...builtIn.sources, ...project.sources };
}

export interface WorkflowSourceInfo {
  source: WorkflowSource;
  overridesPackaged: boolean;
}

/**
 * Load map of workflow names to their source origin, including whether
 * a project workflow is overriding an existing packaged workflow.
 */
export function loadWorkflowSourceInfo(projectPath?: string): Record<string, WorkflowSourceInfo> {
  const basePath = projectPath ?? process.cwd();
  const builtIn = loadBuiltInWorkflowFiles();
  const project = loadWorkflowFilesFromDirectory(resolve(basePath, '.drs/workflows'), 'project');
  const info: Record<string, WorkflowSourceInfo> = {};

  for (const name of Object.keys(builtIn.sources)) {
    info[name] = { source: 'packaged', overridesPackaged: false };
  }

  for (const name of Object.keys(project.sources)) {
    info[name] = { source: 'project', overridesPackaged: name in builtIn.sources };
  }

  return info;
}

/**
 * Load configuration from various sources with precedence:
 * 1. Default values
 * 2. Built-in workflow files
 * 3. .drs/workflows/*.yaml
 * 4. .drs/drs.config.yaml
 * 5. .gitlab-review.yml
 * 6. Environment variables
 * 7. CLI arguments (passed as overrides)
 */
export function loadConfig(projectPath?: string, overrides?: Partial<DRSConfig>): DRSConfig {
  const basePath = projectPath ?? process.cwd();
  const builtIn = loadBuiltInWorkflowFiles();
  let config = mergeConfig({ ...DEFAULT_CONFIG }, { workflows: builtIn.workflows });

  const projectWorkflowPath = resolve(basePath, '.drs/workflows');
  const project = loadWorkflowFilesFromDirectory(projectWorkflowPath, 'project');
  config = mergeConfig(config, { workflows: project.workflows });

  // Try loading from .drs/drs.config.yaml
  const drsConfigPath = resolve(basePath, '.drs/drs.config.yaml');
  if (existsSync(drsConfigPath)) {
    const fileConfig = yaml.parse(readFileSync(drsConfigPath, 'utf-8')) ?? {};
    rejectLegacyAgentConfigKeys(fileConfig, drsConfigPath);
    rejectRemovedReviewPostingConfigKeys(fileConfig, drsConfigPath);
    rejectInlineWorkflowConfig(fileConfig, drsConfigPath);
    config = mergeConfig(config, fileConfig);
  }

  // Try loading from .gitlab-review.yml
  const gitlabReviewPath = resolve(basePath, '.gitlab-review.yml');
  if (existsSync(gitlabReviewPath)) {
    const fileConfig = yaml.parse(readFileSync(gitlabReviewPath, 'utf-8')) ?? {};
    rejectLegacyAgentConfigKeys(fileConfig, gitlabReviewPath);
    rejectRemovedReviewPostingConfigKeys(fileConfig, gitlabReviewPath);
    rejectInlineWorkflowConfig(fileConfig, gitlabReviewPath);
    config = mergeConfig(config, fileConfig);
  }

  // Apply environment variable overrides
  if (process.env.GITLAB_URL) {
    config.gitlab.url = process.env.GITLAB_URL;
  }
  if (process.env.GITLAB_TOKEN) {
    config.gitlab.token = process.env.GITLAB_TOKEN;
  }
  if (process.env.GITHUB_TOKEN) {
    config.github.token = process.env.GITHUB_TOKEN;
  }
  if (process.env.REVIEW_AGENTS) {
    // Environment variable is always simple string format (comma-separated)
    config.review.agents = process.env.REVIEW_AGENTS.split(',').map((a) => a.trim());
  }
  const defaultModelEnv = getDefaultModelEnv();
  if (defaultModelEnv) {
    config.agents.default = mergeSection(config.agents.default, {
      model: defaultModelEnv,
    });
  }
  if (process.env.REVIEW_UNIFIED_MODEL) {
    config.review.unified = {
      ...config.review.unified,
      model: process.env.REVIEW_UNIFIED_MODEL,
    };
  }
  if (process.env.REVIEW_THINKING_LEVEL) {
    config.agents.default = mergeSection(config.agents.default, {
      thinkingLevel: process.env.REVIEW_THINKING_LEVEL,
    });
  }
  if (process.env.REVIEW_SKIP_REPO_CHECK === 'true') {
    config.review.skipRepoCheck = true;
  }
  if (process.env.REVIEW_SKIP_BRANCH_CHECK === 'true') {
    config.review.skipBranchCheck = true;
  }
  // Validate required fields
  if (!getDefaultModel(config)) {
    throw new Error(
      'Default model is required. Set agents.default.model in .drs/drs.config.yaml or DRS_DEFAULT_MODEL environment variable.\n' +
        'Run "drs init" to configure your project.'
    );
  }

  // Apply CLI overrides
  if (overrides) {
    config = mergeConfig(config, overrides);
  }

  return normalizeRuntimeConfig(config);
}

function rejectLegacyAgentConfigKeys(fileConfig: Partial<DRSConfig>, sourcePath: string): void {
  const reviewConfig = fileConfig.review as
    | (Partial<DRSConfig['review']> & {
        default?: unknown;
        defaultModel?: unknown;
        paths?: unknown;
      })
    | undefined;

  if (!reviewConfig || typeof reviewConfig !== 'object') {
    return;
  }

  const migrations: string[] = [];
  if ('default' in reviewConfig) migrations.push('review.default -> agents.default');
  if ('defaultModel' in reviewConfig)
    migrations.push('review.defaultModel -> agents.default.model');
  if ('paths' in reviewConfig) migrations.push('review.paths -> agents.paths');

  if (migrations.length > 0) {
    throw new Error(
      `Config file ${sourcePath} uses legacy DRS 3.x agent config keys: ${migrations.join(', ')}. ` +
        'DRS 4.0 requires top-level agent configuration. Move model/skill defaults to agents.default and custom paths to agents.paths.'
    );
  }
}

function rejectInlineWorkflowConfig(fileConfig: Partial<DRSConfig>, sourcePath: string): void {
  if (!isRecord(fileConfig) || fileConfig.workflows === undefined) {
    return;
  }

  throw new Error(`Config file ${sourcePath} cannot define top-level workflows.`);
}

function rejectRemovedReviewPostingConfigKeys(
  fileConfig: Partial<DRSConfig>,
  sourcePath: string
): void {
  if (!isRecord(fileConfig) || !isRecord(fileConfig.review)) {
    return;
  }

  const removedKeys: string[] = [];
  if (Object.prototype.hasOwnProperty.call(fileConfig.review, 'postErrorComment')) {
    removedKeys.push('review.postErrorComment');
  }

  if (
    isRecord(fileConfig.review.describe) &&
    Object.prototype.hasOwnProperty.call(fileConfig.review.describe, 'postDescription')
  ) {
    removedKeys.push('review.describe.postDescription');
  }

  if (removedKeys.length > 0) {
    throw new Error(
      `Config file ${sourcePath} uses removed DRS 4.0 review posting keys: ${removedKeys.join(', ')}. ` +
        'Run posting explicitly with workflows, or use github-pr-describe/gitlab-mr-describe with post=true when updating PR/MR descriptions.'
    );
  }
}

/**
 * Deep merge two config objects, skipping undefined values
 */
function mergeConfig(base: DRSConfig, override: Partial<DRSConfig>): DRSConfig {
  return {
    pi: mergeSection(base.pi, override.pi),
    opencode: mergeSection(base.opencode, override.opencode),
    agents: mergeSection(base.agents, override.agents),
    workflows: mergeSection(base.workflows, override.workflows),
    workflow: mergeSection(base.workflow, override.workflow),
    gitlab: mergeSection(base.gitlab, override.gitlab),
    github: mergeSection(base.github, override.github),
    review: mergeSection(base.review, override.review),
    describe: mergeSection(base.describe, override.describe),
    contextCompression: mergeSection(base.contextCompression, override.contextCompression),
    pricing: mergeSection(base.pricing, override.pricing),
    fix: mergeSection(base.fix, override.fix),
  };
}

function normalizeRuntimeConfig(config: DRSConfig): DRSConfig {
  const legacyRuntime = config.opencode ?? {};
  const piRuntime = config.pi ?? {};

  const hasLegacyConfig =
    Object.keys(legacyRuntime).length > 0 &&
    Object.values(legacyRuntime).some((v) => v !== undefined);

  if (hasLegacyConfig) {
    console.warn(
      '⚠ Config key "opencode" is deprecated and will be removed in a future release. Use "pi" instead.'
    );
  }

  const mergedProvider = {
    ...(legacyRuntime.provider ?? {}),
    ...(piRuntime.provider ?? {}),
  };

  const mergedRuntimeTimeouts = {
    ...(legacyRuntime.runtime ?? {}),
    ...(piRuntime.runtime ?? {}),
  };

  const legacyProviderRetry = legacyRuntime.retry?.provider;
  const piProviderRetry = piRuntime.retry?.provider;
  const mergedProviderRetry = {
    ...(legacyProviderRetry ?? {}),
    ...(piProviderRetry ?? {}),
  };

  const normalizedRuntime: RuntimeConfig = {
    provider: Object.keys(mergedProvider).length > 0 ? mergedProvider : undefined,
    runtime: Object.keys(mergedRuntimeTimeouts).length > 0 ? mergedRuntimeTimeouts : undefined,
    retry:
      Object.keys(mergedProviderRetry).length > 0
        ? {
            provider: mergedProviderRetry,
          }
        : undefined,
  };

  return {
    ...config,
    pi: normalizedRuntime,
    opencode: undefined,
  };
}

export function getRuntimeConfig(config: DRSConfig): RuntimeConfig {
  return normalizeRuntimeConfig(config).pi;
}

/**
 * Merge a config section, skipping undefined values
 */
function mergeSection<T extends object>(base: T | undefined, override?: Partial<T>): T {
  const safeBase = (base ?? {}) as T;
  if (!override) return safeBase;

  const result = { ...safeBase };
  for (const key in override) {
    const value = override[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Validate that required configuration is present
 */
export function validateConfig(config: DRSConfig, platform?: 'gitlab' | 'github'): void {
  // Validate platform-specific tokens if a platform is specified
  if (platform === 'gitlab' && !config.gitlab.token) {
    throw new Error(
      'GitLab token is required. Set GITLAB_TOKEN environment variable or configure in config file'
    );
  }

  if (platform === 'github' && !config.github.token) {
    throw new Error(
      'GitHub token is required. Set GITHUB_TOKEN environment variable or configure in config file'
    );
  }

  if (getReviewAgentIds(config).length === 0) {
    throw new Error('At least one review agent must be configured');
  }

  if (!getDefaultModel(config)) {
    throw new Error(
      'Default model is required. Run "drs init" to configure agents.default.model or set DRS_DEFAULT_MODEL environment variable.'
    );
  }
}

/**
 * Check if a file should be ignored based on patterns
 */
export function shouldIgnoreFile(filePath: string, config: DRSConfig): boolean {
  // Check ignore patterns
  for (const pattern of config.review.ignorePatterns) {
    if (minimatch(filePath, pattern)) {
      return true;
    }
  }

  // If include patterns are specified, check those
  if (config.review.includePatterns && config.review.includePatterns.length > 0) {
    let matches = false;
    for (const pattern of config.review.includePatterns) {
      if (minimatch(filePath, pattern)) {
        matches = true;
        break;
      }
    }
    return !matches;
  }

  return false;
}

// Simple minimatch implementation for pattern matching
function minimatch(path: string, pattern: string): boolean {
  const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

/**
 * Normalize agent configuration from mixed format to AgentConfig array
 */
export function normalizeAgentConfig(agents: (string | AgentConfig)[]): AgentConfig[] {
  return agents.map((agent) => {
    if (typeof agent === 'string') {
      return { name: agent };
    }
    return agent;
  });
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  );
}

function getNamespaceDefaults(config: DRSConfig, namespace: string): AgentDefaultsConfig {
  return config.agents.namespaces?.[namespace] ?? {};
}

function getAgentOverride(config: DRSConfig, agentId: string): AgentDefaultsConfig {
  return config.agents.overrides?.[agentId] ?? {};
}

function getDefaultModelEnv(): string | undefined {
  return process.env.DRS_DEFAULT_MODEL ?? process.env.REVIEW_DEFAULT_MODEL ?? undefined;
}

function getAgentModelEnv(agentId: string): string | undefined {
  const suffix = agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return process.env[`DRS_AGENT_${suffix}_MODEL`] ?? process.env[`REVIEW_AGENT_${suffix}_MODEL`];
}

function mergeToolSettings(
  ...settings: Array<Record<string, boolean> | undefined>
): Record<string, boolean> | undefined {
  const merged: Record<string, boolean> = {};

  for (const setting of settings) {
    if (!setting) {
      continue;
    }

    for (const [toolName, enabled] of Object.entries(setting)) {
      if (typeof enabled === 'boolean') {
        merged[toolName] = enabled;
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeRunSettings(...settings: Array<AgentRunConfig | undefined>): AgentRunConfig {
  const merged: AgentRunConfig = {};

  for (const setting of settings) {
    if (!setting) {
      continue;
    }

    if (setting.prompt !== undefined) merged.prompt = setting.prompt;
    if (setting.promptFile !== undefined) merged.promptFile = setting.promptFile;
    if (setting.output !== undefined) merged.output = setting.output;
    if (setting.json !== undefined) merged.json = setting.json;
  }

  return merged;
}

export function getDefaultModel(config: DRSConfig): string | undefined {
  return config.agents.default?.model ?? getDefaultModelEnv();
}

export function getDefaultThinkingLevel(config: DRSConfig): string | undefined {
  return config.agents.default?.thinkingLevel;
}

export function resolveAgentThinkingLevel(config: DRSConfig, agentId: string): string | undefined {
  const { namespace } = requireAgentId(agentId);

  return (
    getAgentOverride(config, agentId).thinkingLevel ??
    getNamespaceDefaults(config, namespace).thinkingLevel ??
    getDefaultThinkingLevel(config)
  );
}

export function getDefaultSkills(config: DRSConfig): string[] {
  return dedupeStrings((config.agents.default?.skills ?? []).map(String));
}

export function resolveAgentSkills(
  config: DRSConfig,
  agentId: string,
  definitionSkills: string[] = [],
  additionalSkills: string[] = [],
  precomputedReviewAgentConfig?: AgentConfig | null
): string[] {
  const { namespace } = requireAgentId(agentId);
  const namespaceDefaults = getNamespaceDefaults(config, namespace);
  const agentOverride = getAgentOverride(config, agentId);
  const reviewAgentConfig =
    precomputedReviewAgentConfig === undefined
      ? normalizeAgentConfig(config.review.agents).find((agent) => agent.name === agentId)
      : precomputedReviewAgentConfig;

  return dedupeStrings([
    ...(config.agents.default?.skills ?? []),
    ...(namespaceDefaults.skills ?? []),
    ...definitionSkills,
    ...(agentOverride.skills ?? []),
    ...(reviewAgentConfig?.skills ?? []),
    ...additionalSkills,
  ]);
}

export function resolveAgentModel(
  config: DRSConfig,
  agentId: string,
  explicitModel?: string
): string | undefined {
  const { namespace } = requireAgentId(agentId);
  const envModel = getAgentModelEnv(agentId);

  return (
    explicitModel ??
    envModel ??
    getAgentOverride(config, agentId).model ??
    getNamespaceDefaults(config, namespace).model ??
    getDefaultModel(config)
  );
}

export function resolveRuntimeAgentModel(
  config: DRSConfig,
  agentId: string,
  definitionModel?: string
): string | undefined {
  const { namespace } = requireAgentId(agentId);

  return (
    getAgentModelEnv(agentId) ??
    getAgentOverride(config, agentId).model ??
    definitionModel ??
    getNamespaceDefaults(config, namespace).model ??
    getDefaultModel(config)
  );
}

export function resolveAgentTools(
  config: DRSConfig,
  agentId: string,
  definitionTools?: Record<string, boolean>
): Record<string, boolean> | undefined {
  const { namespace } = requireAgentId(agentId);

  return mergeToolSettings(
    config.agents.default?.tools,
    getNamespaceDefaults(config, namespace).tools,
    definitionTools,
    getAgentOverride(config, agentId).tools
  );
}

export function resolveAgentRunConfig(config: DRSConfig, agentId: string): AgentRunConfig {
  const { namespace } = requireAgentId(agentId);

  return mergeRunSettings(
    config.agents.default?.run,
    getNamespaceDefaults(config, namespace).run,
    getAgentOverride(config, agentId).run
  );
}

/**
 * Extract effective review agent ids from configuration.
 */
export function getReviewAgentIds(config: DRSConfig): string[] {
  return getReviewAgentIdsFromNormalized(normalizeAgentConfig(config.review.agents));
}

function getReviewAgentIdsFromNormalized(normalizedAgents: AgentConfig[]): string[] {
  const configuredAgentIds = normalizedAgents.map((agent) => agent.name);
  const deduped = dedupeStrings(configuredAgentIds);

  for (const agentId of deduped) {
    const { namespace } = requireAgentId(agentId);
    if (namespace !== 'review') {
      throw new Error(
        `Invalid review agent "${agentId}". Review agents must be in the "review" namespace.`
      );
    }
  }

  return deduped;
}

/**
 * Build model overrides from config and environment variables
 * Precedence:
 * 1. Per-agent model in config
 * 2. Environment variable DRS_AGENT_<NAMESPACE>_<NAME>_MODEL
 * 3. agents.overrides.<agent>.model
 * 4. agents.namespaces.<namespace>.model
 * 5. agents.default.model (falls back to DRS_DEFAULT_MODEL)
 */
export function getModelOverrides(config: DRSConfig): ModelOverrides {
  const overrides: ModelOverrides = {};
  const normalizedAgents = normalizeAgentConfig(config.review.agents);
  const agentConfigByName = new Map(normalizedAgents.map((agent) => [agent.name, agent]));

  for (const agentId of getReviewAgentIdsFromNormalized(normalizedAgents)) {
    const configuredAgent = agentConfigByName.get(agentId);
    const model = resolveAgentModel(config, agentId, configuredAgent?.model);

    if (model) {
      overrides[agentId] = model;
    }
  }

  return overrides;
}

/**
 * Get model override for the unified reviewer agent
 * Precedence:
 * 1. review.unified.model in config
 * 2. Environment variable REVIEW_UNIFIED_MODEL
 */
export function getUnifiedModelOverride(config: DRSConfig): ModelOverrides {
  const overrides: ModelOverrides = {};

  const agentId = 'review/unified-reviewer';
  const unifiedModel = config.review.unified?.model ?? process.env.REVIEW_UNIFIED_MODEL;

  if (unifiedModel) {
    overrides[agentId] = unifiedModel;
  }

  return overrides;
}

/**
 * Get model override for the describer agent
 * Precedence:
 * 1. describe.model in config
 * 2. Environment variable DESCRIBE_MODEL
 * 3. agents.overrides["describe/pr-describer"].model
 * 4. agents.namespaces.describe.model
 * 5. agents.default.model (falls back to DRS_DEFAULT_MODEL)
 */
export function getDescriberModelOverride(config: DRSConfig): ModelOverrides {
  const overrides: ModelOverrides = {};

  const agentId = 'describe/pr-describer';
  const describerModel = config.describe?.model ?? process.env.DESCRIBE_MODEL;

  if (describerModel) {
    overrides[agentId] = describerModel;
    return overrides;
  }

  const genericModel = resolveAgentModel(config, agentId);
  if (genericModel) {
    overrides[agentId] = genericModel;
  }

  return overrides;
}
