import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import simpleGit from 'simple-git';
import chalk from 'chalk';
import type {
  DRSConfig,
  WorkflowConfig,
  WorkflowInputConfig,
  WorkflowMetadata,
  WorkflowNodeConfig,
} from '../lib/config.js';
import {
  getDescriberModelOverride,
  getReviewAgentIds,
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
  type ReviewVerificationFinding,
  type ReviewResult,
  type ReviewSource,
} from '../lib/review-orchestrator.js';
import type {
  FileChange,
  InlineCommentPosition,
  LineValidator,
  PlatformClient,
  PullRequest,
} from '../lib/platform-client.js';
import type { ReviewIssue } from '../lib/comment-formatter.js';
import { postReviewComments } from '../lib/comment-poster.js';
import { findExistingCommentById, createIssueFingerprint } from '../lib/comment-manager.js';
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
import { getCanonicalDiffCommand, resolveBaseBranch } from '../lib/repository-validator.js';
import { formatCodeQualityReport, generateCodeQualityReport } from '../lib/code-quality-report.js';
import {
  formatOkfValidationErrors,
  synchronizeOkfIndexes,
  validateOkfBundle,
} from '../lib/okf-wiki.js';
import { checkWikiClean, planWikiUpdate, recordWikiState } from '../lib/wiki-delta.js';
import { createGitHubClient } from '../github/client.js';
import { GitHubPlatformAdapter } from '../github/platform-adapter.js';
import { createGitLabClient } from '../gitlab/client.js';
import { GitLabPlatformAdapter } from '../gitlab/platform-adapter.js';
import {
  loadWorkflowArtifact,
  saveWorkflowArtifact,
  updateWorkflowArtifact,
  workflowArtifactExists,
  type WorkflowArtifactEnvelope,
  type WorkflowArtifactScope,
} from '../lib/workflow-artifacts.js';
import {
  addReviewArtifactFinding,
  createReviewArtifactPayload,
  getReviewArtifactStatus,
  isReviewArtifactPayload,
  updateReviewArtifactFindings,
  type ReviewFindingDisposition,
  type ReviewFinding,
  type ReviewFindingSource,
  type ReviewFindingState,
  type ReviewArtifactPayload,
} from '../lib/review-artifact.js';
import type { RunAgentOptions } from './run-agent.js';
import { renderAgentPermissions, renderAgentValidation } from '../lib/agent-permissions.js';
import { runAgent } from './run-agent.js';
import { TraceCollector } from '../lib/trace-collector.js';
import { renderTraceHtml } from '../lib/trace-html.js';
import type {
  WorkflowRunOptions,
  WorkflowNodeResult,
  WorkflowLoopState,
  WorkflowRunResult,
  WorkflowTemplateContext,
} from '../lib/workflow/types.js';
import type { NodeExecutor } from '../lib/workflow/node-executor.js';

export type {
  WorkflowRunOptions,
  WorkflowNodeResult,
  WorkflowLoopState,
  WorkflowRunResult,
} from '../lib/workflow/types.js';
export type { WorkflowExecutor } from '../lib/workflow/executor.js';
import type { WorkflowExecutor } from '../lib/workflow/executor.js';
export type { NodeExecutor } from '../lib/workflow/node-executor.js';
import {
  buildWorkflowGraph,
  formatWorkflowGraphMermaid,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowGraphNodeKind,
  type WorkflowGraphEdgeKind,
} from '../lib/workflow/graph.js';
import {
  computeActiveWorkflowNodes,
  createSkippedWorkflowNodeResult,
  findWorkflowSegmentIndex,
  getNodeKind,
  getNodeNeeds,
  getWorkflowExecutionOrder,
  getWorkflowExecutionWaves,
  getWorkflowNodeSkipReason,
  getWorkflowNodes,
  hasWorkflowControlNodes,
  isPotentialWorkspaceMutation,
  normalizeWorkflowBooleanLike,
  renderTemplate,
  runControlWorkflowNode,
  splitWorkflowSegments,
  type WorkflowSegment,
} from '../lib/workflow/planning.js';
import type {
  CompiledWorkflowPlan,
  CompiledWorkflowSegment,
} from '../lib/workflow/compiled-plan.js';
import { getWorkflowInputConfigType } from '../lib/workflow/input.js';
export {
  compileWorkflowPlan,
  type CompiledWorkflowPlan,
  type CompiledWorkflowSegment,
  type CompiledWorkflowNode,
  type CompiledWorkflowInput,
  type CompileWorkflowPlanOptions,
} from '../lib/workflow/compiled-plan.js';

interface WorkflowExecutionContext {
  gitClients: Map<string, ReturnType<typeof simpleGit>>;
  platformClients: Partial<Record<WorkflowPlatform, PlatformClient>>;
  traceCollector?: TraceCollector;
  locks: {
    exit: WorkflowLock;
    console: WorkflowLock;
    workspace: WorkflowLock;
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

async function flushWorkflowTrace(
  traceCollector: TraceCollector,
  workflowName: string,
  inputs: Record<string, string>,
  startedAt: string,
  workingDir: string,
  options: WorkflowRunOptions
): Promise<void> {
  const workflowTrace = traceCollector.buildWorkflowTrace(workflowName, inputs, startedAt);
  const scope = {
    platform: 'local' as const,
    projectId: workflowName,
    subject: 'trace',
  };
  const savedJson = await saveWorkflowArtifact(workingDir, {
    kind: 'trace',
    scope,
    payload: workflowTrace,
  });
  const traceHtmlPath = join(dirname(savedJson.path), 'trace.html');
  const html = renderTraceHtml(workflowTrace);
  await writeWorkflowFile(workingDir, traceHtmlPath, html);
  if (!options.jsonOutput) {
    console.log(chalk.green(`\n✓ Trace saved to ${savedJson.latestPath}`));
    console.log(chalk.green(`✓ Trace viewer saved to ${traceHtmlPath}`));
  }
}

async function resolveWorkflowInput(
  key: string,
  input: WorkflowInputConfig,
  workingDir: string
): Promise<string> {
  if (typeof input === 'string') {
    return input;
  }

  const hasValue = input.value !== undefined || input.default !== undefined;
  const hasFile = input.file !== undefined;
  if (hasValue && hasFile) {
    throw new Error(`Workflow input "${key}" cannot define both value/default and file.`);
  }
  if (hasValue) {
    return String(input.value ?? input.default ?? '');
  }
  if (hasFile) {
    const inputPath = resolveWithinWorkingDir(workingDir, input.file ?? '', 'read');
    return readFile(inputPath, 'utf-8');
  }

  if (input.required === true) {
    return '';
  }

  return '';
}

function validateResolvedWorkflowInput(
  key: string,
  input: WorkflowInputConfig,
  value: string
): void {
  if (typeof input === 'string') {
    return;
  }

  if (input.required === true && value.trim() === '') {
    throw new Error(`Workflow input "${key}" is required.`);
  }

  const type = getWorkflowInputConfigType(input);
  if (type === 'boolean') {
    if (normalizeWorkflowBooleanLike(value) === undefined) {
      throw new Error(`Workflow input "${key}" must be a boolean value.`);
    }
    return;
  }
  if (type === 'number') {
    if (value.trim() === '' || !Number.isFinite(Number(value))) {
      throw new Error(`Workflow input "${key}" must be a number.`);
    }
    return;
  }
  if (type === 'enum') {
    const allowedValues = input.values?.map(String) ?? [];
    if (allowedValues.length === 0) {
      throw new Error(`Workflow input "${key}" with type enum must define values.`);
    }
    if (!allowedValues.includes(value)) {
      throw new Error(`Workflow input "${key}" must be one of: ${allowedValues.join(', ')}.`);
    }
    return;
  }
  if (type !== 'string') {
    throw new Error(`Workflow input "${key}" has unsupported type "${type}".`);
  }
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

  for (const [key, input] of Object.entries(workflow.inputs ?? {})) {
    validateResolvedWorkflowInput(key, input, values[key] ?? '');
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

function hasConfiguredAgentPrompt(config: DRSConfig, agentId: string): boolean {
  const runConfig = resolveAgentRunConfig(config, agentId);
  return runConfig.prompt !== undefined || runConfig.promptFile !== undefined;
}

function createAgentOptions(
  prompt: string | undefined,
  options: WorkflowRunOptions,
  workingDir: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
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
    ...(node.permissions
      ? {
          permissions: renderAgentPermissions(node.permissions, (value) =>
            renderTemplate(value, context)
          ),
        }
      : {}),
    ...(node.validation
      ? {
          validation: renderAgentValidation(node.validation, (value) =>
            renderTemplate(value, context)
          ),
        }
      : {}),
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
    try {
      return await readArtifactOutputPointer(workingDir, {
        outputType: 'artifact_output',
        outputPath: writes,
      });
    } catch {
      // If the agent did not write a valid artifact itself, surface the response validation error.
    }

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
  context: WorkflowTemplateContext,
  executionContext?: WorkflowExecutionContext
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

  const agentOptions = createAgentOptions(prompt, options, workingDir, node, context);
  if (executionContext?.traceCollector && prompt) {
    agentOptions.traceCollector = executionContext.traceCollector;
    executionContext.traceCollector.setContext(nodeId, agentId, prompt);
  }

  const result = await runAgent(config, agentId, agentOptions);
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
      runAgent(config, agentId, createAgentOptions(prompt, options, workingDir, node, context))
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
  if (node.action === 'git-branch') {
    return runGitBranchWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'git-commit') {
    return runGitCommitWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'git-push') {
    return runGitPushWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'has-diff') {
    return runHasDiffWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'stack-guard') {
    return runStackGuardWorkflowNode(nodeId, node, context);
  }
  if (node.action === 'review-threshold') {
    return runReviewThresholdWorkflowNode(nodeId, node, context);
  }
  if (node.action === 'save-artifact') {
    return runSaveArtifactWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'load-artifact') {
    return runLoadArtifactWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'artifact-exists') {
    return runArtifactExistsWorkflowNode(nodeId, node, workingDir, context, executionContext);
  }
  if (node.action === 'create-review-artifact') {
    return runCreateReviewArtifactWorkflowNode(nodeId, node, context);
  }
  if (node.action === 'review-artifact-status') {
    return runReviewArtifactStatusWorkflowNode(nodeId, node, context);
  }
  if (node.action === 'review-artifact-add-finding') {
    return runReviewArtifactAddFindingWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'review-artifact-update-findings') {
    return runReviewArtifactUpdateFindingsWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'verify-fix') {
    return runVerifyFixWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'review-artifact-promote-finding') {
    return runReviewArtifactUpdateFindingsWorkflowNode(nodeId, node, workingDir, context, {
      disposition: 'confirmed',
    });
  }
  if (node.action === 'review-artifact-resolve-finding') {
    return runReviewArtifactUpdateFindingsWorkflowNode(nodeId, node, workingDir, context, {
      state: 'resolved',
      disposition: 'resolved',
    });
  }
  if (
    node.action === 'create-change-request' ||
    node.action === 'create-pr' ||
    node.action === 'create-mr'
  ) {
    return runCreateChangeRequestWorkflowNode(nodeId, node, context, executionContext);
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
  if (node.action === 'plan-wiki-update') {
    return runPlanWikiUpdateWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'sync-okf-indexes') {
    return runSyncOkfIndexesWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'validate-okf-wiki') {
    return runValidateOkfWikiWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'record-wiki-state') {
    return runRecordWikiStateWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'check-wiki-state') {
    return runCheckWikiStateWorkflowNode(nodeId, node, workingDir, context);
  }
  if (node.action === 'check-wiki-clean') {
    return runCheckWikiCleanWorkflowNode(nodeId, node, workingDir, context);
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
  if (node.action === 'post-fix-status') {
    return runPostFixStatusWorkflowNode(
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

function getOptionalPathActionOption(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  workingDir: string
): string[] | undefined {
  if (!hasActionOption(node, 'paths') && !hasActionOption(node, 'path')) {
    return undefined;
  }

  return getPathActionOption(nodeId, node, context, workingDir);
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

async function runGitBranchWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const git = await requireWorkflowGitRepo(nodeId, workingDir, executionContext);
  const name = requireStringActionOption(nodeId, node, 'name', context);
  const from = getStringActionOption(node, 'from', context)?.trim();
  const force = getBooleanActionOption(node, 'force', context);
  const args = ['checkout', force ? '-B' : '-b', name];
  if (from) {
    args.push(from);
  }

  await git.raw(args);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `checked out branch ${name}`,
    output: { branch: name, from, force },
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
  const useChangeRequestAuthor = getBooleanActionOption(node, 'useChangeRequestAuthor', context);
  let commitGit = git;

  if (useChangeRequestAuthor) {
    const configuredSource = getStringActionOption(node, 'source', context)?.trim();
    const sourceArtifact = configuredSource ?? 'change';
    const source = context.artifacts[sourceArtifact];
    const platform =
      isReviewSource(source) && typeof source.context.platform === 'string'
        ? source.context.platform
        : undefined;
    const pullRequest =
      isReviewSource(source) && isPullRequest(source.context.pullRequest)
        ? source.context.pullRequest
        : undefined;
    const name = pullRequest?.author.trim();
    const email = pullRequest?.authorEmail?.trim();

    if (
      !isWorkflowPlatform(platform) ||
      !name ||
      name === 'Unknown' ||
      /[\0\r\n]/.test(name) ||
      !email ||
      /[\0\r\n]/.test(email) ||
      !/^[^\s<>@]+@[^\s<>@]+$/.test(email)
    ) {
      throw new Error(
        `Workflow git-commit node "${nodeId}" with.useChangeRequestAuthor requires source artifact "${sourceArtifact}" to contain a GitHub PR or GitLab MR creator identity.`
      );
    }

    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    );
    commitGit = simpleGit({ baseDir: workingDir }).env({
      ...environment,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    });
  }
  const paths =
    hasActionOption(node, 'paths') || hasActionOption(node, 'path')
      ? getPathActionOption(nodeId, node, context, workingDir)
      : undefined;

  if (paths) {
    await git.add(paths);
  }

  const commit = paths ? await commitGit.commit(message, paths) : await commitGit.commit(message);
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

async function runGitPushWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const git = await requireWorkflowGitRepo(nodeId, workingDir, executionContext);
  const configuredRemote = getStringActionOption(node, 'remote', context)?.trim();
  const remote = configuredRemote && configuredRemote.length > 0 ? configuredRemote : 'origin';
  const branch = requireStringActionOption(nodeId, node, 'branch', context);
  const configuredRemoteBranch = getStringActionOption(node, 'remoteBranch', context)?.trim();
  const remoteBranch =
    configuredRemoteBranch && configuredRemoteBranch.length > 0 ? configuredRemoteBranch : branch;
  const setUpstream =
    !hasActionOption(node, 'setUpstream') || getBooleanActionOption(node, 'setUpstream', context);
  const force = getBooleanActionOption(node, 'force', context);
  const args = ['push'];
  if (setUpstream) {
    args.push('-u');
  }
  if (force) {
    args.push('--force-with-lease');
  }
  args.push(remote, `${branch}:${remoteBranch}`);

  await git.raw(args);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `pushed ${branch} to ${remote}/${remoteBranch}`,
    output: { remote, branch, remoteBranch, setUpstream, force },
  };
}

async function runHasDiffWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const git = await requireWorkflowGitRepo(nodeId, workingDir, executionContext);
  const paths = getOptionalPathActionOption(nodeId, node, context, workingDir);
  const diff = paths ? await git.diff(['--', ...paths]) : await git.diff();
  const files = paths ?? [];
  const changed = diff.trim().length > 0;

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: changed ? 'changes found' : 'no changes found',
    output: { changed, files, bytes: Buffer.byteLength(diff, 'utf8') },
  };
}

function runStackGuardWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): WorkflowNodeResult {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = context.artifacts[sourceArtifact];
  if (!isReviewSource(source)) {
    throw new Error(`Workflow stack-guard node "${nodeId}" needs a ReviewSource artifact.`);
  }

  const pullRequest = isPullRequest(source.context.pullRequest)
    ? source.context.pullRequest
    : undefined;
  const sourceBranch = pullRequest?.sourceBranch ?? '';
  const allowStackedSource = getBooleanActionOption(node, 'allowStackedSource', context);
  const rawPrefixes =
    getStringActionOption(node, 'reservedPrefixes', context) ?? 'drs-fix/,drs-guidance/,drs-stack/';
  const reservedPrefixes = rawPrefixes
    .split(/[,\n]/)
    .map((prefix) => prefix.trim())
    .filter(Boolean);
  const matchingPrefix = reservedPrefixes.find((prefix) => sourceBranch.startsWith(prefix));
  const allowed = allowStackedSource || !matchingPrefix;
  const reason = allowed ? 'allowed' : `source branch uses reserved DRS prefix "${matchingPrefix}"`;

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: reason,
    output: { allowed, reason, sourceBranch, reservedPrefixes },
  };
}

function severityRank(severity: string): number {
  const normalized = severity.trim().toUpperCase();
  if (normalized === 'CRITICAL') return 4;
  if (normalized === 'HIGH') return 3;
  if (normalized === 'MEDIUM') return 2;
  if (normalized === 'LOW') return 1;
  return 0;
}

function runReviewThresholdWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): WorkflowNodeResult {
  const reviewArtifact = getStringActionOption(node, 'review', context) ?? 'review';
  const reviewResult = context.artifacts[reviewArtifact];
  if (!isReviewResult(reviewResult)) {
    throw new Error(`Workflow review-threshold node "${nodeId}" needs a ReviewResult artifact.`);
  }

  const severity = (getStringActionOption(node, 'severity', context) ?? 'high').toUpperCase();
  const minIssues = hasActionOption(node, 'minIssues')
    ? requireNumberActionOption(nodeId, node, 'minIssues', context)
    : 1;
  const thresholdRank = severityRank(severity);
  if (thresholdRank === 0) {
    throw new Error(
      `Workflow review-threshold node "${nodeId}" has unsupported severity "${severity}".`
    );
  }
  const matchingIssues = reviewResult.issues.filter(
    (issue) => severityRank(issue.severity) >= thresholdRank
  );
  const matched = matchingIssues.length >= minIssues;

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: matched ? `${matchingIssues.length} matching issue(s)` : 'threshold not met',
    output: { matched, count: matchingIssues.length, severity, minIssues },
  };
}

async function getCurrentBranch(workingDir: string, executionContext: WorkflowExecutionContext) {
  const git = await requireWorkflowGitRepo('artifact-scope', workingDir, executionContext);
  const branch = await git.branch();
  return branch.current ?? 'unknown';
}

async function resolveArtifactScope(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowArtifactScope> {
  const sourceArtifact = getStringActionOption(node, 'source', context);
  const source = sourceArtifact ? context.artifacts[sourceArtifact] : undefined;
  const reviewSource = isReviewSource(source) ? source : undefined;
  const sourceTarget = readSourcePostTarget(reviewSource);
  const explicitPlatform = getStringActionOption(node, 'platform', context);
  const platform = explicitPlatform ?? sourceTarget.platform ?? 'local';
  const projectId =
    getStringActionOption(node, 'project', context) ??
    getStringActionOption(node, 'projectId', context) ??
    (hasActionOption(node, 'owner') || hasActionOption(node, 'repo')
      ? `${requireStringActionOption(nodeId, node, 'owner', context)}/${requireStringActionOption(nodeId, node, 'repo', context)}`
      : undefined) ??
    sourceTarget.projectId ??
    'local';

  const explicitSubject = getStringActionOption(node, 'subject', context)?.trim();
  if (explicitSubject) {
    return { platform, projectId, subject: explicitSubject };
  }

  const explicitChangeKind = getStringActionOption(node, 'changeKind', context)?.trim();
  const explicitChangeNumber =
    getStringActionOption(node, 'changeNumber', context)?.trim() ??
    getStringActionOption(node, 'pr', context)?.trim() ??
    getStringActionOption(node, 'mr', context)?.trim();
  const sourceChangeKind =
    sourceTarget.platform === 'gitlab' ? 'mr' : sourceTarget.platform ? 'pr' : undefined;
  const sourceChangeNumber = sourceTarget.prNumber;
  const changeKind =
    explicitChangeKind && explicitChangeKind.length > 0 ? explicitChangeKind : sourceChangeKind;
  const changeNumber = explicitChangeNumber ?? sourceChangeNumber;
  if (changeKind && changeNumber !== undefined) {
    return { platform, projectId, changeKind, changeNumber };
  }

  const configuredBranch = getStringActionOption(node, 'branch', context)?.trim();
  const branch =
    configuredBranch && configuredBranch.length > 0
      ? configuredBranch
      : await getCurrentBranch(workingDir, executionContext);
  return { platform, projectId, branch };
}

function getArtifactPayloadFromNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): unknown {
  const artifactName = getStringActionOption(node, 'artifact', context);
  if (artifactName) {
    if (!Object.prototype.hasOwnProperty.call(context.artifacts, artifactName)) {
      throw new Error(`Workflow node "${nodeId}" references unknown artifact "${artifactName}".`);
    }
    return context.artifacts[artifactName];
  }

  const payloadName = getStringActionOption(node, 'payload', context);
  if (payloadName && Object.prototype.hasOwnProperty.call(context.artifacts, payloadName)) {
    return context.artifacts[payloadName];
  }
  if (payloadName) {
    try {
      return JSON.parse(payloadName) as unknown;
    } catch {
      return payloadName;
    }
  }

  throw new Error(`Workflow node "${nodeId}" must define with.artifact or with.payload.`);
}

async function runSaveArtifactWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const kind = requireStringActionOption(nodeId, node, 'kind', context);
  const payload = getArtifactPayloadFromNode(nodeId, node, context);
  const scope = await resolveArtifactScope(nodeId, node, workingDir, context, executionContext);
  const saved = await saveWorkflowArtifact(workingDir, { kind, scope, payload });

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `saved ${kind} artifact ${saved.artifact.id}`,
    output: { ...saved.artifact, path: saved.path, latestPath: saved.latestPath },
  };
}

async function runLoadArtifactWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const kind = requireStringActionOption(nodeId, node, 'kind', context);
  const rawId = getStringActionOption(node, 'id', context)?.trim();
  const id = rawId && rawId.length > 0 ? rawId : undefined;
  const scope = await resolveArtifactScope(nodeId, node, workingDir, context, executionContext);
  const loaded = await loadWorkflowArtifact(workingDir, kind, scope, id);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `loaded ${kind} artifact ${loaded.artifact.id}`,
    output: { ...loaded.artifact, path: loaded.path },
  };
}

async function runArtifactExistsWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const kind = requireStringActionOption(nodeId, node, 'kind', context);
  const rawId = getStringActionOption(node, 'id', context)?.trim();
  const id = rawId && rawId.length > 0 ? rawId : undefined;
  const scope = await resolveArtifactScope(nodeId, node, workingDir, context, executionContext);
  const exists = await workflowArtifactExists(workingDir, kind, scope, id);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: exists ? 'artifact exists' : 'artifact missing',
    output: { exists, kind, scope, id },
  };
}

function runCreateReviewArtifactWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): WorkflowNodeResult {
  const reviewArtifact = getStringActionOption(node, 'review', context) ?? 'review';
  const review = context.artifacts[reviewArtifact];
  if (!isReviewResult(review)) {
    throw new Error(
      `Workflow create-review-artifact node "${nodeId}" needs a ReviewResult artifact.`
    );
  }
  const sourceArtifact = getStringActionOption(node, 'source', context);
  const source = sourceArtifact ? context.artifacts[sourceArtifact] : undefined;
  const reviewSource = isReviewSource(source) ? source : undefined;
  const artifact = createReviewArtifactPayload(review, reviewSource);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `created review artifact ${artifact.reviewId}`,
    output: artifact,
  };
}

function getReviewArtifactPayloadFromValue(nodeId: string, value: unknown): ReviewArtifactPayload {
  const envelope = value as Partial<WorkflowArtifactEnvelope>;
  const payload =
    envelope && typeof envelope === 'object' && 'payload' in envelope ? envelope.payload : value;
  if (!isReviewArtifactPayload(payload)) {
    throw new Error(
      `Workflow review-artifact-status node "${nodeId}" needs a review artifact payload.`
    );
  }
  return payload;
}

function getReviewArtifactEnvelopeFromValue(
  value: unknown
): WorkflowArtifactEnvelope<ReviewArtifactPayload> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const envelope = value as Partial<WorkflowArtifactEnvelope>;
  if (
    envelope.schemaVersion === 1 &&
    envelope.kind === 'review' &&
    typeof envelope.id === 'string' &&
    typeof envelope.createdAt === 'string' &&
    typeof envelope.updatedAt === 'string' &&
    envelope.scope &&
    typeof envelope.scope === 'object' &&
    isReviewArtifactPayload(envelope.payload)
  ) {
    return envelope as WorkflowArtifactEnvelope<ReviewArtifactPayload>;
  }
  return undefined;
}

function getReviewArtifactInput(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): {
  artifact: ReviewArtifactPayload;
  envelope?: WorkflowArtifactEnvelope<ReviewArtifactPayload>;
} {
  const artifactName = getStringActionOption(node, 'artifact', context) ?? 'reviewArtifact';
  const artifactValue = context.artifacts[artifactName];
  const artifact = getReviewArtifactPayloadFromValue(nodeId, artifactValue);
  return { artifact, envelope: getReviewArtifactEnvelopeFromValue(artifactValue) };
}

async function persistMutatedReviewArtifact(
  workingDir: string,
  payload: ReviewArtifactPayload,
  envelope?: WorkflowArtifactEnvelope<ReviewArtifactPayload>
): Promise<{ output: unknown; responseSuffix: string }> {
  if (!envelope) {
    return { output: payload, responseSuffix: '' };
  }

  const saved = await updateWorkflowArtifact(workingDir, { artifact: envelope, payload });
  return {
    output: { ...saved.artifact, path: saved.path, latestPath: saved.latestPath },
    responseSuffix: ` and saved ${saved.artifact.id}`,
  };
}

function parseListActionOption(
  node: WorkflowNodeConfig,
  key: string,
  context: WorkflowTemplateContext
): string[] | undefined {
  const value = getStringActionOption(node, key, context)?.trim();
  if (!value) {
    return undefined;
  }
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseReviewFindingState(
  nodeId: string,
  value: string | undefined
): ReviewFindingState | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'open' || value === 'attempted' || value === 'resolved') {
    return value;
  }
  throw new Error(`Workflow node "${nodeId}" has invalid review finding state "${value}".`);
}

function parseReviewFindingDisposition(
  nodeId: string,
  value: string | undefined
): ReviewFindingDisposition | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value === 'confirmed' ||
    value === 'uncertain' ||
    value === 'pre_existing' ||
    value === 'partial' ||
    value === 'still_open' ||
    value === 'regression' ||
    value === 'resolved'
  ) {
    return value;
  }
  throw new Error(`Workflow node "${nodeId}" has invalid review finding disposition "${value}".`);
}

function parseReviewFindingSource(nodeId: string, value: string | undefined): ReviewFindingSource {
  if (!value) {
    return 'manual';
  }
  if (value === 'agent' || value === 'manual' || value === 'external') {
    return value;
  }
  throw new Error(`Workflow node "${nodeId}" has invalid review finding source "${value}".`);
}

function isReviewIssue(value: unknown): value is ReviewIssue {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const issue = value as Partial<ReviewIssue>;
  return (
    typeof issue.severity === 'string' &&
    typeof issue.category === 'string' &&
    typeof issue.title === 'string' &&
    typeof issue.file === 'string' &&
    typeof issue.problem === 'string' &&
    typeof issue.solution === 'string'
  );
}

function getReviewIssueFromNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): ReviewIssue {
  const issueName = requireStringActionOption(nodeId, node, 'issue', context);
  const issue = Object.prototype.hasOwnProperty.call(context.artifacts, issueName)
    ? context.artifacts[issueName]
    : (JSON.parse(issueName) as unknown);
  if (!isReviewIssue(issue)) {
    throw new Error(`Workflow review-artifact-add-finding node "${nodeId}" needs a ReviewIssue.`);
  }
  return issue;
}

function runReviewArtifactStatusWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext
): WorkflowNodeResult {
  const artifactName = getStringActionOption(node, 'artifact', context) ?? 'reviewArtifact';
  const artifactValue = context.artifacts[artifactName];
  const artifact = getReviewArtifactPayloadFromValue(nodeId, artifactValue);
  const status = getReviewArtifactStatus(artifact);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `${status.totalFindings} finding(s), ${status.openFindings} open`,
    output: status,
  };
}

async function runReviewArtifactAddFindingWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const { artifact, envelope } = getReviewArtifactInput(nodeId, node, context);
  const issue = getReviewIssueFromNode(nodeId, node, context);
  const source = parseReviewFindingSource(nodeId, getStringActionOption(node, 'source', context));
  const updated = addReviewArtifactFinding(artifact, issue, source);
  const persisted = await persistMutatedReviewArtifact(workingDir, updated, envelope);
  const addedFinding = updated.findings[updated.findings.length - 1];

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `added review finding ${addedFinding?.id ?? 'unknown'}${persisted.responseSuffix}`,
    output: persisted.output,
  };
}

async function runReviewArtifactUpdateFindingsWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext,
  defaults: { state?: ReviewFindingState; disposition?: ReviewFindingDisposition } = {}
): Promise<WorkflowNodeResult> {
  const { artifact, envelope } = getReviewArtifactInput(nodeId, node, context);
  const state = parseReviewFindingState(
    nodeId,
    getStringActionOption(node, 'state', context) ?? defaults.state
  );
  const disposition = parseReviewFindingDisposition(
    nodeId,
    getStringActionOption(node, 'disposition', context) ?? defaults.disposition
  );
  if (!state && !disposition) {
    throw new Error(`Workflow node "${nodeId}" must define with.state or with.disposition.`);
  }

  const { artifact: updated, updatedIds } = updateReviewArtifactFindings(artifact, {
    ids: parseListActionOption(node, 'ids', context),
    fingerprints: parseListActionOption(node, 'fingerprints', context),
    severity: getStringActionOption(node, 'severity', context)?.trim().toUpperCase(),
    state,
    disposition,
  });
  const persisted = await persistMutatedReviewArtifact(workingDir, updated, envelope);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `updated ${updatedIds.length} review finding(s)${persisted.responseSuffix}`,
    output: {
      ...(typeof persisted.output === 'object' && persisted.output !== null
        ? persisted.output
        : {}),
      updatedIds,
    },
  };
}

async function runVerifyFixWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const { artifact, envelope } = getReviewArtifactInput(nodeId, node, context);
  const reviewArtifact = getStringActionOption(node, 'review', context) ?? 'reReview';
  const review = context.artifacts[reviewArtifact];
  if (!isReviewResult(review)) {
    throw new Error(`Workflow verify-fix node "${nodeId}" needs a ReviewResult.`);
  }

  const severity = (getStringActionOption(node, 'severity', context) ?? 'high').toUpperCase();
  if (severityRank(severity) === 0) {
    throw new Error(`Workflow verify-fix node "${nodeId}" has unsupported severity "${severity}".`);
  }
  const minIssues = hasActionOption(node, 'minIssues')
    ? requireNumberActionOption(nodeId, node, 'minIssues', context)
    : 1;
  const fixChangeName = getStringActionOption(node, 'fixChange', context);
  const fixChange = fixChangeName ? context.artifacts[fixChangeName] : undefined;
  const fixSource = isReviewSource(fixChange) ? fixChange : undefined;

  const reconciliation = reconcileReviewArtifactFindings(artifact, review, {
    severity,
    minIssues,
    fixSource,
  });
  const persisted = await persistMutatedReviewArtifact(
    workingDir,
    reconciliation.artifact,
    envelope
  );
  const status = getReviewArtifactStatus(reconciliation.artifact);
  const output = {
    ...(typeof persisted.output === 'object' && persisted.output !== null ? persisted.output : {}),
    payload: reconciliation.artifact,
    verification: {
      severity,
      minIssues,
      shouldContinue: reconciliation.shouldContinue,
      actionableOpen: reconciliation.actionableOpen,
      fixFiles: fixSource?.files.length ?? 0,
      resolved: reconciliation.resolved,
      partial: reconciliation.partial,
      stillOpen: reconciliation.stillOpen,
      regression: reconciliation.regression,
      statuses: reconciliation.statuses.map((statusItem) => ({
        id: statusItem.finding.id,
        fingerprint: statusItem.finding.fingerprint,
        disposition: statusItem.disposition,
        severity: statusItem.finding.issue.severity,
        file: statusItem.finding.issue.file,
        line: statusItem.finding.issue.line,
        title: statusItem.finding.issue.title,
        verificationMissing: statusItem.verificationMissing === true,
        verificationRationale: statusItem.finding.verification?.rationale,
      })),
    },
    shouldContinue: reconciliation.shouldContinue,
    actionableOpen: reconciliation.actionableOpen,
    fixFiles: fixSource?.files.length ?? 0,
    updatedIds: reconciliation.statuses.map((statusItem) => statusItem.finding.id),
    status,
  };

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: reconciliation.shouldContinue
      ? `${reconciliation.actionableOpen} actionable finding(s) remain${persisted.responseSuffix}`
      : `fix verification converged${persisted.responseSuffix}`,
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

function combineVerificationPatch(originalPatch?: string, fixPatch?: string): string {
  const sections: string[] = [];
  if (originalPatch) {
    sections.push(`# Original PR/MR diff\n${originalPatch}`);
  }
  if (fixPatch) {
    sections.push(`# Local fix diff\n${fixPatch}`);
  }
  return sections.join('\n\n');
}

async function loadFixVerificationChangeSource(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<ReviewSource> {
  const sourceName = getStringActionOption(node, 'source', context) ?? 'change';
  const source = context.artifacts[sourceName];
  if (!isReviewSource(source)) {
    throw new Error(
      `Workflow fix-verification change-source node "${nodeId}" needs a source ReviewSource artifact.`
    );
  }

  const fixChangeName = getStringActionOption(node, 'fixChange', context) ?? 'fixChange';
  const fixChange = context.artifacts[fixChangeName];
  if (!isReviewSource(fixChange)) {
    throw new Error(
      `Workflow fix-verification change-source node "${nodeId}" needs a fixChange ReviewSource artifact.`
    );
  }

  const files = [...new Set([...source.files, ...fixChange.files])];

  const pullRequest = isPullRequest(source.context.pullRequest) ? source.context.pullRequest : null;
  const baseRef =
    pullRequest?.targetBranch ?? (source.context.baseBranch as string | undefined) ?? 'HEAD~1';

  const realDiffs = await tryGetRealPostFixDiff(workingDir, files, baseRef);

  return {
    ...source,
    name: `${source.name} with local fixes`,
    files,
    filesWithDiffs:
      realDiffs ??
      files.map((filename) => ({
        filename,
        patch: combineVerificationPatch(
          (source.filesWithDiffs ?? []).find((f) => f.filename === filename)?.patch,
          (fixChange.filesWithDiffs ?? []).find((f) => f.filename === filename)?.patch
        ),
      })),
    context: {
      ...source.context,
      sourceType: 'fix-verification',
      fixFiles: fixChange.files,
    },
    staged: fixChange.staged,
  };
}

async function tryGetRealPostFixDiff(
  workingDir: string,
  files: string[],
  baseRef: string
): Promise<Array<{ filename: string; patch: string }> | undefined> {
  try {
    const git = simpleGit({ baseDir: workingDir });
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return undefined;

    const diffText = await git.diff(['--no-ext-diff', '-M', baseRef, '--', ...files]);
    if (!diffText.trim()) return undefined;

    return getFilesWithDiffs(parseDiff(diffText));
  } catch {
    return undefined;
  }
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
  } else if (type === 'fix-verification') {
    source = await loadFixVerificationChangeSource(nodeId, node, workingDir, context);
  } else {
    throw new Error(
      `Unsupported workflow change-source type "${type}" in node "${nodeId}". ` +
        'Currently supported: local, git-range, github-pr, gitlab-mr, fix-verification.'
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

async function runCreateChangeRequestWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  context: WorkflowTemplateContext,
  executionContext: WorkflowExecutionContext
): Promise<WorkflowNodeResult> {
  const sourceArtifact = getStringActionOption(node, 'source', context) ?? 'change';
  const source = isReviewSource(context.artifacts[sourceArtifact])
    ? context.artifacts[sourceArtifact]
    : undefined;
  const sourceTarget = readSourcePostTarget(source);
  const aliasPlatform =
    node.action === 'create-pr' ? 'github' : node.action === 'create-mr' ? 'gitlab' : undefined;
  const explicitPlatform = getStringActionOption(node, 'platform', context);
  const platform = aliasPlatform ?? explicitPlatform ?? sourceTarget.platform;
  if (!isWorkflowPlatform(platform)) {
    throw new Error(
      `Workflow change-request node "${nodeId}" must resolve with.platform to github or gitlab.`
    );
  }

  const projectId = resolvePostProjectId(nodeId, node, context, sourceTarget);
  const configuredSourceBranch = getStringActionOption(node, 'sourceBranch', context)?.trim();
  const configuredHead = getStringActionOption(node, 'head', context)?.trim();
  const sourceBranch =
    configuredSourceBranch && configuredSourceBranch.length > 0
      ? configuredSourceBranch
      : configuredHead;
  const configuredTargetBranch = getStringActionOption(node, 'targetBranch', context)?.trim();
  const configuredBase = getStringActionOption(node, 'base', context)?.trim();
  const targetBranch =
    configuredTargetBranch && configuredTargetBranch.length > 0
      ? configuredTargetBranch
      : configuredBase;
  if (!sourceBranch) {
    throw new Error(`Workflow change-request node "${nodeId}" must define with.sourceBranch.`);
  }
  if (!targetBranch) {
    throw new Error(`Workflow change-request node "${nodeId}" must define with.targetBranch.`);
  }

  const title = requireStringActionOption(nodeId, node, 'title', context);
  const body = getStringActionOption(node, 'body', context);
  const draft = getBooleanActionOption(node, 'draft', context);
  const reuseExisting =
    !hasActionOption(node, 'reuseExisting') ||
    getBooleanActionOption(node, 'reuseExisting', context);
  const platformClient = getWorkflowPlatformClient(executionContext, platform);
  const input = {
    sourceBranch,
    targetBranch,
    title,
    body,
    draft,
  };
  const existing = reuseExisting
    ? await platformClient.findChangeRequest?.(projectId, sourceBranch, targetBranch)
    : undefined;
  let operation: 'created' | 'reused' = existing ? 'reused' : 'created';
  const changeRequest =
    existing ??
    (await platformClient.createChangeRequest(projectId, input).catch(async (error: unknown) => {
      if (reuseExisting) {
        try {
          const retryExisting = await platformClient.findChangeRequest?.(
            projectId,
            sourceBranch,
            targetBranch
          );
          if (retryExisting) {
            operation = 'reused';
            return retryExisting;
          }
        } catch {
          // ignore retry failure; fall through to throw original error
        }
      }
      throw error;
    }));

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `${operation} ${platform} change request #${changeRequest.number}`,
    output: {
      platform,
      projectId,
      operation,
      ...changeRequest,
    },
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

async function runSyncOkfIndexesWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const root = getStringActionOption(node, 'root', context)?.trim() ?? 'wiki';
  const version = getStringActionOption(node, 'version', context)?.trim() ?? '0.1';
  const result = await synchronizeOkfIndexes(workingDir, root, version);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `synchronized ${result.indexes} OKF indexes under ${result.root} (${result.updated} updated)`,
    output: result,
  };
}

async function runPlanWikiUpdateWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const root = getStringActionOption(node, 'root', context)?.trim() ?? 'wiki';
  const statePath =
    getStringActionOption(node, 'statePath', context)?.trim() ?? '.drs/wiki-state.json';
  const result = await planWikiUpdate(workingDir, root, statePath);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `${result.mode}: ${result.reason}`,
    output: result,
  };
}

async function runValidateOkfWikiWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const root = getStringActionOption(node, 'root', context)?.trim() ?? 'wiki';
  const version = getStringActionOption(node, 'version', context)?.trim() ?? '0.1';
  const result = await validateOkfBundle(workingDir, root, version);
  if (!result.valid) {
    throw new Error(
      `Workflow validate-okf-wiki node "${nodeId}" found ${result.errors.length} error(s):\n${formatOkfValidationErrors(result)}`
    );
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response:
      `validated ${result.concepts} OKF concepts under ${result.root} with ` +
      `${result.warnings.length} warning(s); graph: ${result.graph.nodeCount} nodes, ` +
      `${result.graph.directedEdgeCount} directed edges, ` +
      `${result.graph.orphanConceptCount} orphans, ` +
      `${result.graph.weaklyConnectedConceptCount} weakly connected`,
    output: result,
  };
}

async function runRecordWikiStateWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const root = getStringActionOption(node, 'root', context)?.trim() ?? 'wiki';
  const statePath =
    getStringActionOption(node, 'statePath', context)?.trim() ?? '.drs/wiki-state.json';
  const result = await recordWikiState(workingDir, root, statePath);

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `recorded wiki state for ${result.root} at ${result.gitHead}`,
    output: result,
    writes: statePath,
  };
}

async function runCheckWikiCleanWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const root = getStringActionOption(node, 'root', context)?.trim() ?? 'wiki';
  const statePath =
    getStringActionOption(node, 'statePath', context)?.trim() ?? '.drs/wiki-state.json';
  const result = await checkWikiClean(workingDir, root, statePath);
  if (!result.clean) {
    throw new Error(
      `Workflow check-wiki-clean node "${nodeId}" found stale wiki output:\n${result.changedPaths.map((filePath) => `- ${filePath}`).join('\n')}`
    );
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `wiki bundle ${result.root} and state ${result.statePath} are current`,
    output: result,
  };
}

async function runCheckWikiStateWorkflowNode(
  nodeId: string,
  node: WorkflowNodeConfig,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const root = getStringActionOption(node, 'root', context)?.trim() ?? 'wiki';
  const statePath =
    getStringActionOption(node, 'statePath', context)?.trim() ?? '.drs/wiki-state.json';
  const result = await planWikiUpdate(workingDir, root, statePath);
  if (result.shouldRun) {
    const paths = result.changedPaths.map((filePath) => `- ${filePath}`).join('\n');
    throw new Error(
      `Workflow check-wiki-state node "${nodeId}" found a stale wiki (${result.mode}): ${result.reason}${paths ? `\n${paths}` : ''}`
    );
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: result.reason,
    output: result,
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
  const configuredMarker = getStringActionOption(node, 'marker', context)?.trim();
  const marker =
    configuredMarker && configuredMarker.length > 0
      ? configuredMarker
      : options.idempotencyContext?.idempotencyKey;
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

interface FixFindingStatus {
  finding: ReviewFinding;
  disposition: 'resolved' | 'partial' | 'still-open' | 'regression' | 'attempted';
  diffSnippet?: string;
  verificationMissing?: boolean;
}

function getFixStatusDisposition(finding: ReviewFinding): FixFindingStatus['disposition'] {
  const disposition = finding.disposition;
  if (disposition === 'resolved') return 'resolved';
  if (disposition === 'partial') return 'partial';
  if (disposition === 'regression') return 'regression';
  return 'still-open';
}

function getVerificationDisposition(
  finding: ReviewFinding,
  verdict: ReviewVerificationFinding | undefined,
  thresholdRank: number
): ReviewFindingDisposition {
  if (severityRank(finding.issue.severity) < thresholdRank) {
    return finding.disposition;
  }
  if (!verdict) {
    if (finding.disposition === 'regression') {
      return 'regression';
    }
    return 'still_open';
  }
  return verdict.disposition === 'still_open' ? 'still_open' : verdict.disposition;
}

function reconcileReviewArtifactFindings(
  artifact: ReviewArtifactPayload,
  reReview: ReviewResult,
  options: { severity: string; minIssues: number; fixSource?: ReviewSource }
): {
  artifact: ReviewArtifactPayload;
  statuses: FixFindingStatus[];
  shouldContinue: boolean;
  actionableOpen: number;
  resolved: number;
  partial: number;
  stillOpen: number;
  regression: number;
} {
  const now = new Date().toISOString();
  const thresholdRank = severityRank(options.severity);
  const verdicts = new Map(
    (reReview.verification?.findings ?? []).map((finding) => [finding.id, finding])
  );
  const existingFingerprints = new Set(artifact.findings.map((finding) => finding.fingerprint));

  const reconciledFindings = artifact.findings.map((finding) => {
    const verdict = verdicts.get(finding.id);
    const disposition = getVerificationDisposition(finding, verdict, thresholdRank);
    const issue = isReviewIssue(verdict?.issue) ? verdict.issue : finding.issue;
    const fingerprint =
      issue === finding.issue ? finding.fingerprint : createIssueFingerprint(issue);
    const shouldVerify = severityRank(finding.issue.severity) >= thresholdRank;
    const verification = shouldVerify
      ? {
          disposition: verdict?.disposition ?? ('missing' as const),
          rationale: verdict?.rationale,
          verifiedAt: now,
        }
      : finding.verification;
    return {
      ...finding,
      issue,
      fingerprint,
      state: disposition === 'resolved' ? ('resolved' as const) : ('open' as const),
      disposition,
      verification,
      updatedAt: now,
    };
  });

  for (const issue of reReview.issues) {
    const fingerprint = createIssueFingerprint(issue);
    if (existingFingerprints.has(fingerprint)) {
      continue;
    }
    existingFingerprints.add(fingerprint);
    reconciledFindings.push({
      id: `R${reconciledFindings.length + 1}`,
      fingerprint,
      issue,
      state: 'open',
      disposition: 'regression',
      verification: undefined,
      source: 'agent',
      createdAt: now,
      updatedAt: now,
    });
  }

  const updatedArtifact = { ...artifact, findings: reconciledFindings };
  const statuses = updatedArtifact.findings.map((finding) => {
    const disposition = getFixStatusDisposition(finding);
    const verificationMissing =
      severityRank(finding.issue.severity) >= thresholdRank && !verdicts.has(finding.id);
    const diffSnippet =
      disposition === 'resolved' || disposition === 'regression'
        ? extractDiffSnippet(options.fixSource, finding.issue.file, finding.issue.line)
        : undefined;
    return { finding, disposition, diffSnippet, verificationMissing };
  });

  const actionableOpen = updatedArtifact.findings.filter(
    (finding) =>
      finding.state === 'open' &&
      severityRank(finding.issue.severity) >= thresholdRank &&
      (finding.disposition === 'still_open' ||
        finding.disposition === 'partial' ||
        finding.disposition === 'regression')
  ).length;

  return {
    artifact: updatedArtifact,
    statuses,
    shouldContinue: actionableOpen >= options.minIssues,
    actionableOpen,
    resolved: updatedArtifact.findings.filter((finding) => finding.state === 'resolved').length,
    partial: updatedArtifact.findings.filter((finding) => finding.disposition === 'partial').length,
    stillOpen: updatedArtifact.findings.filter((finding) => finding.disposition === 'still_open')
      .length,
    regression: updatedArtifact.findings.filter((finding) => finding.disposition === 'regression')
      .length,
  };
}

function extractDiffSnippet(
  fixChange: ReviewSource | undefined,
  filePath: string,
  line?: number
): string | undefined {
  if (!fixChange?.filesWithDiffs) {
    return undefined;
  }
  const fileWithDiff = fixChange.filesWithDiffs.find((f) => f.filename === filePath);
  if (!fileWithDiff?.patch) {
    return undefined;
  }
  const lines = fileWithDiff.patch.split('\n');
  if (!line) {
    return lines.slice(0, 15).join('\n');
  }
  for (let i = 0; i < lines.length; i++) {
    const hunkMatch = lines[i]?.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) {
      continue;
    }
    const newStart = Number.parseInt(hunkMatch[1], 10);
    const newLineCount = hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1;
    if (line < newStart || line >= newStart + newLineCount) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end]?.startsWith('@@')) {
      end++;
    }
    return lines.slice(i, end).join('\n');
  }
  return lines.slice(0, 15).join('\n');
}

function formatFixStatusComment(statuses: FixFindingStatus[], stackedPrUrl?: string): string {
  const lines: string[] = ['## Fix Status', ''];

  if (statuses.length === 0) {
    lines.push('No findings to report.');
    return lines.join('\n');
  }

  lines.push('| # | Severity | File | Issue | Status |');
  lines.push('|---|----------|------|-------|--------|');
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    const statusIcon =
      s.disposition === 'resolved'
        ? '✅ Resolved'
        : s.disposition === 'partial'
          ? '🟡 Partial'
          : s.disposition === 'regression'
            ? '🔴 Regression'
            : s.disposition === 'attempted'
              ? '🔧 Attempted'
              : s.verificationMissing
                ? '⚠️ Verification Missing'
                : '⚪ Still Open';
    const file = `${s.finding.issue.file}${s.finding.issue.line ? `:${s.finding.issue.line}` : ''}`;
    lines.push(
      `| ${i + 1} | ${s.finding.issue.severity} | ${file} | ${s.finding.issue.title} | ${statusIcon} |`
    );
  }

  const resolved = statuses.filter((s) => s.disposition === 'resolved' && s.diffSnippet);
  if (resolved.length > 0) {
    lines.push('');
    lines.push('### Fix Details');
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      if (s.disposition === 'resolved' && s.diffSnippet) {
        lines.push('');
        lines.push(`**#${i + 1} — ${s.finding.issue.title} (${s.disposition})**`);
        lines.push('```diff');
        lines.push(s.diffSnippet);
        lines.push('```');
      }
    }
  }

  if (stackedPrUrl) {
    lines.push('');
    lines.push(`Stacked fix PR: ${stackedPrUrl}`);
  }

  return lines.join('\n');
}

async function runPostFixStatusWorkflowNode(
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

  const reviewArtifactName =
    getStringActionOption(node, 'reviewArtifact', context) ?? 'reviewArtifact';
  const reviewArtifactValue = context.artifacts[reviewArtifactName];
  let artifactPayload: ReviewArtifactPayload | undefined;
  if (isReviewArtifactPayload(reviewArtifactValue)) {
    artifactPayload = reviewArtifactValue;
  } else if (
    reviewArtifactValue &&
    typeof reviewArtifactValue === 'object' &&
    'payload' in reviewArtifactValue
  ) {
    const payload = reviewArtifactValue.payload;
    if (isReviewArtifactPayload(payload)) {
      artifactPayload = payload;
    }
  }
  if (!artifactPayload) {
    throw new Error(
      `Workflow post-fix-status node "${nodeId}" needs a review artifact (with.reviewArtifact).`
    );
  }

  const fixReviewName = getStringActionOption(node, 'fixReview', context);
  const fixReviewResult = fixReviewName ? context.artifacts[fixReviewName] : undefined;
  const hasReReview = isReviewResult(fixReviewResult);

  const fixChangeName = getStringActionOption(node, 'fixChange', context);
  const fixChange = fixChangeName ? context.artifacts[fixChangeName] : undefined;
  const fixSource = isReviewSource(fixChange) ? fixChange : undefined;

  const stackedPrUrl = getStringActionOption(node, 'stackedPrUrl', context);
  const marker = getStringActionOption(node, 'marker', context)?.trim() ?? 'drs-fix-status';
  const severity = (getStringActionOption(node, 'severity', context) ?? 'high').toUpperCase();
  const thresholdRank = severityRank(severity);

  const originalFindings = artifactPayload.findings.filter(
    (finding) => severityRank(finding.issue.severity) >= thresholdRank
  );

  const statuses: FixFindingStatus[] = originalFindings.map((finding) => {
    if (hasReReview) {
      const disposition = getFixStatusDisposition(finding);
      const diffSnippet =
        disposition === 'resolved' || disposition === 'regression'
          ? extractDiffSnippet(fixSource, finding.issue.file, finding.issue.line)
          : undefined;
      return { finding, disposition, diffSnippet };
    }
    const diffSnippet = extractDiffSnippet(fixSource, finding.issue.file, finding.issue.line);
    return { finding, disposition: 'attempted', diffSnippet };
  });

  const body = formatFixStatusComment(statuses, stackedPrUrl);
  const markedBody = formatMarkedComment(body, marker);
  let operation = 'created';

  try {
    const comments = await target.platformClient.getComments(target.projectId, target.prNumber);
    const existingComment = findExistingCommentById(comments, marker);
    if (existingComment) {
      await withWorkflowConsoleSuppressed(executionContext, options.jsonOutput === true, () =>
        target.platformClient.updateComment(
          target.projectId,
          target.prNumber,
          existingComment.id,
          markedBody
        )
      );
      operation = 'updated';
    } else {
      await withWorkflowConsoleSuppressed(executionContext, options.jsonOutput === true, () =>
        target.platformClient.createComment(target.projectId, target.prNumber, markedBody)
      );
    }
  } catch (error) {
    throw new Error(
      `Workflow post-fix-status node "${nodeId}" failed to post comment: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `${operation} fix-status comment on ${target.platform} ${target.projectId}#${target.prNumber}`,
    output: {
      platform: target.platform,
      projectId: target.projectId,
      prNumber: target.prNumber,
      operation,
      resolved: statuses.filter((s) => s.disposition === 'resolved').length,
      partial: statuses.filter((s) => s.disposition === 'partial').length,
      stillOpen: statuses.filter((s) => s.disposition === 'still-open').length,
      regression: statuses.filter((s) => s.disposition === 'regression').length,
      attempted: statuses.filter((s) => s.disposition === 'attempted').length,
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

  const reviewArtifactName = getStringActionOption(node, 'reviewArtifact', context);
  const reviewArtifactEnvelope = reviewArtifactName
    ? context.artifacts[reviewArtifactName]
    : undefined;
  const reviewArtifact = reviewArtifactName
    ? getReviewArtifactPayloadFromValue(nodeId, reviewArtifactEnvelope)
    : undefined;
  const reviewArtifactPath =
    reviewArtifactEnvelope && typeof reviewArtifactEnvelope === 'object'
      ? (reviewArtifactEnvelope as { path?: string }).path
      : undefined;
  const severity = getStringActionOption(node, 'severity', context)?.toUpperCase();
  const traceCollector = executionContext.traceCollector;
  const sourceForReview: ReviewSource = reviewArtifact
    ? {
        ...source,
        context: {
          ...source.context,
          verification: {
            artifact: {
              reviewId: reviewArtifact.reviewId,
              findings: reviewArtifact.findings,
            },
            artifactPath: reviewArtifactPath,
            severity,
          },
          traceCollector,
        },
      }
    : {
        ...source,
        context: {
          ...source.context,
          traceCollector,
        },
      };

  if (traceCollector) {
    const agentIds = getReviewAgentIds(config);
    traceCollector.setContext(nodeId, agentIds[0] ?? 'review/unified-reviewer', '');
  }

  const reviewResult = await withWorkflowLock(executionContext.locks.exit, async () => {
    const originalLog = console.log;
    const originalWarn = console.warn;

    if (options.jsonOutput) {
      console.log = () => undefined;
      console.warn = () => undefined;
    }

    try {
      return await executeReview(config, {
        ...sourceForReview,
        workingDir: sourceForReview.workingDir ?? workingDir,
        debug: options.debug,
        thinkingLevel: options.thinkingLevel,
      });
    } finally {
      if (options.jsonOutput) {
        console.log = originalLog;
        console.warn = originalWarn;
      }
    }
  });

  const writes = renderNodeWritesPath(nodeId, node, context);
  if (writes) {
    await writeWorkflowFile(workingDir, writes, JSON.stringify(reviewResult, null, 2));
  }

  const explicitArtifactOutput = getStringActionOption(node, 'artifact', context)?.trim();
  let artifactOutput: string | undefined;
  if (explicitArtifactOutput) {
    artifactOutput = explicitArtifactOutput;
  } else if (!reviewArtifactName) {
    artifactOutput = `${nodeId}Artifact`;
  }
  const outputs: Record<string, unknown> = {};
  const reviewArtifactPayload = createReviewArtifactPayload(reviewResult, source);
  const scope = await resolveArtifactScope(nodeId, node, workingDir, context, executionContext);
  const saved = await saveWorkflowArtifact(workingDir, {
    kind: 'review',
    scope,
    payload: reviewArtifactPayload,
  });
  const artifactResponse = `\nSaved review artifact ${saved.artifact.id}.`;
  if (artifactOutput) {
    outputs[artifactOutput] = { ...saved.artifact, path: saved.path, latestPath: saved.latestPath };
  }

  return {
    id: nodeId,
    type: 'action',
    action: node.action,
    response: `${JSON.stringify(reviewResult.summary, null, 2)}${artifactResponse}`,
    output: reviewResult,
    outputs,
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
  if (result.outputs) {
    for (const [name, value] of Object.entries(result.outputs)) {
      artifacts[name] = value;
    }
  }
}

function logWorkflowNodeRunning(nodeId: string, options: WorkflowRunOptions): void {
  if (!options.jsonOutput) {
    console.log(chalk.gray(`Running node ${nodeId}...`));
  }
}

function logWorkflowNodeSkipped(nodeId: string, reason: string, options: WorkflowRunOptions): void {
  if (!options.jsonOutput) {
    console.log(chalk.gray(`Skipping node ${nodeId} (${reason})`));
  }
}

function recordWorkflowNodeResult(
  nodeId: string,
  node: WorkflowNodeConfig,
  result: WorkflowNodeResult,
  nodes: Record<string, WorkflowNodeResult>,
  artifacts: Record<string, unknown>
): void {
  result.status ??= 'success';
  nodes[nodeId] = result;
  if (result.status !== 'skipped') {
    recordNodeArtifact(nodeId, node, result, artifacts);
  }
}

function completeWorkflowNodeResult<T extends WorkflowNodeResult>(result: T, startedAt: string): T {
  const completedAt = new Date().toISOString();
  result.startedAt ??= startedAt;
  result.completedAt ??= completedAt;
  result.durationMs ??= Math.max(
    0,
    new Date(completedAt).getTime() - new Date(startedAt).getTime()
  );
  return result;
}

async function runWorkflowDagSegment(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  nodeIds: string[],
  activeNodeIds: Set<string> | undefined,
  options: WorkflowRunOptions,
  context: WorkflowTemplateContext,
  nodeExecutor: NodeExecutor
): Promise<void> {
  const completed = new Set<string>();
  const segmentNodeIds = new Set(nodeIds);

  if (activeNodeIds) {
    for (const nodeId of nodeIds) {
      if (!activeNodeIds.has(nodeId)) {
        completed.add(nodeId);
        if (context.nodes[nodeId] === undefined) {
          logWorkflowNodeSkipped(nodeId, 'inactive branch', options);
          context.nodes[nodeId] = createSkippedWorkflowNodeResult(nodeId);
        }
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

        const startedAt = new Date().toISOString();
        const skipReason = getWorkflowNodeSkipReason(node, context);
        if (skipReason) {
          logWorkflowNodeSkipped(nodeId, skipReason, options);
          return {
            nodeId,
            node,
            result: completeWorkflowNodeResult(createSkippedWorkflowNodeResult(nodeId), startedAt),
          };
        }

        logWorkflowNodeRunning(nodeId, options);
        const result = await nodeExecutor.runNode(nodeId, node, context);
        return { nodeId, node, result: completeWorkflowNodeResult(result, startedAt) };
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

async function runControlWorkflow(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[],
  options: WorkflowRunOptions,
  context: WorkflowTemplateContext,
  nodeExecutor: NodeExecutor
): Promise<void> {
  await runControlWorkflowFromSegments(
    workflowNodes,
    splitWorkflowSegments(workflowNodes, executionOrder),
    options,
    context,
    nodeExecutor
  );
}

async function runControlWorkflowFromSegments(
  workflowNodes: Record<string, WorkflowNodeConfig>,
  compiledSegments: WorkflowSegment[],
  options: WorkflowRunOptions,
  context: WorkflowTemplateContext,
  nodeExecutor: NodeExecutor
): Promise<void> {
  const segments: WorkflowSegment[] = compiledSegments.map((segment) =>
    segment.type === 'control'
      ? { type: 'control', nodeId: segment.nodeId }
      : {
          type: 'dag',
          nodeIds: [...segment.nodeIds],
          ...(segment.activeNodeIds ? { activeNodeIds: new Set(segment.activeNodeIds) } : {}),
        }
  );
  let segmentIndex = 0;

  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex];
    if (segment.type === 'dag') {
      await runWorkflowDagSegment(
        workflowNodes,
        segment.nodeIds,
        segment.activeNodeIds,
        options,
        context,
        nodeExecutor
      );
      segmentIndex += 1;
      continue;
    }

    const node = workflowNodes[segment.nodeId];
    if (!node) {
      throw new Error(`Workflow references unknown node "${segment.nodeId}".`);
    }
    const skipReason = getWorkflowNodeSkipReason(node, context);
    if (skipReason) {
      logWorkflowNodeSkipped(segment.nodeId, skipReason, options);
    } else {
      logWorkflowNodeRunning(segment.nodeId, options);
    }
    const startedAt = new Date().toISOString();
    const controlResult = skipReason
      ? { result: createSkippedWorkflowNodeResult(segment.nodeId) }
      : runControlWorkflowNode(segment.nodeId, node, context);
    const { result, nextNodeId, ended } = {
      ...controlResult,
      result: completeWorkflowNodeResult(controlResult.result, startedAt),
    };
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
    if (node.control !== 'loop' && targetIndex <= segmentIndex) {
      throw new Error(
        `Workflow control node "${segment.nodeId}" cannot jump backward to "${nextNodeId}". Use control: loop with maxIterations for repeated execution.`
      );
    }
    const targetSegment = segments[targetIndex];
    if (targetSegment.type === 'dag') {
      targetSegment.activeNodeIds = computeActiveWorkflowNodes(
        workflowNodes,
        targetSegment.nodeIds,
        nextNodeId,
        !(node.control === 'loop' && nextNodeId === node.target)
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

  if (getWorkflowNodeSkipReason(node, context)) {
    return createSkippedWorkflowNodeResult(nodeId);
  }

  const run = async (): Promise<WorkflowNodeResult> => {
    if (kind === 'agent') {
      return runAgentWorkflowNode(
        config,
        nodeId,
        node,
        options,
        workingDir,
        context,
        executionContext
      );
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
  };

  return isPotentialWorkspaceMutation(node)
    ? withWorkflowLock(executionContext.locks.workspace, run)
    : run();
}

/**
 * In-process {@link NodeExecutor} that dispatches a single non-control node
 * to the existing side-effecting runner functions. Constructed once per
 * workflow run so git/platform clients and locks are shared across nodes.
 *
 * The Temporal executor will provide its own NodeExecutor whose `runNode`
 * schedules a Temporal activity instead of executing in-process.
 */
class LocalNodeExecutor implements NodeExecutor {
  constructor(
    private readonly config: DRSConfig,
    private readonly options: WorkflowRunOptions,
    private readonly workingDir: string,
    private readonly executionContext: WorkflowExecutionContext
  ) {}

  async runNode(
    nodeId: string,
    node: WorkflowNodeConfig,
    context: WorkflowTemplateContext
  ): Promise<WorkflowNodeResult> {
    return runSingleWorkflowNode(
      this.config,
      nodeId,
      node,
      this.options,
      this.workingDir,
      context,
      this.executionContext
    );
  }
}

export async function runWorkflowNodeLocally(
  config: DRSConfig,
  nodeId: string,
  node: WorkflowNodeConfig,
  options: WorkflowRunOptions,
  workingDir: string,
  context: WorkflowTemplateContext
): Promise<WorkflowNodeResult> {
  const executionContext: WorkflowExecutionContext = {
    gitClients: new Map(),
    platformClients: {},
    traceCollector: options.trace ? new TraceCollector() : undefined,
    locks: {
      exit: createWorkflowLock(),
      console: createWorkflowLock(),
      workspace: createWorkflowLock(),
    },
  };
  return runSingleWorkflowNode(
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
  const executionOrder = getWorkflowExecutionOrder(workflowNodes);
  const executionWaves = getWorkflowExecutionWaves(workflowNodes, executionOrder);

  return executeWorkflowRun(
    config,
    workflowName,
    workflowNodes,
    executionOrder,
    executionWaves,
    workflow.output,
    hasWorkflowControlNodes(workflowNodes),
    options
  );
}

/**
 * Run a workflow from a previously compiled {@link CompiledWorkflowPlan}.
 *
 * The plan supplies the scheduling data (nodes, execution order, waves,
 * segments, output key) so the caller does not need to reload repo config to
 * drive execution. `config` is still required because agent/action node
 * execution needs agent and review configuration that lives outside the
 * compiled plan.
 */
export async function runWorkflowFromCompiledPlan(
  config: DRSConfig,
  plan: CompiledWorkflowPlan,
  options: WorkflowRunOptions = {}
): Promise<WorkflowRunResult> {
  const executionSegments: CompiledWorkflowSegment[] = plan.hasControlNodes ? plan.segments : [];
  if (plan.hasControlNodes) {
    const workflowNodes = plan.nodes;
    const order = plan.executionOrder;
    return executeWorkflowRun(
      config,
      plan.workflowName,
      workflowNodes,
      order,
      plan.waves,
      plan.output,
      true,
      options,
      executionSegments
    );
  }
  return executeWorkflowRun(
    config,
    plan.workflowName,
    plan.nodes,
    plan.executionOrder,
    plan.waves,
    plan.output,
    false,
    options
  );
}

async function executeWorkflowRun(
  config: DRSConfig,
  workflowName: string,
  workflowNodes: Record<string, WorkflowNodeConfig>,
  executionOrder: string[],
  executionWaves: string[][],
  workflowOutput: string | undefined,
  hasControl: boolean,
  options: WorkflowRunOptions,
  controlSegments?: CompiledWorkflowSegment[]
): Promise<WorkflowRunResult> {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }
  const workingDir = options.workingDir ?? process.cwd();
  const inputs = await resolveWorkflowInputs(workflow, options, workingDir);
  const nodes: Record<string, WorkflowNodeResult> = {};
  const artifacts: Record<string, unknown> = {};
  const loop: Record<string, WorkflowLoopState> = {};
  const context: WorkflowTemplateContext = { inputs, nodes, artifacts, loop };
  const executionContext: WorkflowExecutionContext = {
    gitClients: new Map(),
    platformClients: {},
    traceCollector: options.trace ? new TraceCollector() : undefined,
    locks: {
      exit: createWorkflowLock(),
      console: createWorkflowLock(),
      workspace: createWorkflowLock(),
    },
  };
  const nodeExecutor = new LocalNodeExecutor(config, options, workingDir, executionContext);

  if (!options.jsonOutput) {
    console.log(chalk.gray(`Running workflow ${workflowName}...\n`));
  }

  try {
    if (hasControl) {
      if (controlSegments) {
        const internalSegments: WorkflowSegment[] = controlSegments.map((segment) =>
          segment.type === 'control'
            ? { type: 'control', nodeId: segment.nodeId }
            : {
                type: 'dag',
                nodeIds: segment.nodeIds,
                ...(segment.activeNodeIds ? { activeNodeIds: new Set(segment.activeNodeIds) } : {}),
              }
        );
        await runControlWorkflowFromSegments(
          workflowNodes,
          internalSegments,
          options,
          context,
          nodeExecutor
        );
      } else {
        await runControlWorkflow(workflowNodes, executionOrder, options, context, nodeExecutor);
      }
    } else {
      for (const wave of executionWaves) {
        const settled = await Promise.allSettled(
          wave.map(async (nodeId) => {
            const node = workflowNodes[nodeId];
            if (!node) {
              throw new Error(`Workflow references unknown node "${nodeId}".`);
            }

            const startedAt = new Date().toISOString();
            const skipReason = getWorkflowNodeSkipReason(node, context);
            if (skipReason) {
              logWorkflowNodeSkipped(nodeId, skipReason, options);
              return {
                nodeId,
                node,
                result: completeWorkflowNodeResult(
                  createSkippedWorkflowNodeResult(nodeId),
                  startedAt
                ),
              };
            }

            logWorkflowNodeRunning(nodeId, options);
            const result = await nodeExecutor.runNode(nodeId, node, context);
            return { nodeId, node, result: completeWorkflowNodeResult(result, startedAt) };
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
          recordWorkflowNodeResult(nodeId, node, result, nodes, artifacts);
        }
      }
    }
  } catch (error) {
    if (executionContext.traceCollector && executionContext.traceCollector.getTraces().length > 0) {
      try {
        await flushWorkflowTrace(
          executionContext.traceCollector,
          workflowName,
          inputs,
          new Date().toISOString(),
          workingDir,
          options
        );
      } catch (flushError) {
        console.error(
          chalk.yellow('Warning:'),
          'Failed to persist workflow trace on failure:',
          flushError instanceof Error ? flushError.message : String(flushError)
        );
      }
    }
    throw error;
  }

  const lastNodeId = executionOrder[executionOrder.length - 1];
  const lastNode = workflowNodes[lastNodeId];
  const outputKey = workflowOutput ?? lastNode.output ?? lastNodeId;
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

  if (executionContext.traceCollector && executionContext.traceCollector.getTraces().length > 0) {
    await flushWorkflowTrace(
      executionContext.traceCollector,
      workflowName,
      inputs,
      result.timestamp,
      workingDir,
      options
    );
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
  metadata?: WorkflowMetadata;
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
  input?: string;
  with?: Record<string, string | number | boolean | undefined>;
  output?: string;
  writes?: string;
  json?: boolean;
  permissions?: WorkflowNodeConfig['permissions'];
  validation?: WorkflowNodeConfig['validation'];
  routes?: Record<string, string | Record<string, string> | undefined>;
}

export interface WorkflowDetail {
  name: string;
  source: WorkflowSource;
  overridden: boolean;
  description?: string;
  metadata?: WorkflowMetadata;
  inputs: Record<string, WorkflowInputConfig>;
  output?: string;
  nodes: WorkflowNodeDetail[];
  graph: WorkflowGraph;
}

export interface WorkflowShowOptions {
  json?: boolean;
  workingDir?: string;
}

export interface WorkflowGraphOptions {
  format?: 'text' | 'json' | 'mermaid';
  workingDir?: string;
}

export type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphEdge,
  WorkflowGraphNodeKind,
  WorkflowGraphEdgeKind,
};

export interface WorkflowValidateOptions {
  json?: boolean;
  workingDir?: string;
}

export interface WorkflowValidationEntry {
  name: string;
  valid: boolean;
  source?: WorkflowSource;
  waves?: string[][];
  error?: string;
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
        metadata: workflow.metadata,
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
  if (node.control === 'loop') {
    return { target: node.target, exit: node.exit };
  }
  if (node.control === 'switch') {
    return { cases: node.cases, default: node.default };
  }
  if (node.control === 'passThrough') {
    return { target: node.target };
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
  const graph = buildWorkflowGraph(name, workflow);

  return {
    name,
    source: info.source,
    overridden: info.overridesPackaged,
    description: workflow.description,
    metadata: workflow.metadata,
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
      input: node.input,
      with: node.with,
      output: node.output,
      writes: node.writes,
      json: node.json,
      permissions: node.permissions,
      validation: node.validation,
      routes: getWorkflowNodeRoutes(node),
    })),
    graph,
  };
}

export function showWorkflowGraph(
  config: DRSConfig,
  workflowName: string,
  options: WorkflowGraphOptions = {}
): WorkflowGraph {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow "${workflowName}".`);
  }

  const graph = buildWorkflowGraph(workflowName, workflow);
  const format = options.format ?? 'text';

  if (format === 'json') {
    console.log(JSON.stringify(graph, null, 2));
  } else if (format === 'mermaid') {
    console.log(formatWorkflowGraphMermaid(graph));
  } else {
    console.log(chalk.bold(`\nWorkflow Graph: ${graph.workflow}\n`));
    for (const node of graph.nodes) {
      const outgoing = graph.edges.filter((edge) => edge.source === node.id);
      const suffix = node.condition ? chalk.yellow(` if ${node.condition}`) : '';
      console.log(`  ${chalk.white(node.id)} ${chalk.gray(`[${node.kind}]`)}${suffix}`);
      for (const edge of outgoing) {
        const edgeLabel = edge.label ? ` ${chalk.gray(`(${edge.label})`)}` : '';
        const marker = edge.kind === 'control' ? chalk.cyan('~>') : chalk.gray('->');
        console.log(`    ${marker} ${edge.target}${edgeLabel}`);
      }
    }
    console.log('');
  }

  return graph;
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
  if (detail.metadata) {
    console.log(`  Metadata: ${JSON.stringify(detail.metadata)}`);
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
    if (node.output) console.log(`    output: ${node.output}`);
    if (node.writes) console.log(`    writes: ${node.writes}`);
    if (node.permissions) console.log(`    permissions: ${JSON.stringify(node.permissions)}`);
    if (node.validation) console.log(`    validation: ${JSON.stringify(node.validation)}`);
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

function validateSingleWorkflow(
  config: DRSConfig,
  workflowName: string,
  workingDir: string
): WorkflowValidationEntry {
  const workflow = config.workflows?.[workflowName];
  if (!workflow) {
    return { name: workflowName, valid: false, error: `Unknown workflow "${workflowName}".` };
  }

  try {
    const sourceInfo = loadWorkflowSourceInfo(workingDir);
    const workflowNodes = getWorkflowNodes(workflowName, workflow);
    const executionOrder = getWorkflowExecutionOrder(workflowNodes);
    return {
      name: workflowName,
      valid: true,
      source: sourceInfo[workflowName]?.source ?? 'packaged',
      waves: getWorkflowExecutionWaves(workflowNodes, executionOrder),
    };
  } catch (error) {
    return {
      name: workflowName,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateWorkflows(
  config: DRSConfig,
  workflowName: string | undefined,
  options: WorkflowValidateOptions = {}
): WorkflowValidationEntry[] {
  const workingDir = options.workingDir ?? process.cwd();
  const names = workflowName ? [workflowName] : Object.keys(config.workflows ?? {}).sort();
  const results = names.map((name) => validateSingleWorkflow(config, name, workingDir));

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return results;
  }

  console.log(chalk.bold('\nWorkflow Validation:\n'));
  for (const result of results) {
    if (result.valid) {
      console.log(`  ${chalk.green('✓')} ${result.name}`);
      if (result.waves) {
        console.log(
          `    waves: ${result.waves.map((wave) => `[${wave.join(', ')}]`).join(' -> ')}`
        );
      }
    } else {
      console.log(`  ${chalk.red('✗')} ${result.name}`);
      console.log(`    ${chalk.red(result.error ?? 'invalid workflow')}`);
    }
  }
  console.log('');

  return results;
}

/**
 * Default in-process {@link WorkflowExecutor}. Delegates to {@link runWorkflow}.
 *
 * The Temporal executor will implement the same interface so `drs workflow run`
 * can dispatch through either backend once `--executor temporal` is added.
 */
export class LocalWorkflowExecutor implements WorkflowExecutor {
  async run(
    config: DRSConfig,
    workflowName: string,
    options: WorkflowRunOptions = {}
  ): Promise<WorkflowRunResult> {
    return runWorkflow(config, workflowName, options);
  }
}
