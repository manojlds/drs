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
import { normalizeAgentConfig, resolveAgentRunConfig } from '../lib/config.js';
import { resolveWithinWorkingDir } from '../lib/path-utils.js';
import { parseDiff, getChangedFiles, getFilesWithDiffs } from '../lib/diff-parser.js';
import { executeReview, type ReviewSource } from '../lib/review-orchestrator.js';
import { ExitError, setExitHandler } from '../lib/exit.js';
import type { FileChange, PullRequest } from '../lib/platform-client.js';
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
  type: 'agent' | 'agents' | 'action';
  agent?: string;
  agents?: string[];
  action?: string;
  response?: string;
  responses?: AgentRunResult[];
  output?: unknown;
  writes?: string;
}

export interface WorkflowRunResult {
  timestamp: string;
  workflow: string;
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
  output?: unknown;
}

interface WorkflowTemplateContext {
  inputs: Record<string, string>;
  nodes: Record<string, WorkflowNodeResult>;
  artifacts: Record<string, unknown>;
}

// Review execution temporarily mutates process globals, so review nodes must not overlap.
let reviewWorkflowNodeGlobalLock: Promise<void> = Promise.resolve();

async function withReviewWorkflowNodeGlobals<T>(run: () => Promise<T>): Promise<T> {
  const previousLock = reviewWorkflowNodeGlobalLock;
  let releaseLock!: () => void;
  reviewWorkflowNodeGlobalLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    return await run();
  } finally {
    releaseLock();
  }
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

  return order;
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

function getNodeKind(node: WorkflowNodeConfig): 'agent' | 'agents' | 'action' {
  const configuredKinds = [node.agent, node.agentsFrom, node.action].filter(
    (value) => value !== undefined
  ).length;

  if (configuredKinds !== 1) {
    throw new Error('Workflow node must define exactly one of agent, agentsFrom, or action.');
  }

  if (node.agent !== undefined) return 'agent';
  if (node.agentsFrom !== undefined) return 'agents';
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
  if (writes) {
    await writeWorkflowFile(
      workingDir,
      writes,
      node.json === true ? JSON.stringify(result, null, 2) : result.response
    );
  }

  return {
    id: nodeId,
    type: 'agent',
    agent: agentId,
    response: result.response,
    output: result.response,
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
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  if (node.action === 'write') {
    return runWriteWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'git-diff') {
    return runGitDiffWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'change-source') {
    return runChangeSourceWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'review') {
    return runReviewWorkflowNode(config, nodeId, node, options, workingDir, context);
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

function getBooleanActionOption(node: WorkflowNodeConfig, key: string): boolean {
  const value = node.with?.[key];
  return value === true || value === 'true';
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

async function runGitDiffWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const git = simpleGit({ baseDir: workingDir });
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Workflow git-diff node "${nodeId}" must run from a git repository.`);
  }

  const staged = getBooleanActionOption(node, 'staged');
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

async function loadLocalChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string
): Promise<ReviewSource> {
  const git = simpleGit({ baseDir: workingDir });
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Workflow change-source node "${nodeId}" must run from a git repository.`);
  }

  const staged = getBooleanActionOption(node, 'staged');
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
    },
    workingDir,
  };
}

async function loadGitHubChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<ReviewSource> {
  const owner = requireStringActionOption(nodeId, node, 'owner', context);
  const repo = requireStringActionOption(nodeId, node, 'repo', context);
  const prNumber = requireNumberActionOption(nodeId, node, 'pr', context);
  const projectId = `${owner}/${repo}`;
  const platformClient = new GitHubPlatformAdapter(createGitHubClient());
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
  context: WorkflowTemplateContext
): Promise<ReviewSource> {
  const projectId = hasActionOption(node, 'project')
    ? requireStringActionOption(nodeId, node, 'project', context)
    : requireStringActionOption(nodeId, node, 'projectId', context);
  const mrIid = hasActionOption(node, 'mr')
    ? requireNumberActionOption(nodeId, node, 'mr', context)
    : requireNumberActionOption(nodeId, node, 'mrIid', context);
  const platformClient = new GitLabPlatformAdapter(createGitLabClient());
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
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const type = getStringActionOption(node, 'type', context) ?? 'local';
  let source: ReviewSource;
  if (type === 'local') {
    source = await loadLocalChangeSource(nodeId, node, workingDir);
  } else if (type === 'github-pr') {
    source = await loadGitHubChangeSource(nodeId, node, workingDir, context);
  } else if (type === 'gitlab-mr') {
    source = await loadGitLabChangeSource(nodeId, node, workingDir, context);
  } else {
    throw new Error(
      `Unsupported workflow change-source type "${type}" in node "${nodeId}". ` +
        'Currently supported: local, github-pr, gitlab-mr.'
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

async function runReviewWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = context.artifacts[sourceArtifact];
  if (!isReviewSource(source)) {
    throw new Error(
      `Workflow review node "${nodeId}" needs a ReviewSource artifact. ` +
        'Set with.source to a change-source output.'
    );
  }

  const reviewResult = await withReviewWorkflowNodeGlobals(async () => {
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

function formatWorkflowJson(result: WorkflowRunResult): string {
  return JSON.stringify(result, null, 2);
}

async function runSingleWorkflowNode(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const kind = getNodeKind(node);

  if (kind === 'agent') {
    return runAgentWorkflowNode(config, nodeId, node, options, workingDir, context);
  }
  if (kind === 'agents') {
    return runAgentsWorkflowNode(config, nodeId, node, options, workingDir, context);
  }
  return runActionWorkflowNode(config, nodeId, node, options, workingDir, context);
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
  const context: WorkflowTemplateContext = { inputs, nodes, artifacts };
  const executionOrder = getWorkflowExecutionOrder(workflowNodes);
  const executionWaves = getWorkflowExecutionWaves(workflowNodes, executionOrder);

  if (!options.jsonOutput) {
    console.log(chalk.gray(`Running workflow ${workflowName}...\n`));
  }

  for (const wave of executionWaves) {
    const results = await Promise.all(
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
          context
        );
        return { nodeId, node, result };
      })
    );

    for (const { nodeId, node, result } of results) {
      nodes[nodeId] = result;
      recordNodeArtifact(nodeId, node, result, artifacts);
    }
  }

  const lastNodeId = executionOrder[executionOrder.length - 1];
  const lastNode = workflowNodes[lastNodeId];
  const outputKey = lastNode.output ?? lastNodeId;
  const result: WorkflowRunResult = {
    timestamp: new Date().toISOString(),
    workflow: workflowName,
    inputs,
    nodes,
    artifacts,
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
