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
import { executeReview, type ReviewResult, type ReviewSource } from '../lib/review-orchestrator.js';
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
    `Unsupported workflow agentsFrom "${agentsFrom}". Currently supported: review.agents.`
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
  const outputPath = resolveWithinWorkingDir(workingDir, relativeOutputPath, 'write');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf-8');
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
      `Workflow agent node "${nodeId}" must define input or configure agents.overrides.${agentId}.run.prompt/promptFile.`
    );
  }

  const result = await runAgent(config, agentId, createAgentOptions(prompt, options, workingDir));
  const writes = node.writes ? renderTemplate(node.writes, context) : undefined;
  if (writes) {
    await writeWorkflowFile(
      workingDir,
      writes,
      node.json ? JSON.stringify(result, null, 2) : result.response
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
        `Workflow agentsFrom node "${nodeId}" must define input or configure agents.overrides.${missingPromptAgent}.run.prompt/promptFile.`
      );
    }
  }

  const responses: AgentRunResult[] = [];
  for (const agentId of agentIds) {
    responses.push(
      await runAgent(config, agentId, createAgentOptions(prompt, options, workingDir))
    );
  }

  const response = responses
    .map((result) => `## ${result.agent}\n\n${result.response.trim()}`.trim())
    .join('\n\n');
  const writes = node.writes ? renderTemplate(node.writes, context) : undefined;
  if (writes) {
    await writeWorkflowFile(
      workingDir,
      writes,
      node.json ? JSON.stringify(responses, null, 2) : response
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
  const relativeOutputPath = renderTemplate(node.writes, context);
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
  const writes = node.writes ? renderTemplate(node.writes, context) : undefined;
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

async function runChangeSourceWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const type = getStringActionOption(node, 'type', context) ?? 'local';
  if (type !== 'local') {
    throw new Error(
      `Unsupported workflow change-source type "${type}" in node "${nodeId}". Currently supported: local.`
    );
  }

  const source = await loadLocalChangeSource(nodeId, node, workingDir);
  const writes = node.writes ? renderTemplate(node.writes, context) : undefined;
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
      `Workflow review node "${nodeId}" needs a ReviewSource artifact. Set with.source to a change-source output.`
    );
  }

  const reviewResult: ReviewResult = await executeReview(config, {
    ...source,
    workingDir: source.workingDir ?? workingDir,
    debug: options.debug,
    thinkingLevel: options.thinkingLevel,
  });
  const writes = node.writes ? renderTemplate(node.writes, context) : undefined;
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

export async function runWorkflow(
  config: DRSConfig,
  workflowName: string,
  options: WorkflowRunOptions = {}
): Promise<WorkflowRunResult> {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }
  if (!workflow.nodes || Object.keys(workflow.nodes).length === 0) {
    throw new Error(`Workflow "${workflowName}" must define at least one node.`);
  }

  const workingDir = options.workingDir ?? process.cwd();
  const inputs = await resolveWorkflowInputs(workflow, options, workingDir);
  const nodes: Record<string, WorkflowNodeResult> = {};
  const artifacts: Record<string, unknown> = {};
  const context: WorkflowTemplateContext = { inputs, nodes, artifacts };
  const executionOrder = getWorkflowExecutionOrder(workflow.nodes);

  if (!options.jsonOutput) {
    console.log(chalk.gray(`Running workflow ${workflowName}...\n`));
  }

  for (const nodeId of executionOrder) {
    const node = workflow.nodes[nodeId];
    const kind = getNodeKind(node);

    if (!options.jsonOutput) {
      console.log(chalk.gray(`Running node ${nodeId}...`));
    }

    let result: WorkflowNodeResult;
    if (kind === 'agent') {
      result = await runAgentWorkflowNode(config, nodeId, node, options, workingDir, context);
    } else if (kind === 'agents') {
      result = await runAgentsWorkflowNode(config, nodeId, node, options, workingDir, context);
    } else {
      result = await runActionWorkflowNode(config, nodeId, node, options, workingDir, context);
    }

    nodes[nodeId] = result;
    recordNodeArtifact(nodeId, node, result, artifacts);
  }

  const lastNodeId = executionOrder[executionOrder.length - 1];
  const lastNode = workflow.nodes[lastNodeId];
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
