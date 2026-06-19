import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import simpleGit from 'simple-git';
import chalk from 'chalk';
import type {
  DRSConfig,
  WorkflowConfig,
  WorkflowInputConfig,
  WorkflowNodeConfig,
} from '../lib/config.js';
import {
  getDescriberModelOverride,
  loadWorkflowSourceInfo,
  normalizeAgentConfig,
  resolveAgentRunConfig,
  type WorkflowSource,
} from '../lib/config.js';
import { resolveWithinWorkingDir } from '../lib/path-utils.js';
import { parseDiff, getChangedFiles, getFilesWithDiffs } from '../lib/diff-parser.js';
import { parseDiffLineInfo } from '../lib/diff-lines.js';
import {
  connectToRuntime,
  executeReview,
  filterIgnoredFiles,
  type ReviewResult,
  type ReviewSource,
} from '../lib/review-orchestrator.js';
import { ExitError, setExitHandler } from '../lib/exit.js';
import type {
  FileChange,
  InlineCommentPosition,
  LineValidator,
  PlatformClient,
  PullRequest,
} from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';
import { postReviewComments } from '../lib/comment-poster.js';
import { findExistingCommentById } from '../lib/comment-manager.js';
import { removeErrorComment } from '../lib/error-comment-poster.js';
import { runDescribeIfEnabled } from '../lib/description-executor.js';
import type { Description } from '../lib/description-formatter.js';
import { buildBaseInstructions, type FileWithDiff } from '../lib/review-core.js';
import { resolveCursorFixLinkOptions } from '../lib/cursor-fix-link.js';
import {
  extractHtmlDocument,
  parseArtifactOutputPointer,
  readArtifactOutputPointer,
  validateHtmlArtifact,
} from '../lib/html-artifact.js';
import {
  enforceRepoBranchMatch,
  getCanonicalDiffCommand,
  resolveBaseBranch,
} from '../lib/repository-validator.js';
import { formatCodeQualityReport, generateCodeQualityReport } from '../lib/code-quality-report.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import type { AgentRunResult, RunAgentOptions } from './run-agent.js';
import { runAgent } from './run-agent.js';

export interface WorkflowRunOptions {
  inputs?: Record<string, string>;
  inputFiles?: Record<string, string>;
  outputPath?: string;
  jsonOutput?: boolean;
  debug?: boolean;
  thinkingLevel?: string;
  workingDir?: string;
}

export interface WorkflowNodeResult {
  id: string;
  type: 'agent' | 'agents' | 'action' | 'control' | 'skipped';
  status?: 'success' | 'skipped';
  agent?: string;
  agents?: string[];
  action?: string;
  control?: string;
  decision?: string;
  target?: string;
  response?: string;
  responses?: AgentRunResult[];
  output?: unknown;
  writes?: string;
}

export interface WorkflowLoopState {
  iteration: number;
  maxIterations: number;
  lastDecision?: 'loop' | 'exit';
}

export interface WorkflowRunResult {
  timestamp: string;
  workflow: string;
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
  loop: Record<string, WorkflowLoopState>;
  output?: unknown;
}

interface WorkflowTemplateContext {
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
  loop: Record<string, WorkflowLoopState>;
}

interface WorkflowExecutionContext {
  gitClients: Map<string, ReturnType<typeof simpleGit>>;
  platformClients: Partial<Record<WorkflowPlatform, PlatformClient>>;
  locks: {
    exit: WorkflowLock;
    console: WorkflowLock;
  };
}

type WorkflowPlatform = 'github' | 'gitlab';

interface WorkflowPostTarget {
  platform: WorkflowPlatform;
  platformClient: PlatformClient;
  projectId: string;
  prNumber: number;
  pullRequest?: PullRequest;
  changedFiles?: FileChange[];
}

interface GitLabDiffRefs {
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
}

interface GitRangeCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

interface WorkflowLock {
  current: Promise<void>;
}

function createWorkflowLock(): WorkflowLock {
  return { current: Promise.resolve() };
}

async function withWorkflowLock<T>(lock: WorkflowLock, run: () => Promise<T>): Promise<T> {
  const previousLock = lock.current;
  let releaseLock!: () => void;
  lock.current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    return await run();
  } finally {
    releaseLock();
  }
}

async function withWorkflowConsoleSuppressed<T>(
  executionContext: WorkflowExecutionContext,
  suppress: boolean,
  run: () => Promise<T>
): Promise<T> {
  if (!suppress) {
    return run();
  }

  return withWorkflowLock(executionContext.locks.console, async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => undefined;
    console.warn = () => undefined;
    try {
      return await run();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  });
}

function getWorkflowGitClient(
  executionContext: WorkflowExecutionContext,
  workingDir: string
): ReturnType<typeof simpleGit> {
  const existing = executionContext.gitClients.get(workingDir);
  if (existing) {
    return existing;
  }

  const git = simpleGit({ baseDir: workingDir });
  executionContext.gitClients.set(workingDir, git);
  return git;
}

function getWorkflowPlatformClient(
  executionContext: WorkflowExecutionContext,
  platform: WorkflowPlatform
): PlatformClient {
  const existing = executionContext.platformClients[platform];
  if (existing) {
    return existing;
  }

  const client =
    platform === 'github'
      ? new GitHubPlatformAdapter(createGitHubClient())
      : new GitLabPlatformAdapter(createGitLabClient());
  executionContext.platformClients[platform] = client;
  return client;
}

function getNodeNeeds(node: WorkflowNodeConfig): string[] {
  if (node.needs === undefined) {
    return [];
  }

  if (!Array.isArray(node.needs)) {
    throw new Error('Workflow node "needs" must be an array of node ids.');
  }

  return node.needs;
}

function getControlTargets(node: WorkflowNodeConfig): string[] {
  const targets: string[] = [];
  if (node.then) targets.push(node.then);
  if (node.else) targets.push(node.else);
  if (node.target) targets.push(node.target);
  if (node.exit) targets.push(node.exit);
  if (node.default) targets.push(node.default);
  if (node.cases) targets.push(...Object.values(node.cases));
  return targets;
}

function validateWorkflowControlTargets(nodes: Record<string, WorkflowNodeConfig>): void {
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const target of getControlTargets(node)) {
      if (!nodes[target]) {
        throw new Error(`Workflow node "${nodeId}" targets unknown node "${target}".`);
      }
    }
  }
}

function validateWorkflowNodeKinds(nodes: Record<string, WorkflowNodeConfig>): void {
  for (const node of Object.values(nodes)) {
    getNodeKind(node);
  }
}

function hasWorkflowControlNodes(nodes: Record<string, WorkflowNodeConfig>): boolean {
  return Object.values(nodes).some((node) => node.control !== undefined);
}

function getWorkflowExecutionOrder(nodes: Record<string, WorkflowNodeConfig>): string[] {
  const nodeIds = Object.keys(nodes);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      throw new Error(`Workflow contains a dependency cycle at node "${nodeId}".`);
    }

    const node = nodes[nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${nodeId}".`);
    }

    visiting.add(nodeId);
    for (const dependency of getNodeNeeds(node)) {
      if (!nodes[dependency]) {
        throw new Error(`Workflow node "${nodeId}" needs unknown node "${dependency}".`);
      }
      visit(dependency);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }

  for (const nodeId of nodeIds) {
    visit(nodeId);
  }

  validateWorkflowNodeKinds(nodes);
  validateWorkflowControlTargets(nodes);

  const standaloneEndNodes = order.filter(
    (nodeId) => nodes[nodeId]?.control === 'end' && getNodeNeeds(nodes[nodeId] ?? {}).length === 0
  );
  const nonStandaloneEndNodes = order.filter((nodeId) => !standaloneEndNodes.includes(nodeId));
  return [...nonStandaloneEndNodes, ...standaloneEndNodes];
}

function getWorkflowNodes(
  workflowName: string,
  workflow: WorkflowConfig
): Record<string, WorkflowNodeConfig> {
  const nodes = workflow.nodes as unknown;
  if (
    typeof nodes !== 'object' ||
    nodes === null ||
    Array.isArray(nodes) ||
    Object.keys(nodes).length === 0
  ) {
    throw new Error(`Workflow "${workflowName}" must define at least one node.`);
  }

  return nodes as Record<string, WorkflowNodeConfig>;
}

function getWorkflowExecutionWaves(
  nodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[]
): string[][] {
  const depthByNode = new Map<string, number>();
  const waves: string[][] = [];

  for (const nodeId of executionOrder) {
    const node = nodes[nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${nodeId}".`);
    }

    const depth = getNodeNeeds(node).reduce((maxDepth, dependency) => {
      return Math.max(maxDepth, (depthByNode.get(dependency) ?? 0) + 1);
    }, 0);

    depthByNode.set(nodeId, depth);
    waves[depth] = waves[depth] ?? [];
    waves[depth].push(nodeId);
  }

  return waves;
}

function getPathValue(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, root);
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function renderTemplate(template: string, context: WorkflowTemplateContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const value = getPathValue(context, path);
    if (value === undefined) {
      throw new Error(`Unknown workflow template value "{{${path}}}".`);
    }
    return stringifyTemplateValue(value);
  });
}

async function resolveWorkflowInput(
  key: string,
  input: WorkflowInputConfig,
  workingDir: string
): Promise<string> {
  if (typeof input === 'string') {
    return input;
  }

  const hasValue = input.value !== undefined;
  const hasFile = input.file !== undefined;
  if (hasValue && hasFile) {
    throw new Error(`Workflow input "${key}" cannot define both value and file.`);
  }
  if (hasValue) {
    return input.value ?? '';
  }
  if (hasFile) {
    const inputPath = resolveWithinWorkingDir(workingDir, input.file ?? '', 'read');
    return readFile(inputPath, 'utf-8');
  }

  throw new Error(`Workflow input "${key}" must define value or file.`);
}

async function resolveWorkflowInputs(
  workflow: WorkflowConfig,
  options: WorkflowRunOptions,
  workingDir: string
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};

  for (const [key, input] of Object.entries(workflow.inputs ?? {})) {
    values[key] = await resolveWorkflowInput(key, input, workingDir);
  }

  for (const [key, value] of Object.entries(options.inputs ?? {})) {
    values[key] = value;
  }

  for (const [key, filePath] of Object.entries(options.inputFiles ?? {})) {
    const resolvedPath = resolveWithinWorkingDir(workingDir, filePath, 'read');
    values[key] = await readFile(resolvedPath, 'utf-8');
  }

  return values;
}

function resolveAgentsFrom(config: DRSConfig, agentsFrom: string): string[] {
  if (agentsFrom === 'review.agents') {
    return normalizeAgentConfig(config.review.agents).map((agent) => agent.name);
  }

  throw new Error(
    `Unsupported workflow agentsFrom "${agentsFrom}". ` + 'Currently supported: review.agents.'
  );
}

function getNodeKind(node: WorkflowNodeConfig): 'agent' | 'agents' | 'action' | 'control' {
  const configuredKinds = [node.agent, node.agentsFrom, node.action, node.control].filter(
    (value) => value !== undefined
  ).length;

  if (configuredKinds !== 1) {
    throw new Error(
      'Workflow node must define exactly one of agent, agentsFrom, action, or control.'
    );
  }

  if (node.agent !== undefined) return 'agent';
  if (node.agentsFrom !== undefined) return 'agents';
  if (node.control !== undefined) return 'control';
  return 'action';
}

function hasConfiguredAgentPrompt(config: DRSConfig, agentId: string): boolean {
  const runConfig = resolveAgentRunConfig(config, agentId);
  return runConfig.prompt !== undefined || runConfig.promptFile !== undefined;
}

function createAgentOptions(
  prompt: string | undefined,
  options: WorkflowRunOptions,
  workingDir: string
): RunAgentOptions {
  return {
    prompt,
    jsonOutput: false,
    debug: options.debug,
    thinkingLevel: options.thinkingLevel,
    workingDir,
    quiet: true,
    allowImplicitStdin: false,
    ignoreConfiguredOutput: true,
  };
}

async function writeWorkflowFile(
  workingDir: string,
  relativeOutputPath: string,
  content: string
): Promise<void> {
  if (!relativeOutputPath.trim()) {
    throw new Error('Workflow output path cannot be empty.');
  }

  const outputPath = resolveWithinWorkingDir(workingDir, relativeOutputPath, 'write');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf-8');
}

async function formatWorkflowNodeWriteContent(
  workingDir: string,
  nodeId: string,
  writes: string,
  content: string
): Promise<string> {
  if (!/\.html?$/i.test(writes)) {
    return content;
  }

  const pointer = parseArtifactOutputPointer(content);
  if (pointer) {
    if (pointer.outputPath !== writes) {
      throw new Error(
        `Workflow node "${nodeId}" artifact pointer wrote "${pointer.outputPath}" but workflow expected "${writes}".`
      );
    }
    return readArtifactOutputPointer(workingDir, pointer);
  }

  try {
    const html = extractHtmlDocument(content);
    validateHtmlArtifact(html);
    return html;
  } catch (error) {
    throw new Error(
      `Workflow node "${nodeId}" produced invalid HTML output: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function renderNodeWritesPath(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): string | undefined {
  if (!node.writes) {
    return undefined;
  }

  const writes = renderTemplate(node.writes, context);
  if (!writes.trim()) {
    throw new Error(`Workflow node "${nodeId}" writes resolved to an empty path.`);
  }

  return writes;
}

async function runAgentWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const agentId = node.agent;
  if (!agentId) {
    throw new Error(`Workflow node "${nodeId}" is missing agent.`);
  }

  const prompt = node.input === undefined ? undefined : renderTemplate(node.input, context);
  if (prompt === undefined && !hasConfiguredAgentPrompt(config, agentId)) {
    throw new Error(
      `Workflow agent node "${nodeId}" must define input or configure ` +
        `agents.overrides.${agentId}.run.prompt/promptFile.`
    );
  }

  const result = await runAgent(config, agentId, createAgentOptions(prompt, options, workingDir));
  const writes = renderNodeWritesPath(nodeId, node, context);
  const output = writes
    ? await formatWorkflowNodeWriteContent(
        workingDir,
        nodeId,
        writes,
        node.json === true ? JSON.stringify(result, null, 2) : result.response
      )
    : result.response;
  if (writes) {
    await writeWorkflowFile(workingDir, writes, output);
  }

  return {
    id: nodeId,
    type: 'agent',
    agent: agentId,
    response: result.response,
    output,
    writes,
  };
}

async function runAgentsWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const agentsFrom = node.agentsFrom;
  if (!agentsFrom) {
    throw new Error(`Workflow node "${nodeId}" is missing agentsFrom.`);
  }

  const agentIds = resolveAgentsFrom(config, agentsFrom);
  const prompt = node.input === undefined ? undefined : renderTemplate(node.input, context);

  if (prompt === undefined) {
    const missingPromptAgent = agentIds.find(
      (agentId) => !hasConfiguredAgentPrompt(config, agentId)
    );
    if (missingPromptAgent) {
      throw new Error(
        `Workflow agentsFrom node "${nodeId}" must define input or configure ` +
          `agents.overrides.${missingPromptAgent}.run.prompt/promptFile.`
      );
    }
  }

  const responses = await Promise.all(
    agentIds.map((agentId) =>
      runAgent(config, agentId, createAgentOptions(prompt, options, workingDir))
    )
  );

  const response = responses
    .map((result) => `## ${result.agent}\n\n${result.response.trim()}`.trim())
    .join('\n\n');
  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(
      workingDir,
      writes,
      node.json === true ? JSON.stringify(responses, null, 2) : response
    );
  }

  return {
    id: nodeId,
    type: 'agents',
    agents: agentIds,
    response,
    responses,
    output: response,
    writes,
  };
}

async function runActionWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  if (node.action === 'write') {
    return runWriteWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'git-diff') {
    return runGitDiffWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'git-add') {
    return runGitAddWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'git-commit') {
    return runGitCommitWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'change-source') {
    return runChangeSourceWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'review') {
    return runReviewWorkflowNode(
      config,
      nodeId,
      node,
      options,
      workingDir,
      context,
      executionContext
    );
  }
  if (node.action === 'review-context') {
    return runReviewContextWorkflowNode(config, nodeId, node, workingDir, context);
  }
  if (node.action === 'describe') {
    return runDescribeWorkflowNode(
      config,
      nodeId,
      node,
      options,
      workingDir,
      context,
      executionContext
    );
  }
  if (node.action === 'code-quality-report') {
    return runCodeQualityReportWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'post-comment') {
    return runPostCommentWorkflowNode(nodeId, node, options, workingDir, context, executionContext);
  }
  if (node.action === 'post-review-comments') {
    return runPostReviewCommentsWorkflowNode(
      config,
      nodeId,
      node,
      options,
      workingDir,
      context,
      executionContext
    );
  }

  throw new Error(`Unsupported workflow action "${node.action}" in node "${nodeId}".`);
}

async function runWriteWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  if (!node.writes) {
    throw new Error(`Workflow write node "${nodeId}" must define writes.`);
  }
  if (node.input === undefined) {
    throw new Error(`Workflow write node "${nodeId}" must define input.`);
  }

  const content = renderTemplate(node.input, context);
  const relativeOutputPath = renderNodeWritesPath(nodeId, node, context);
  if (!relativeOutputPath) {
    throw new Error(`Workflow write node "${nodeId}" must define writes.`);
  }
  await writeWorkflowFile(workingDir, relativeOutputPath, content);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: content,
    output: content,
    writes: relativeOutputPath,
  };
}

function getBooleanActionOption(
  node: WorkflowNodeConfig,
  key: string,
  context?: WorkflowTemplateContext
): boolean {
  const value = node.with?.[key];
  if (typeof value === 'string' && context) {
    const rendered = renderTemplate(value, context).trim().toLowerCase();
    return rendered === 'true' || rendered === '1' || rendered === 'yes';
  }
  return value === true || value === 'true' || value === 1;
}

function getStringActionOption(
  node: WorkflowNodeConfig,
  key: string,
  context: WorkflowTemplateContext
): string | undefined {
  const value = node.with?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return renderTemplate(value, context);
  }
  return String(value);
}

function hasActionOption(node: WorkflowNodeConfig, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(node.with ?? {}, key);
}

function requireStringActionOption(
  nodeId: string,
  node: WorkflowNodeConfig,
  key: string,
  context: WorkflowTemplateContext
): string {
  const value = getStringActionOption(node, key, context)?.trim();
  if (!value) {
    throw new Error(`Workflow node "${nodeId}" must define with.${key}.`);
  }
  return value;
}

function requireNumberActionOption(
  nodeId: string,
  node: WorkflowNodeConfig,
  key: string,
  context: WorkflowTemplateContext
): number {
  const value = requireStringActionOption(nodeId, node, key, context);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Workflow node "${nodeId}" with.${key} must be a positive number.`);
  }
  return parsed;
}

function getPathActionOption(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  workingDir: string
): string[] {
  const rawPaths = hasActionOption(node, 'paths')
    ? requireStringActionOption(nodeId, node, 'paths', context)
    : requireStringActionOption(nodeId, node, 'path', context);
  const paths = rawPaths
    .split(/[\n,]/)
    .map((path) => path.trim())
    .filter(Boolean);

  if (paths.length === 0) {
    throw new Error(`Workflow node "${nodeId}" must define at least one path.`);
  }

  for (const path of paths) {
    resolveWithinWorkingDir(workingDir, path, 'access');
  }

  return paths;
}

async function requireWorkflowGitRepo(
  nodeId: string,
  workingDir: string,
  executionContext: WorkflowExecutionContext
) {
  const git = getWorkflowGitClient(executionContext, workingDir);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Workflow git node "${nodeId}" must run from a git repository.`);
  }
  return git;
}

async function runGitDiffWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const git = getWorkflowGitClient(executionContext, workingDir);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Workflow git-diff node "${nodeId}" must run from a git repository.`);
  }

  const staged = getBooleanActionOption(node, 'staged', context);
  const diff = staged ? await git.diff(['--cached']) : await git.diff();
  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(workingDir, writes, diff);
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: diff,
    output: diff,
    writes,
  };
}

async function runGitAddWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const git = await requireWorkflowGitRepo(nodeId, workingDir, executionContext);
  const paths = getPathActionOption(nodeId, node, context, workingDir);
  await git.add(paths);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: paths.join('\n'),
    output: paths,
  };
}

async function runGitCommitWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const git = await requireWorkflowGitRepo(nodeId, workingDir, executionContext);
  const message = requireStringActionOption(nodeId, node, 'message', context);
  const paths =
    hasActionOption(node, 'paths') || hasActionOption(node, 'path')
      ? getPathActionOption(nodeId, node, context, workingDir)
      : undefined;

  if (paths) {
    await git.add(paths);
  }

  const commit = paths ? await git.commit(message, paths) : await git.commit(message);
  const output = {
    commit: commit.commit,
    message,
    paths,
    summary: commit.summary,
  };

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: commit.commit ? `Created commit ${commit.commit}` : 'Created git commit',
    output,
  };
}

async function loadLocalChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<ReviewSource> {
  const git = simpleGit({ baseDir: workingDir });
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Workflow change-source node "${nodeId}" must run from a git repository.`);
  }

  const staged = getBooleanActionOption(node, 'staged', context);
  const diffText = staged ? await git.diff(['--cached']) : await git.diff();
  const diffs = parseDiff(diffText);
  const changedFiles = getChangedFiles(diffs);

  return {
    name: `Local ${staged ? 'staged' : 'unstaged'} diff`,
    files: changedFiles,
    filesWithDiffs: getFilesWithDiffs(diffs),
    context: {},
    workingDir,
    staged,
  };
}

function parseGitRangeCommits(logOutput: string): GitRangeCommit[] {
  return logOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', author = '', date = '', subject = ''] = line.split('\x1f');
      return { sha, author, date, subject };
    })
    .filter((commit) => commit.sha.length > 0);
}

async function resolveGitRangeToRef(git: ReturnType<typeof simpleGit>): Promise<string> {
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  const tag = (await git.raw(['describe', '--tags', '--exact-match', 'HEAD'])).trim();
  if (!tag) {
    throw new Error(
      'Workflow git-range change-source could not infer the current tag. ' +
        'Run from a tag checkout or provide with.to.'
    );
  }
  return tag;
}

function isStableSemverTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

async function resolvePreviousGitRangeTag(
  nodeId: string,
  node: WorkflowNodeConfig,
  git: ReturnType<typeof simpleGit>,
  toRef: string,
  context: WorkflowTemplateContext
): Promise<string> {
  const includePrerelease = getBooleanActionOption(node, 'includePrereleaseFrom', context);
  const tagOutput = await git.raw(['tag', '--merged', toRef, '--sort=-v:refname']);
  const tags = tagOutput
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag !== toRef);
  const previousTag = tags.find((tag) => includePrerelease || isStableSemverTag(tag)) ?? tags[0];

  if (!previousTag) {
    throw new Error(
      `Workflow node "${nodeId}" could not infer the previous tag for ${toRef}. ` +
        'Provide with.from explicitly.'
    );
  }

  return previousTag;
}

async function resolveGitRangeRefs(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  git: ReturnType<typeof simpleGit>
): Promise<{ fromRef: string; toRef: string }> {
  const configuredToRef = getStringActionOption(node, 'to', context)?.trim();
  const toRef = configuredToRef ?? (await resolveGitRangeToRef(git));
  const configuredFromRef = getStringActionOption(node, 'from', context)?.trim();
  const fromRef =
    configuredFromRef ?? (await resolvePreviousGitRangeTag(nodeId, node, git, toRef, context));

  if (!fromRef) {
    throw new Error(
      `Workflow node "${nodeId}" could not infer the previous tag for ${toRef}. ` +
        'Provide with.from explicitly.'
    );
  }

  return { fromRef, toRef };
}

async function loadGitRangeChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<ReviewSource> {
  const git = await requireWorkflowGitRepo(nodeId, workingDir, executionContext);
  const { fromRef, toRef } = await resolveGitRangeRefs(nodeId, node, context, git);
  const range = `${fromRef}..${toRef}`;
  const diffText = await git.diff([range]);
  const logOutput = await git.raw(['log', '--format=%H%x1f%an%x1f%aI%x1f%s', '--no-merges', range]);
  const diffs = parseDiff(diffText);
  const changedFiles = getChangedFiles(diffs);

  return {
    name: `Git range ${range}`,
    files: changedFiles,
    filesWithDiffs: getFilesWithDiffs(diffs),
    context: {
      sourceType: 'git-range',
      fromRef,
      toRef,
      range,
      commits: parseGitRangeCommits(logOutput),
    },
    workingDir,
  };
}

function createPlatformChangeSource(
  platform: 'github' | 'gitlab',
  name: string,
  projectId: string,
  pullRequest: PullRequest,
  changedFiles: FileChange[],
  workingDir: string
): ReviewSource {
  return {
    name,
    files: changedFiles.map((file) => file.filename),
    filesWithDiffs: changedFiles
      .filter((file) => file.patch && file.patch.length > 0)
      .map((file) => ({ filename: file.filename, patch: file.patch ?? '' })),
    context: {
      platform,
      projectId,
      pullRequest,
      changedFiles,
    },
    workingDir,
  };
}

async function loadGitHubChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<ReviewSource> {
  const owner = requireStringActionOption(nodeId, node, 'owner', context);
  const repo = requireStringActionOption(nodeId, node, 'repo', context);
  const prNumber = requireNumberActionOption(nodeId, node, 'pr', context);
  const projectId = `${owner}/${repo}`;
  const platformClient = getWorkflowPlatformClient(executionContext, 'github');
  const [pullRequest, changedFiles] = await Promise.all([
    platformClient.getPullRequest(projectId, prNumber),
    platformClient.getChangedFiles(projectId, prNumber),
  ]);

  return createPlatformChangeSource(
    'github',
    `GitHub PR ${projectId}#${prNumber}`,
    projectId,
    pullRequest,
    changedFiles,
    workingDir
  );
}

async function loadGitLabChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<ReviewSource> {
  const projectId = hasActionOption(node, 'project')
    ? requireStringActionOption(nodeId, node, 'project', context)
    : requireStringActionOption(nodeId, node, 'projectId', context);
  const mrIid = hasActionOption(node, 'mr')
    ? requireNumberActionOption(nodeId, node, 'mr', context)
    : requireNumberActionOption(nodeId, node, 'mrIid', context);
  const platformClient = getWorkflowPlatformClient(executionContext, 'gitlab');
  const [pullRequest, changedFiles] = await Promise.all([
    platformClient.getPullRequest(projectId, mrIid),
    platformClient.getChangedFiles(projectId, mrIid),
  ]);

  return createPlatformChangeSource(
    'gitlab',
    `GitLab MR ${projectId}!${mrIid}`,
    projectId,
    pullRequest,
    changedFiles,
    workingDir
  );
}

async function runChangeSourceWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const type = getStringActionOption(node, 'type', context) ?? 'local';
  let source: ReviewSource;
  if (type === 'local') {
    source = await loadLocalChangeSource(nodeId, node, workingDir, context);
  } else if (type === 'git-range') {
    source = await loadGitRangeChangeSource(nodeId, node, workingDir, context, executionContext);
  } else if (type === 'github-pr') {
    source = await loadGitHubChangeSource(nodeId, node, workingDir, context, executionContext);
  } else if (type === 'gitlab-mr') {
    source = await loadGitLabChangeSource(nodeId, node, workingDir, context, executionContext);
  } else {
    throw new Error(
      `Unsupported workflow change-source type "${type}" in node "${nodeId}". ` +
        'Currently supported: local, git-range, github-pr, gitlab-mr.'
    );
  }
  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(workingDir, writes, JSON.stringify(source, null, 2));
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: source.name,
    output: source,
    writes,
  };
}

function isWorkflowPlatform(value: string | undefined): value is WorkflowPlatform {
  return value === 'github' || value === 'gitlab';
}

function readSourcePostTarget(source: ReviewSource | undefined): Partial<WorkflowPostTarget> {
  if (!source) {
    return {};
  }

  const platform =
    typeof source.context.platform === 'string' ? source.context.platform : undefined;
  const projectId =
    typeof source.context.projectId === 'string' ? source.context.projectId : undefined;
  const pullRequest = isPullRequest(source.context.pullRequest)
    ? source.context.pullRequest
    : undefined;
  const changedFiles = Array.isArray(source.context.changedFiles)
    ? source.context.changedFiles.filter(isFileChange)
    : undefined;

  return {
    platform: isWorkflowPlatform(platform) ? platform : undefined,
    projectId,
    prNumber: pullRequest?.number,
    pullRequest,
    changedFiles,
  };
}

function resolvePostProjectId(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  sourceTarget: Partial<WorkflowPostTarget>
): string {
  if (hasActionOption(node, 'owner') || hasActionOption(node, 'repo')) {
    const owner = requireStringActionOption(nodeId, node, 'owner', context);
    const repo = requireStringActionOption(nodeId, node, 'repo', context);
    return `${owner}/${repo}`;
  }

  const projectId =
    getStringActionOption(node, 'project', context) ??
    getStringActionOption(node, 'projectId', context) ??
    sourceTarget.projectId;
  if (!projectId) {
    throw new Error(`Workflow post node "${nodeId}" must define a project target.`);
  }

  return projectId;
}

function resolvePostPrNumber(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  sourceTarget: Partial<WorkflowPostTarget>
): number {
  if (hasActionOption(node, 'pr')) {
    return requireNumberActionOption(nodeId, node, 'pr', context);
  }
  if (hasActionOption(node, 'mr')) {
    return requireNumberActionOption(nodeId, node, 'mr', context);
  }
  if (hasActionOption(node, 'prNumber')) {
    return requireNumberActionOption(nodeId, node, 'prNumber', context);
  }
  if (hasActionOption(node, 'mrIid')) {
    return requireNumberActionOption(nodeId, node, 'mrIid', context);
  }
  if (sourceTarget.prNumber) {
    return sourceTarget.prNumber;
  }

  throw new Error(`Workflow post node "${nodeId}" must define a PR/MR number.`);
}

function resolvePostTarget(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext,
  source?: ReviewSource
): WorkflowPostTarget {
  const sourceTarget = readSourcePostTarget(source);
  const explicitPlatform = getStringActionOption(node, 'platform', context);
  const platform = explicitPlatform ?? sourceTarget.platform;
  if (!isWorkflowPlatform(platform)) {
    throw new Error(
      `Workflow post node "${nodeId}" must resolve with.platform to github or gitlab.`
    );
  }

  const projectId = resolvePostProjectId(nodeId, node, context, sourceTarget);
  const prNumber = resolvePostPrNumber(nodeId, node, context, sourceTarget);

  return {
    platform,
    platformClient: getWorkflowPlatformClient(executionContext, platform),
    projectId,
    prNumber,
    pullRequest: sourceTarget.pullRequest,
    changedFiles: sourceTarget.changedFiles,
  };
}

function isPullRequest(value: unknown): value is PullRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<PullRequest>;
  return (
    typeof candidate.number === 'number' &&
    typeof candidate.title === 'string' &&
    typeof candidate.author === 'string' &&
    typeof candidate.sourceBranch === 'string' &&
    typeof candidate.targetBranch === 'string' &&
    typeof candidate.headSha === 'string'
  );
}

function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<FileChange>;
  return typeof candidate.filename === 'string' && typeof candidate.status === 'string';
}

function createWorkflowLineValidator(
  platform: WorkflowPlatform,
  source: ReviewSource
): LineValidator | undefined {
  const pullRequest = isPullRequest(source.context.pullRequest) ? source.context.pullRequest : null;
  const platformData = pullRequest?.platformData as { diff_refs?: GitLabDiffRefs } | undefined;
  const diffRefs = platformData?.diff_refs;
  if (platform === 'gitlab' && (!diffRefs?.base_sha || !diffRefs.head_sha || !diffRefs.start_sha)) {
    return undefined;
  }

  const fileChanges = Array.isArray(source.context.changedFiles)
    ? source.context.changedFiles.filter(isFileChange)
    : [];
  const patchSources = fileChanges.length > 0 ? fileChanges : (source.filesWithDiffs ?? []);
  const validLinesMap = new Map<string, Set<number>>();
  const changedLinesMap = new Map<string, Set<number>>();
  for (const file of patchSources) {
    if ('status' in file && file.status === 'removed') {
      continue;
    }
    const patch = file.patch;
    if (patch) {
      const lineInfo = parseDiffLineInfo(patch);
      validLinesMap.set(file.filename, lineInfo.commentableLines);
      changedLinesMap.set(file.filename, lineInfo.addedLines);
    }
  }

  return {
    isValidLine(file: string, line: number): boolean {
      return validLinesMap.get(file)?.has(line) ?? false;
    },
    isChangedLine(file: string, line: number): boolean {
      return changedLinesMap.get(file)?.has(line) ?? false;
    },
  };
}

function createWorkflowInlinePosition(
  platform: WorkflowPlatform,
  source: ReviewSource
): ((issue: ReviewIssue, platformData: unknown) => InlineCommentPosition) | undefined {
  const pullRequest = isPullRequest(source.context.pullRequest) ? source.context.pullRequest : null;
  if (!pullRequest) {
    return undefined;
  }

  if (platform === 'github') {
    return (issue: ReviewIssue) => ({
      path: issue.file,
      line: issue.line!,
      commitSha: pullRequest.headSha,
    });
  }

  return (issue: ReviewIssue, platformData: unknown) => {
    const data = platformData as { diff_refs?: GitLabDiffRefs } | undefined;
    const refs = data?.diff_refs;
    return {
      path: issue.file,
      line: issue.line!,
      baseSha: refs?.base_sha,
      headSha: refs?.head_sha,
      startSha: refs?.start_sha,
    };
  };
}

function isReviewResult(value: unknown): value is ReviewResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ReviewResult>;
  return Array.isArray(candidate.issues) && typeof candidate.summary === 'object';
}

function getReviewSourceDiffCommand(source: ReviewSource, baseBranch?: string): string {
  const pullRequest = isPullRequest(source.context.pullRequest) ? source.context.pullRequest : null;
  if (pullRequest) {
    return getCanonicalDiffCommand(
      pullRequest,
      resolveBaseBranch(baseBranch, pullRequest.targetBranch)
    );
  }

  return source.staged ? 'git diff --cached -- <file>' : 'git diff -- <file>';
}

function getReviewContextFiles(
  config: DRSConfig,
  source: ReviewSource,
  fileFilter?: string
): FileWithDiff[] {
  const filteredFiles = filterIgnoredFiles(source.files, config);
  const patchByFile = new Map(
    (source.filesWithDiffs ?? []).map((file) => [file.filename, file.patch])
  );
  const files = filteredFiles.map((filename) => ({
    filename,
    patch: patchByFile.get(filename),
  }));

  if (!fileFilter) {
    return files;
  }

  const matches = files.filter((file) => file.filename === fileFilter);
  if (matches.length === 0) {
    throw new Error(`No matching file "${fileFilter}" found in review source.`);
  }
  return matches;
}

async function runReviewContextWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = context.artifacts[sourceArtifact];
  if (!isReviewSource(source)) {
    throw new Error(
      `Workflow review-context node "${nodeId}" needs a ReviewSource artifact. ` +
        'Set with.source to a change-source output.'
    );
  }

  const rawFileFilter = getStringActionOption(node, 'file', context)?.trim();
  const rawBaseBranch = getStringActionOption(node, 'baseBranch', context)?.trim();
  const fileFilter = rawFileFilter === '' ? undefined : rawFileFilter;
  const baseBranch = rawBaseBranch === '' ? undefined : rawBaseBranch;
  const files = getReviewContextFiles(config, source, fileFilter);
  const instructions = buildBaseInstructions(
    source.name,
    files,
    getReviewSourceDiffCommand(source, baseBranch)
  );
  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(workingDir, writes, instructions);
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: instructions,
    output: instructions,
    writes,
  };
}

function getDescribeFiles(source: ReviewSource, target: WorkflowPostTarget): FileWithDiff[] {
  if (source.filesWithDiffs && source.filesWithDiffs.length > 0) {
    return source.filesWithDiffs;
  }

  return (target.changedFiles ?? [])
    .filter((file) => file.status !== 'removed')
    .map((file) => ({ filename: file.filename, patch: file.patch }));
}

async function runCodeQualityReportWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const reviewArtifact = getStringActionOption(node, 'review', context) ?? 'review';
  const reviewResult = context.artifacts[reviewArtifact];
  if (!isReviewResult(reviewResult)) {
    throw new Error(`Workflow code-quality-report node "${nodeId}" needs a ReviewResult artifact.`);
  }

  const reportPath = hasActionOption(node, 'path')
    ? requireStringActionOption(nodeId, node, 'path', context)
    : renderNodeWritesPath(nodeId, node, context);
  if (!reportPath) {
    throw new Error(
      `Workflow code-quality-report node "${nodeId}" must define with.path or writes.`
    );
  }

  const report = generateCodeQualityReport(reviewResult.issues);
  await writeWorkflowFile(workingDir, reportPath, formatCodeQualityReport(report));

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `wrote GitLab code quality report to ${reportPath}`,
    output: {
      path: reportPath,
      issues: report.length,
    },
    writes: reportPath,
  };
}

async function runDescribeWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = context.artifacts[sourceArtifact];
  if (!isReviewSource(source)) {
    throw new Error(
      `Workflow describe node "${nodeId}" needs a ReviewSource artifact. ` +
        'Set with.source to a change-source output.'
    );
  }

  const target = resolvePostTarget(nodeId, node, context, executionContext, source);
  if (!target.pullRequest) {
    throw new Error(`Workflow describe node "${nodeId}" needs a platform change-source target.`);
  }

  const shouldPostDescription =
    getBooleanActionOption(node, 'post', context) ||
    getBooleanActionOption(node, 'postDescription', context);
  const runtimeClient = await connectToRuntime(config, source.workingDir ?? workingDir, {
    debug: options.debug,
    modelOverrides: getDescriberModelOverride(config),
    thinkingLevel: options.thinkingLevel,
  });

  let description: Description | null = null;
  try {
    description = await runDescribeIfEnabled(
      runtimeClient,
      config,
      target.platformClient,
      target.projectId,
      target.pullRequest,
      getDescribeFiles(source, target),
      shouldPostDescription,
      source.workingDir ?? workingDir,
      options.debug
    );
  } finally {
    await runtimeClient.shutdown();
  }

  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(workingDir, writes, JSON.stringify(description, null, 2));
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: description ? JSON.stringify(description, null, 2) : 'description generation skipped',
    output: description,
    writes,
  };
}

function formatMarkedComment(body: string, marker: string | undefined): string {
  if (!marker) {
    return body;
  }

  const markerComment = `<!-- drs-comment-id: ${marker} -->`;
  return body.includes(markerComment) ? body : `${markerComment}\n${body}`;
}

async function runPostCommentWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = isReviewSource(context.artifacts[sourceArtifact])
    ? context.artifacts[sourceArtifact]
    : undefined;
  const target = resolvePostTarget(nodeId, node, context, executionContext, source);
  const rawBody =
    node.input === undefined
      ? requireStringActionOption(nodeId, node, 'body', context)
      : renderTemplate(node.input, context);
  const marker = getStringActionOption(node, 'marker', context)?.trim();
  const body = formatMarkedComment(rawBody, marker);
  let operation = 'created';

  if (marker) {
    const comments = await target.platformClient.getComments(target.projectId, target.prNumber);
    const existingComment = findExistingCommentById(comments, marker);
    if (existingComment) {
      await withWorkflowConsoleSuppressed(executionContext, options.jsonOutput === true, () =>
        target.platformClient.updateComment(
          target.projectId,
          target.prNumber,
          existingComment.id,
          body
        )
      );
      operation = 'updated';
    } else {
      await withWorkflowConsoleSuppressed(executionContext, options.jsonOutput === true, () =>
        target.platformClient.createComment(target.projectId, target.prNumber, body)
      );
    }
  } else {
    await withWorkflowConsoleSuppressed(executionContext, options.jsonOutput === true, () =>
      target.platformClient.createComment(target.projectId, target.prNumber, body)
    );
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `${operation} comment on ${target.platform} ${target.projectId}#${target.prNumber}`,
    output: {
      platform: target.platform,
      projectId: target.projectId,
      prNumber: target.prNumber,
      marker,
      operation,
    },
  };
}

async function runPostReviewCommentsWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const reviewArtifact = getStringActionOption(node, 'review', context) ?? 'review';
  const source = context.artifacts[sourceArtifact];
  const reviewResult = context.artifacts[reviewArtifact];
  if (!isReviewSource(source)) {
    throw new Error(
      `Workflow post-review-comments node "${nodeId}" needs a ReviewSource artifact.`
    );
  }
  if (!isReviewResult(reviewResult)) {
    throw new Error(
      `Workflow post-review-comments node "${nodeId}" needs a ReviewResult artifact.`
    );
  }

  const target = resolvePostTarget(nodeId, node, context, executionContext, source);
  const pullRequest = target.pullRequest;
  const platformData = pullRequest?.platformData;
  const lineValidator = createWorkflowLineValidator(target.platform, source);
  const createInlinePosition = lineValidator
    ? createWorkflowInlinePosition(target.platform, source)
    : undefined;
  const shouldRemoveErrorComment =
    !hasActionOption(node, 'removeErrorComment') ||
    getBooleanActionOption(node, 'removeErrorComment', context);
  await withWorkflowConsoleSuppressed(executionContext, options.jsonOutput === true, async () => {
    if (shouldRemoveErrorComment) {
      await removeErrorComment(target.platformClient, target.projectId, target.prNumber);
    }

    const cursorFixLinks = resolveCursorFixLinkOptions(config, target.projectId, workingDir);
    await postReviewComments(
      target.platformClient,
      target.projectId,
      target.prNumber,
      reviewResult.summary,
      reviewResult.issues,
      reviewResult.changeSummary,
      reviewResult.usage,
      platformData,
      lineValidator,
      createInlinePosition,
      cursorFixLinks,
      pullRequest
        ? {
            headSha: pullRequest.headSha,
            sourceBranch: pullRequest.sourceBranch,
            targetBranch: pullRequest.targetBranch,
          }
        : undefined
    );
  });

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `posted review comments on ${target.platform} ${target.projectId}#${target.prNumber}`,
    output: {
      platform: target.platform,
      projectId: target.projectId,
      prNumber: target.prNumber,
      issues: reviewResult.issues.length,
    },
  };
}

function isReviewSource(value: unknown): value is ReviewSource {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ReviewSource>;
  return (
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.files) &&
    typeof candidate.context === 'object' &&
    candidate.context !== null
  );
}

async function enforceWorkflowReviewTarget(
  config: DRSConfig,
  source: ReviewSource,
  workingDir: string
): Promise<void> {
  const platform =
    typeof source.context.platform === 'string' ? source.context.platform : undefined;
  if (!isWorkflowPlatform(platform)) {
    return;
  }

  const projectId =
    typeof source.context.projectId === 'string' ? source.context.projectId : undefined;
  const pullRequest = isPullRequest(source.context.pullRequest)
    ? source.context.pullRequest
    : undefined;
  if (!projectId || !pullRequest) {
    throw new Error('Workflow platform review source is missing project or PR/MR metadata.');
  }

  await enforceRepoBranchMatch(workingDir, projectId, pullRequest, {
    skipRepoCheck: config.review.skipRepoCheck,
    skipBranchCheck: config.review.skipBranchCheck,
  });
}

async function runReviewWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = context.artifacts[sourceArtifact];
  if (!isReviewSource(source)) {
    throw new Error(
      `Workflow review node "${nodeId}" needs a ReviewSource artifact. ` +
        'Set with.source to a change-source output.'
    );
  }

  const reviewResult = await withWorkflowLock(executionContext.locks.exit, async () => {
    const restoreExit = setExitHandler((code: number): never => {
      throw new ExitError(code);
    });
    const originalLog = console.log;
    const originalWarn = console.warn;

    if (options.jsonOutput) {
      console.log = () => undefined;
      console.warn = () => undefined;
    }

    try {
      await enforceWorkflowReviewTarget(config, source, source.workingDir ?? workingDir);
      return await executeReview(config, {
        ...source,
        workingDir: source.workingDir ?? workingDir,
        debug: options.debug,
        thinkingLevel: options.thinkingLevel,
      });
    } catch (error) {
      if (error instanceof ExitError) {
        throw new Error(`Workflow review node "${nodeId}" failed: all review agents failed.`);
      }
      throw error;
    } finally {
      if (options.jsonOutput) {
        console.log = originalLog;
        console.warn = originalWarn;
      }
      restoreExit();
    }
  });

  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(workingDir, writes, JSON.stringify(reviewResult, null, 2));
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: JSON.stringify(reviewResult.summary, null, 2),
    output: reviewResult,
    writes,
  };
}

function recordNodeArtifact(
  nodeId: string,
  node: WorkflowNodeConfig,
  result: WorkflowNodeResult,
  artifacts: Record<string, unknown>
): void {
  const artifactValue = result.output ?? result.response ?? result.responses;
  artifacts[nodeId] = artifactValue;
  if (node.output) {
    artifacts[node.output] = artifactValue;
  }
}

type WorkflowSegment =
  | { type: 'dag'; nodeIds: string[]; activeNodeIds?: Set<string> }
  | { type: 'control'; nodeId: string };

function parseWorkflowExpressionValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function isWorkflowTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return (
      normalized.length > 0 && normalized !== 'false' && normalized !== '0' && normalized !== 'no'
    );
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function normalizeWorkflowBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function compareWorkflowValues(left: unknown, operator: string, right: unknown): boolean {
  if (operator === '==' || operator === '!=') {
    const leftBoolean = normalizeWorkflowBooleanLike(left);
    const rightBoolean = normalizeWorkflowBooleanLike(right);
    const matches =
      leftBoolean !== undefined || rightBoolean !== undefined
        ? leftBoolean === rightBoolean
        : String(left) === String(right);
    return operator === '==' ? matches : !matches;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    throw new Error(`Workflow expression operator "${operator}" requires numeric values.`);
  }

  if (operator === '>') return leftNumber > rightNumber;
  if (operator === '>=') return leftNumber >= rightNumber;
  if (operator === '<') return leftNumber < rightNumber;
  if (operator === '<=') return leftNumber <= rightNumber;
  throw new Error(`Unsupported workflow expression operator "${operator}".`);
}

function evaluateWorkflowExpression(expression: string, context: WorkflowTemplateContext): boolean {
  const rendered = renderTemplate(expression, context).trim();
  const match = rendered.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) {
    return isWorkflowTruthy(parseWorkflowExpressionValue(rendered));
  }

  return compareWorkflowValues(
    parseWorkflowExpressionValue(match[1] ?? ''),
    match[2] ?? '',
    parseWorkflowExpressionValue(match[3] ?? '')
  );
}

function splitWorkflowSegments(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[]
): WorkflowSegment[] {
  const segments: WorkflowSegment[] = [];
  let currentDag: string[] = [];

  for (const nodeId of executionOrder) {
    const node = workflowNodes[nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${nodeId}".`);
    }

    if (node.control !== undefined) {
      if (currentDag.length > 0) {
        segments.push({ type: 'dag', nodeIds: currentDag });
        currentDag = [];
      }
      segments.push({ type: 'control', nodeId });
    } else {
      currentDag.push(nodeId);
    }
  }

  if (currentDag.length > 0) {
    segments.push({ type: 'dag', nodeIds: currentDag });
  }

  return segments;
}

function findWorkflowSegmentIndex(segments: WorkflowSegment[], targetNodeId: string): number {
  return segments.findIndex((segment) =>
    segment.type === 'control'
      ? segment.nodeId === targetNodeId
      : segment.nodeIds.includes(targetNodeId)
  );
}

function computeActiveWorkflowNodes(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  nodeIds: string[],
  rootNodeId: string
): Set<string> {
  const segmentNodeIds = new Set(nodeIds);
  const downstream = new Set<string>([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of nodeIds) {
      if (downstream.has(nodeId)) continue;
      const needs = getNodeNeeds(workflowNodes[nodeId] ?? {});
      if (needs.some((dependency) => downstream.has(dependency))) {
        downstream.add(nodeId);
        changed = true;
      }
    }
  }

  const active = new Set(downstream);
  const includeDependencies = (nodeId: string) => {
    const node = workflowNodes[nodeId];
    if (!node) return;
    for (const dependency of getNodeNeeds(node)) {
      if (!segmentNodeIds.has(dependency) || active.has(dependency)) continue;
      active.add(dependency);
      includeDependencies(dependency);
    }
  };

  for (const nodeId of downstream) {
    includeDependencies(nodeId);
  }

  return active;
}

function createSkippedWorkflowNodeResult(nodeId: string): WorkflowNodeResult {
  return {
    id: nodeId,
    type: 'skipped',
    status: 'skipped',
    response: '',
    output: undefined,
  };
}

function recordWorkflowNodeResult(
  nodeId: string,
  node: WorkflowNodeConfig,
  result: WorkflowNodeResult,
  nodes: Record<string, WorkflowNodeResult>,
  artifacts: Record<string, unknown>
): void {
  nodes[nodeId] = result;
  if (result.status !== 'skipped') {
    recordNodeArtifact(nodeId, node, result, artifacts);
  }
}

async function runWorkflowDagSegment(
  config: DRSConfig,
  workflowNodes: Record<string, WorkflowNodeConfig>,
  nodeIds: string[],
  activeNodeIds: Set<string> | undefined,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<void> {
  const completed = new Set<string>();
  const segmentNodeIds = new Set(nodeIds);

  if (activeNodeIds) {
    for (const nodeId of nodeIds) {
      if (!activeNodeIds.has(nodeId)) {
        completed.add(nodeId);
        context.nodes[nodeId] = createSkippedWorkflowNodeResult(nodeId);
      }
    }
  }

  while (completed.size < nodeIds.length) {
    const runnable = nodeIds.filter((nodeId) => {
      if (completed.has(nodeId)) return false;
      const node = workflowNodes[nodeId];
      if (!node) return false;
      return getNodeNeeds(node).every(
        (dependency) => completed.has(dependency) || !segmentNodeIds.has(dependency)
      );
    });

    if (runnable.length === 0) {
      throw new Error('Workflow control runner could not make progress in a DAG segment.');
    }

    const settled = await Promise.allSettled(
      runnable.map(async (nodeId) => {
        const node = workflowNodes[nodeId];
        if (!node) {
          throw new Error(`Workflow references unknown node "${nodeId}".`);
        }

        if (!options.jsonOutput) {
          console.log(chalk.gray(`Running node ${nodeId}...`));
        }

        const result = await runSingleWorkflowNode(
          config,
          nodeId,
          node,
          options,
          workingDir,
          context,
          executionContext
        );
        return { nodeId, node, result };
      })
    );

    const firstRejection = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (firstRejection) {
      throw firstRejection.reason instanceof Error
        ? firstRejection.reason
        : new Error(String(firstRejection.reason));
    }

    for (const outcome of settled) {
      const { nodeId, node, result } = (
        outcome as PromiseFulfilledResult<{
          nodeId: string;
          node: WorkflowNodeConfig;
          result: WorkflowNodeResult;
        }>
      ).value;
      completed.add(nodeId);
      recordWorkflowNodeResult(nodeId, node, result, context.nodes, context.artifacts);
    }
  }
}

function runControlWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): { result: WorkflowNodeResult; nextNodeId?: string; ended?: boolean } {
  if (node.control === 'condition') {
    if (!node.if) {
      throw new Error(`Workflow condition node "${nodeId}" must define if.`);
    }
    const matched = evaluateWorkflowExpression(node.if, context);
    const nextNodeId = matched ? node.then : node.else;
    if (!nextNodeId) {
      throw new Error(
        `Workflow condition node "${nodeId}" must define ${matched ? 'then' : 'else'}.`
      );
    }
    return {
      nextNodeId,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision: matched ? 'then' : 'else',
        target: nextNodeId,
        response: String(matched),
        output: { matched, target: nextNodeId },
      },
    };
  }

  if (node.control === 'loop') {
    const expression = node.condition ?? node.if;
    if (!expression) {
      throw new Error(`Workflow loop node "${nodeId}" must define condition or if.`);
    }
    if (!node.target || !node.exit) {
      throw new Error(`Workflow loop node "${nodeId}" must define target and exit.`);
    }
    const configuredMaxIterations = node.maxIterations;
    if (
      !Number.isInteger(configuredMaxIterations) ||
      configuredMaxIterations === undefined ||
      configuredMaxIterations <= 0
    ) {
      throw new Error(`Workflow loop node "${nodeId}" must define a positive maxIterations.`);
    }
    const maxIterations = configuredMaxIterations;

    const shouldLoop = evaluateWorkflowExpression(expression, context);
    const current = context.loop[nodeId] ?? { iteration: 0, maxIterations };
    let nextNodeId = node.exit;
    let decision: 'loop' | 'exit' = 'exit';

    if (shouldLoop) {
      if (current.iteration >= maxIterations) {
        if (node.onMaxIterations === 'exit') {
          nextNodeId = node.exit;
        } else {
          throw new Error(
            `Workflow loop node "${nodeId}" reached maxIterations (${maxIterations}).`
          );
        }
      } else {
        decision = 'loop';
        nextNodeId = node.target;
        current.iteration += 1;
      }
    }

    current.maxIterations = maxIterations;
    current.lastDecision = decision;
    context.loop[nodeId] = current;

    return {
      nextNodeId,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision,
        target: nextNodeId,
        response: decision,
        output: {
          matched: shouldLoop,
          target: nextNodeId,
          iteration: current.iteration,
          maxIterations,
        },
      },
    };
  }

  if (node.control === 'switch') {
    if (!node.value || !node.cases) {
      throw new Error(`Workflow switch node "${nodeId}" must define value and cases.`);
    }
    const value = renderTemplate(node.value, context).trim();
    const nextNodeId = node.cases[value] ?? node.default;
    if (!nextNodeId) {
      throw new Error(`Workflow switch node "${nodeId}" has no case for "${value}" or default.`);
    }
    return {
      nextNodeId,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision: value,
        target: nextNodeId,
        response: value,
        output: { value, target: nextNodeId },
      },
    };
  }

  if (node.control === 'end') {
    return {
      ended: true,
      result: {
        id: nodeId,
        type: 'control',
        status: 'success',
        control: node.control,
        decision: 'end',
        response: 'end',
        output: { ended: true },
      },
    };
  }

  throw new Error(`Unsupported workflow control "${node.control}" in node "${nodeId}".`);
}

async function runControlWorkflow(
  config: DRSConfig,
  workflowNodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[],
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<void> {
  const segments = splitWorkflowSegments(workflowNodes, executionOrder);
  let segmentIndex = 0;

  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex];
    if (segment.type === 'dag') {
      await runWorkflowDagSegment(
        config,
        workflowNodes,
        segment.nodeIds,
        segment.activeNodeIds,
        options,
        workingDir,
        context,
        executionContext
      );
      segmentIndex += 1;
      continue;
    }

    const node = workflowNodes[segment.nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${segment.nodeId}".`);
    }
    if (!options.jsonOutput) {
      console.log(chalk.gray(`Running node ${segment.nodeId}...`));
    }
    const { result, nextNodeId, ended } = runControlWorkflowNode(segment.nodeId, node, context);
    recordWorkflowNodeResult(segment.nodeId, node, result, context.nodes, context.artifacts);

    if (ended) {
      return;
    }

    if (!nextNodeId) {
      segmentIndex += 1;
      continue;
    }

    const targetIndex = findWorkflowSegmentIndex(segments, nextNodeId);
    if (targetIndex < 0) {
      throw new Error(
        `Workflow control node "${segment.nodeId}" targets unknown node "${nextNodeId}".`
      );
    }
    const targetSegment = segments[targetIndex];
    if (targetSegment.type === 'dag') {
      targetSegment.activeNodeIds = computeActiveWorkflowNodes(
        workflowNodes,
        targetSegment.nodeIds,
        nextNodeId
      );
    }
    segmentIndex = targetIndex;
  }
}

function formatWorkflowJson(result: WorkflowRunResult): string {
  return JSON.stringify(result, null, 2);
}

async function runSingleWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const kind = getNodeKind(node);

  if (kind === 'agent') {
    return runAgentWorkflowNode(config, nodeId, node, options, workingDir, context);
  }
  if (kind === 'agents') {
    return runAgentsWorkflowNode(config, nodeId, node, options, workingDir, context);
  }
  if (kind === 'control') {
    throw new Error(`Workflow control node "${nodeId}" cannot run in the static DAG executor.`);
  }
  return runActionWorkflowNode(
    config,
    nodeId,
    node,
    options,
    workingDir,
    context,
    executionContext
  );
}

export async function runWorkflow(
  config: DRSConfig,
  workflowName: string,
  options: WorkflowRunOptions = {}
): Promise<WorkflowRunResult> {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }
  const workflowNodes = getWorkflowNodes(workflowName, workflow);

  const workingDir = options.workingDir ?? process.cwd();
  const inputs = await resolveWorkflowInputs(workflow, options, workingDir);
  const nodes: Record<string, WorkflowNodeResult> = {};
  const artifacts: Record<string, unknown> = {};
  const loop: Record<string, WorkflowLoopState> = {};
  const context: WorkflowTemplateContext = { inputs, nodes, artifacts, loop };
  const executionContext: WorkflowExecutionContext = {
    gitClients: new Map(),
    platformClients: {},
    locks: {
      exit: createWorkflowLock(),
      console: createWorkflowLock(),
    },
  };
  const executionOrder = getWorkflowExecutionOrder(workflowNodes);
  const executionWaves = getWorkflowExecutionWaves(workflowNodes, executionOrder);

  if (!options.jsonOutput) {
    console.log(chalk.gray(`Running workflow ${workflowName}...\n`));
  }

  if (hasWorkflowControlNodes(workflowNodes)) {
    await runControlWorkflow(
      config,
      workflowNodes,
      executionOrder,
      options,
      workingDir,
      context,
      executionContext
    );
  } else {
    for (const wave of executionWaves) {
      const settled = await Promise.allSettled(
        wave.map(async (nodeId) => {
          const node = workflowNodes[nodeId];
          if (!node) {
            throw new Error(`Workflow references unknown node "${nodeId}".`);
          }

          if (!options.jsonOutput) {
            console.log(chalk.gray(`Running node ${nodeId}...`));
          }

          const result = await runSingleWorkflowNode(
            config,
            nodeId,
            node,
            options,
            workingDir,
            context,
            executionContext
          );
          return { nodeId, node, result };
        })
      );

      const firstRejection = settled.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      if (firstRejection) {
        throw firstRejection.reason instanceof Error
          ? firstRejection.reason
          : new Error(String(firstRejection.reason));
      }

      for (const outcome of settled) {
        const { nodeId, node, result } = (
          outcome as PromiseFulfilledResult<{
            nodeId: string;
            node: WorkflowNodeConfig;
            result: WorkflowNodeResult;
          }>
        ).value;
        nodes[nodeId] = result;
        recordNodeArtifact(nodeId, node, result, artifacts);
      }
    }
  }

  const lastNodeId = executionOrder[executionOrder.length - 1];
  const lastNode = workflowNodes[lastNodeId];
  const outputKey = workflow.output ?? lastNode.output ?? lastNodeId;
  const result: WorkflowRunResult = {
    timestamp: new Date().toISOString(),
    workflow: workflowName,
    inputs,
    nodes,
    artifacts,
    loop,
    output: artifacts[outputKey],
  };

  if (options.outputPath) {
    await writeWorkflowFile(workingDir, options.outputPath, formatWorkflowJson(result));
    if (!options.jsonOutput) {
      console.log(chalk.green(`\n✓ Workflow output saved to ${options.outputPath}`));
    }
  }

  if (options.jsonOutput) {
    console.log(formatWorkflowJson(result));
  } else if (typeof result.output === 'string' && result.output.trim()) {
    console.log(`\n${result.output}`);
  }

  return result;
}

export interface WorkflowListEntry {
  name: string;
  source: WorkflowSource;
  overridden: boolean;
  description?: string;
}

export interface WorkflowListOptions {
  json?: boolean;
  workingDir?: string;
}

export interface WorkflowNodeDetail {
  id: string;
  kind: 'agent' | 'agents' | 'action' | 'control';
  needs: string[];
  agent?: string;
  agentsFrom?: string;
  action?: string;
  control?: string;
  if?: string;
  condition?: string;
  input?: string;
  with?: Record<string, string | number | boolean | undefined>;
  output?: string;
  writes?: string;
  json?: boolean;
  routes?: Record<string, string | Record<string, string> | undefined>;
}

export interface WorkflowDetail {
  name: string;
  source: WorkflowSource;
  overridden: boolean;
  description?: string;
  inputs: Record<string, WorkflowInputConfig>;
  output?: string;
  nodes: WorkflowNodeDetail[];
}

export interface WorkflowShowOptions {
  json?: boolean;
  workingDir?: string;
}

/**
 * List available workflows and their source origin.
 *
 * Packaged workflows are always returned. Project-defined workflows
 * appear as 'project' and mark any packaged workflow they replace
 * as overridden.
 */
export function listWorkflows(
  config: DRSConfig,
  options: WorkflowListOptions = {}
): WorkflowListEntry[] {
  const workingDir = options.workingDir ?? process.cwd();
  const sourceInfo = loadWorkflowSourceInfo(workingDir);
  const workflows = config.workflows ?? {};
  const entries = Object.entries(workflows)
    .map(([name, workflow]) => {
      const info = sourceInfo[name] ?? {
        source: 'packaged',
        overridesPackaged: false,
      };
      return {
        name,
        source: info.source,
        overridden: info.overridesPackaged,
        description: workflow.description,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    const sourceLabel = (source: WorkflowSource, overridden: boolean) => {
      const label = source === 'packaged' ? chalk.gray('packaged') : chalk.cyan('project');
      return overridden ? `${label} ${chalk.yellow('(overrides packaged)')}` : label;
    };

    console.log(chalk.bold('\n📋 Available Workflows:\n'));
    for (const entry of entries) {
      console.log(`  ${chalk.white(entry.name)}`);
      console.log(`    Source: ${sourceLabel(entry.source, entry.overridden)}`);
      if (entry.description) {
        console.log(`    ${chalk.gray(entry.description)}`);
      }
    }
    console.log('');
  }

  return entries;
}

function getWorkflowNodeRoutes(node: WorkflowNodeConfig): WorkflowNodeDetail['routes'] {
  if (node.control === 'condition') {
    return { then: node.then, else: node.else };
  }
  if (node.control === 'loop') {
    return { target: node.target, exit: node.exit };
  }
  if (node.control === 'switch') {
    return { cases: node.cases, default: node.default };
  }
  return undefined;
}

function formatWorkflowInput(input: WorkflowInputConfig): string {
  if (typeof input === 'string') {
    return JSON.stringify(input);
  }
  if (input.file !== undefined) {
    return `file:${input.file}`;
  }
  return JSON.stringify(input.value ?? '');
}

function buildWorkflowDetail(
  name: string,
  workflow: WorkflowConfig,
  workingDir: string
): WorkflowDetail {
  const sourceInfo = loadWorkflowSourceInfo(workingDir);
  const info = sourceInfo[name] ?? {
    source: 'packaged',
    overridesPackaged: false,
  };
  const workflowNodes = getWorkflowNodes(name, workflow);
  getWorkflowExecutionOrder(workflowNodes);

  return {
    name,
    source: info.source,
    overridden: info.overridesPackaged,
    description: workflow.description,
    inputs: workflow.inputs ?? {},
    output: workflow.output,
    nodes: Object.entries(workflowNodes).map(([nodeId, node]) => ({
      id: nodeId,
      kind: getNodeKind(node),
      needs: getNodeNeeds(node),
      agent: node.agent,
      agentsFrom: node.agentsFrom,
      action: node.action,
      control: node.control,
      if: node.if,
      condition: node.condition,
      input: node.input,
      with: node.with,
      output: node.output,
      writes: node.writes,
      json: node.json,
      routes: getWorkflowNodeRoutes(node),
    })),
  };
}

export function showWorkflow(
  config: DRSConfig,
  workflowName: string,
  options: WorkflowShowOptions = {}
): WorkflowDetail {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }

  const detail = buildWorkflowDetail(workflowName, workflow, options.workingDir ?? process.cwd());

  if (options.json) {
    console.log(JSON.stringify(detail, null, 2));
    return detail;
  }

  const sourceLabel = detail.source === 'packaged' ? chalk.gray('packaged') : chalk.cyan('project');
  const overridden = detail.overridden ? ` ${chalk.yellow('(overrides packaged)')}` : '';

  console.log(chalk.bold(`\nWorkflow: ${detail.name}\n`));
  console.log(`  Source: ${sourceLabel}${overridden}`);
  if (detail.description) {
    console.log(`  Description: ${detail.description}`);
  }
  if (detail.output) {
    console.log(`  Output: ${detail.output}`);
  }

  console.log(chalk.bold('\nInputs:'));
  const inputEntries = Object.entries(detail.inputs);
  if (inputEntries.length === 0) {
    console.log(chalk.gray('  (none)'));
  } else {
    for (const [key, input] of inputEntries) {
      console.log(`  ${key}: ${formatWorkflowInput(input)}`);
    }
  }

  console.log(chalk.bold('\nNodes:'));
  for (const node of detail.nodes) {
    console.log(`  ${node.id} (${node.kind})`);
    if (node.needs.length > 0) {
      console.log(`    needs: ${node.needs.join(', ')}`);
    }
    if (node.agent) console.log(`    agent: ${node.agent}`);
    if (node.agentsFrom) console.log(`    agentsFrom: ${node.agentsFrom}`);
    if (node.action) console.log(`    action: ${node.action}`);
    if (node.control) console.log(`    control: ${node.control}`);
    if (node.if) console.log(`    if: ${node.if}`);
    if (node.condition) console.log(`    condition: ${node.condition}`);
    if (node.output) console.log(`    output: ${node.output}`);
    if (node.writes) console.log(`    writes: ${node.writes}`);
    if (node.input) console.log(`    input: ${node.input.split('\n')[0]}`);
    if (node.with && Object.keys(node.with).length > 0) {
      console.log(`    with: ${JSON.stringify(node.with)}`);
    }
    if (node.routes && Object.keys(node.routes).length > 0) {
      console.log(`    routes: ${JSON.stringify(node.routes)}`);
    }
  }
  console.log('');

  return detail;
}
