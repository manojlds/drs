/**
 * Review orchestrator for local diff reviews
 *
 * This module handles local git diff reviews (pre-push analysis).
 * It uses the shared core logic from review-core.ts.
 */

import chalk from 'chalk';
import type { DRSConfig } from './config.js';
import type { ChangeSummary } from './change-summary.js';
import {
  shouldIgnoreFile,
  getDefaultModel,
  getReviewAgentId,
  getModelOverrides,
  getDescriberModelOverride,
  getDefaultThinkingLevel,
  getRuntimeConfig,
  getUnifiedModelOverride,
  getJevReviewConfig,
  resolveReviewMode,
  type ModelOverrides,
  type ReviewMode,
} from './config.js';
import { createRuntimeClientInstance, type RuntimeClient } from '../runtime/client.js';
import { calculateSummary, type ReviewIssue } from './comment-formatter.js';
import {
  buildBaseInstructions,
  runReviewPipeline,
  displayReviewSummary as displaySummary,
  hasBlockingIssues as checkBlockingIssues,
  type FileWithDiff,
} from './review-core.js';
import {
  prepareDiffsForAgent,
  formatCompressionSummary,
  resolveCompressionBudget,
} from './context-compression.js';
import {
  aggregateAgentUsage,
  createEmptyReviewUsageSummary,
  createEvaluatorUsageSummary,
  type ReviewUsageSummary,
} from './review-usage.js';
import { runDescribeAgent, type PreCompressedDiffs } from './description-executor.js';
import { formatDescribeSummary } from './description-formatter.js';
import type { ReviewFinding } from './review-artifact.js';
import type { TraceCollector } from './trace-collector.js';
import type { AgentPermissions } from './agent-permissions.js';
import type { ReviewIssueParserDiagnostics } from './issue-parser.js';
import { buildJevAgentGuidance } from './jev/guidance.js';
import { createJevClientFromEnvironment, JEV_MODEL, JevClientError } from './jev/client.js';
import { buildJevQuestions } from './jev/questions.js';
import { toJevEvaluation } from './jev/transform.js';
import type { JevEvaluation } from './jev/types.js';
import { evaluateJevChunks } from './jev/chunks.js';
import { aggregateJevResponses } from './jev/aggregate.js';

/**
 * Source information for a review (platform-agnostic)
 */
export interface ReviewSource {
  /** Human-readable name for logging (e.g., "PR #123", "MR !456", "Local diff") */
  name: string;
  /** List of changed file paths */
  files: string[];
  /** Optional: files with their diff patches (if available, passed directly to agents) */
  filesWithDiffs?: Array<{ filename: string; patch: string }>;
  /** Additional context to pass to the review agent */
  context: Record<string, unknown>;
  /** Working directory for the review (defaults to process.cwd()) */
  workingDir?: string;
  /** Debug mode - print Pi runtime configuration */
  debug?: boolean;
  /** Whether this is a staged diff (affects git diff command) */
  staged?: boolean;
  /** Reasoning effort level for the model */
  thinkingLevel?: string;
}

export type ReviewVerificationDisposition = 'resolved' | 'still_open' | 'partial';

export interface ReviewVerificationFinding {
  id: string;
  disposition: ReviewVerificationDisposition;
  rationale?: string;
  issue?: ReviewIssue;
}

export interface ReviewVerificationResult {
  findings: ReviewVerificationFinding[];
}

export interface ReviewVerificationContext {
  artifact: {
    reviewId: string;
    findings: ReviewFinding[];
    evaluations?: ReviewResult['evaluations'];
  };
  artifactPath?: string;
  severity?: string;
}

/**
 * Result of a review execution
 */
export interface ReviewResult {
  /** All issues found by the review agent */
  issues: ReviewIssue[];
  /** Calculated summary statistics */
  summary: ReturnType<typeof calculateSummary>;
  /** Diff-based change summary when available */
  changeSummary?: ChangeSummary;
  /** Number of files actually reviewed (after filtering) */
  filesReviewed: number;
  /** Token usage and cost details for the review run */
  usage?: ReviewUsageSummary;
  mode?: ReviewMode;
  evaluations?: {
    jev?:
      | { status: 'completed'; evaluation: JevEvaluation }
      | { status: 'failed'; error: { code: string; message: string } };
  };
  /** Explicit verification verdicts for an existing review artifact. */
  verification?: ReviewVerificationResult;
  parserDiagnostics?: ReviewIssueParserDiagnostics[];
}

/**
 * Filter files based on ignore patterns in config
 */
export function filterIgnoredFiles(files: string[], config: DRSConfig): string[] {
  return files.filter((file) => !shouldIgnoreFile(file, config));
}

export function getReviewBudgetModelIds(
  config: DRSConfig,
  agentModelOverrides: ModelOverrides,
  unifiedModelOverrides: ModelOverrides
): string[] {
  const modelIds = [getReviewAgentId(config)]
    .map((agentId) => {
      if (agentId === 'review/unified-reviewer' && unifiedModelOverrides[agentId]) {
        return unifiedModelOverrides[agentId];
      }
      if (agentModelOverrides[agentId]) {
        return agentModelOverrides[agentId];
      }
      return undefined;
    })
    .filter((id): id is string => !!id);

  return [...new Set(modelIds)];
}

export interface ConnectOptions {
  debug?: boolean;
  modelOverrides?: ModelOverrides;
  thinkingLevel?: string;
  traceCollector?: TraceCollector;
  permissions?: AgentPermissions;
}

export interface ExecuteReviewOptions {
  permissions?: AgentPermissions;
  mode?: ReviewMode | 'configured';
}

/**
 * Connect to Pi runtime (in-process by default)
 */
export async function connectToRuntime(
  config: DRSConfig,
  workingDir?: string,
  options?: ConnectOptions
): Promise<RuntimeClient> {
  console.log(chalk.gray('Connecting to Pi runtime...\n'));

  try {
    // Get model overrides from DRS config
    const modelOverrides = options?.modelOverrides ?? {
      ...getModelOverrides(config),
      ...getUnifiedModelOverride(config),
    };

    const runtimeConfig = getRuntimeConfig(config);

    const thinkingLevel = options?.thinkingLevel ?? getDefaultThinkingLevel(config);

    return await createRuntimeClientInstance({
      directory: workingDir ?? process.cwd(),
      modelOverrides,
      provider: runtimeConfig.provider,
      operationTimeoutMs: runtimeConfig.runtime?.operationTimeoutMs,
      streamTimeoutMs: runtimeConfig.runtime?.streamTimeoutMs,
      streamPollIntervalMs: runtimeConfig.runtime?.streamPollIntervalMs,
      providerRetry: runtimeConfig.retry?.provider,
      config,
      debug: options?.debug,
      thinkingLevel,
      traceCollector: options?.traceCollector,
      permissions: options?.permissions,
    });
  } catch (error) {
    console.error(chalk.red('✗ Failed to connect to Pi runtime'));
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}\n`));
    console.log(
      chalk.yellow('Please check your Pi runtime configuration and model credentials.\n')
    );
    throw error;
  }
}

/**
 * Execute a code review using Pi runtime agents.
 *
 * This is the core review orchestrator that handles:
 * - File filtering (ignore patterns)
 * - Pi runtime connection
 * - Agent execution and streaming
 * - Issue parsing and collection
 * - Summary calculation
 *
 * Platform-specific logic (GitHub/GitLab/local) should:
 * 1. Fetch changed files from their source
 * 2. Call this function with a ReviewSource
 * 3. Handle posting results to their platform
 */
export async function executeReview(
  config: DRSConfig,
  source: ReviewSource,
  options: ExecuteReviewOptions = {}
): Promise<ReviewResult> {
  const mode = resolveReviewMode(config, options.mode);
  const includesAgent = mode === 'agent' || mode === 'parallel' || mode === 'combined';
  const jevConfig = getJevReviewConfig(config);

  if (includesAgent && !getDefaultModel(config)) {
    throw new Error(
      'Default model is required before running an agent-backed review. Configure agents.default.model or set DRS_DEFAULT_MODEL.'
    );
  }

  console.log(chalk.gray(`Found ${source.files.length} changed file(s)\n`));

  // Filter files based on ignore patterns
  const filteredFiles = filterIgnoredFiles(source.files, config);
  const ignoredCount = source.files.length - filteredFiles.length;

  if (ignoredCount > 0) {
    console.log(chalk.gray(`Ignoring ${ignoredCount} file(s) based on patterns\n`));
  }

  if (filteredFiles.length === 0) {
    console.log(chalk.yellow('✓ No files to review after filtering\n'));
    return {
      issues: [],
      summary: calculateSummary(0, []),
      filesReviewed: 0,
      usage: createEmptyReviewUsageSummary(),
      ...(mode !== 'agent' ? { mode } : {}),
      parserDiagnostics: [],
    };
  }

  console.log(chalk.gray(`Reviewing ${filteredFiles.length} file(s)\n`));

  // Include describer model overrides if describe is enabled
  const describeEnabled = config.review.describe?.enabled ?? false;
  const describeOverrides = describeEnabled ? getDescriberModelOverride(config) : {};
  const agentModelOverrides = getModelOverrides(config);
  const unifiedModelOverrides = getUnifiedModelOverride(config);
  const reviewOverrides = {
    ...agentModelOverrides,
    ...unifiedModelOverrides,
    ...describeOverrides,
  };

  let runtimeClient: RuntimeClient | undefined;
  try {
    if (includesAgent) {
      runtimeClient = await connectToRuntime(config, source.workingDir, {
        debug: source.debug,
        modelOverrides: reviewOverrides,
        thinkingLevel: source.thinkingLevel,
        traceCollector: source.context.traceCollector as TraceCollector | undefined,
        permissions: options.permissions,
      });
    }

    // Build instructions - use provided diffs if available, otherwise fall back to git command
    const diffCommand = source.staged ? 'git diff --cached -- <file>' : 'git diff -- <file>';

    // Keep the authoritative file list even when a provider omits an inline
    // patch for a binary, oversized, or collapsed file.
    const patchesByFilename = new Map(
      (source.filesWithDiffs ?? []).map((file) => [file.filename, file.patch])
    );
    const filesForInstructions: FileWithDiff[] = filteredFiles.map((filename) =>
      patchesByFilename.has(filename)
        ? { filename, patch: patchesByFilename.get(filename)! }
        : { filename }
    );

    // ── Compress agent diffs once ────────────────────────────────────────
    // Jev receives authoritative patches through its own chunking path.
    const reviewModelIds = getReviewBudgetModelIds(
      config,
      agentModelOverrides,
      unifiedModelOverrides
    );
    const describeModelIds = describeEnabled
      ? [...new Set(Object.values(getDescriberModelOverride(config)))].filter(
          (id): id is string => !!id
        )
      : [];
    const allModelIds = [...reviewModelIds, ...describeModelIds];
    const runtimeContextWindow = runtimeClient?.getMinContextWindow(allModelIds);
    const compressionOptions = resolveCompressionBudget(
      runtimeContextWindow,
      config.contextCompression
    );

    const compression = prepareDiffsForAgent(filesForInstructions, compressionOptions);
    const compressionSummary = formatCompressionSummary(compression);

    if (compressionSummary && includesAgent) {
      console.log(chalk.yellow('⚠ Diff content trimmed to fit token budget.\n'));
    }

    const verificationContext = isReviewVerificationContext(source.context.verification)
      ? source.context.verification
      : undefined;

    // ── Describe pass (optional, skipped in verification mode) ──────────
    let describeSummary: string | undefined;
    if (
      includesAgent &&
      runtimeClient &&
      describeEnabled &&
      !verificationContext &&
      filesForInstructions.some((f) => f.patch)
    ) {
      try {
        console.log(chalk.bold.blue('🔍 Running describe pass for change context\n'));
        const preCompressed: PreCompressedDiffs = {
          files: compression.files,
          compressionSummary: compressionSummary,
        };
        const { description } = await runDescribeAgent(
          runtimeClient,
          config,
          source.name,
          filesForInstructions,
          source.workingDir ?? process.cwd(),
          source.debug,
          preCompressed
        );
        describeSummary = formatDescribeSummary(description);
      } catch (describeError) {
        console.warn(
          chalk.yellow(
            `⚠ Describe pass failed, continuing review without change context: ${describeError instanceof Error ? describeError.message : String(describeError)}\n`
          )
        );
      }
    }

    // ── Review pass ──────────────────────────────────────────────────────
    const agentArgs = {
      runtimeClient: runtimeClient!,
      config,
      source,
      filteredFiles,
      compressionFiles: compression.files,
      compressionSummary,
      diffCommand,
      describeSummary,
      verificationContext,
    };
    const jevArgs = {
      config,
      source,
      files: filesForInstructions,
      describeSummary: mode === 'combined' ? describeSummary : undefined,
      previousEvaluation: getPreviousJevEvaluation(verificationContext),
    };

    if (mode === 'jev') {
      const jev = await runJevReviewComponent(jevArgs);
      return {
        issues: [],
        summary: calculateSummary(filteredFiles.length, []),
        filesReviewed: filteredFiles.length,
        usage: aggregateAgentUsage([jev.usage]),
        mode,
        evaluations: { jev: { status: 'completed', evaluation: jev.evaluation } },
        parserDiagnostics: [],
      };
    }

    let agent!: Awaited<ReturnType<typeof runAgentReviewComponent>>;
    let jevEvaluation: ReviewResult['evaluations'];
    let usage!: ReviewUsageSummary;
    if (mode === 'parallel') {
      const [agentOutcome, jevOutcome] = await Promise.allSettled([
        runAgentReviewComponent(agentArgs),
        runJevReviewComponent(jevArgs),
      ]);
      if (agentOutcome.status === 'rejected') throw agentOutcome.reason;
      agent = agentOutcome.value;
      usage = agent.usage ?? createEmptyReviewUsageSummary();
      if (jevOutcome.status === 'fulfilled') {
        const jev = jevOutcome.value;
        jevEvaluation = { jev: { status: 'completed', evaluation: jev.evaluation } };
        usage = aggregateAgentUsage([...(usage.agents ?? []), jev.usage]);
      } else {
        if (jevConfig.failurePolicy !== 'continue-agent') throw jevOutcome.reason;
        jevEvaluation = {
          jev: { status: 'failed', error: sanitizeJevError(jevOutcome.reason) },
        };
      }
    } else if (mode === 'combined') {
      const jev = await runJevReviewComponent(jevArgs);
      agent = await runAgentReviewComponent({
        ...agentArgs,
        reviewGuidance: buildJevAgentGuidance(jev.evaluation),
      });
      jevEvaluation = { jev: { status: 'completed', evaluation: jev.evaluation } };
      usage = aggregateAgentUsage([...(agent.usage?.agents ?? []), jev.usage]);
    } else {
      agent = await runAgentReviewComponent(agentArgs);
      usage = agent.usage ?? createEmptyReviewUsageSummary();
    }

    return {
      issues: agent.issues,
      summary: agent.summary,
      changeSummary: agent.changeSummary,
      filesReviewed: agent.filesReviewed,
      usage,
      ...(mode !== 'agent' ? { mode } : {}),
      ...(jevEvaluation ? { evaluations: jevEvaluation } : {}),
      verification: agent.verification,
      parserDiagnostics: agent.parserDiagnostics ?? [],
    };
  } finally {
    // Always shut down Pi runtime client
    await runtimeClient?.shutdown();
  }
}

async function runAgentReviewComponent(args: {
  runtimeClient: RuntimeClient;
  config: DRSConfig;
  source: ReviewSource;
  filteredFiles: string[];
  compressionFiles: FileWithDiff[];
  compressionSummary: string | null;
  diffCommand: string;
  describeSummary?: string;
  verificationContext?: ReviewVerificationContext;
  reviewGuidance?: string;
}): Promise<Awaited<ReturnType<typeof runReviewPipeline>>> {
  const baseInstructions = buildBaseInstructions(
    args.source.name,
    args.compressionFiles,
    args.diffCommand,
    args.compressionSummary ?? undefined,
    args.verificationContext
  );

  return runReviewPipeline(
    args.runtimeClient,
    args.config,
    baseInstructions,
    args.source.name,
    args.filteredFiles,
    {
      ...args.source.context,
      describeSummary: args.describeSummary,
      verificationContext: args.verificationContext,
      reviewGuidance: args.reviewGuidance,
    },
    args.source.workingDir ?? process.cwd(),
    args.source.debug ?? false
  );
}

async function runJevReviewComponent(args: {
  config: DRSConfig;
  source: ReviewSource;
  files: FileWithDiff[];
  describeSummary?: string;
  previousEvaluation?: JevEvaluation;
}): Promise<{
  evaluation: JevEvaluation;
  usage: ReturnType<typeof createEvaluatorUsageSummary>;
}> {
  const jevConfig = getJevReviewConfig(args.config);
  const client = createJevClientFromEnvironment({
    timeoutMs: jevConfig.timeoutMs,
    maxRetries: jevConfig.maxRetries,
  });
  const questions = buildJevQuestions();
  const chunks = await evaluateJevChunks({
    label: args.source.name,
    files: args.files,
    contextWindow: jevConfig.contextWindow,
    questions,
    evaluate: (state, chunkQuestions) => client.evaluate(state, chunkQuestions),
    changeSummary: args.describeSummary,
    sourceDescription: args.source.context,
  });
  const evaluation = toJevEvaluation(aggregateJevResponses(chunks), args.previousEvaluation);
  const evaluatedFiles = new Set(chunks.flatMap((chunk) => chunk.fileNames));
  const complete =
    args.source.context.diffComplete !== false &&
    args.files.every((file) => evaluatedFiles.has(file.filename));
  evaluation.coverage = {
    requests: chunks.length,
    files: args.files.length,
    evaluatedFiles: evaluatedFiles.size,
    complete,
  };
  const pricing =
    args.config.pricing?.models?.[evaluation.model] ??
    args.config.pricing?.models?.[JEV_MODEL] ??
    args.config.pricing?.models?.['jev-latest'];
  return {
    evaluation,
    usage: createEvaluatorUsageSummary('evaluator/jev', {
      inputTokens: evaluation.usage.inputTokens,
      outputTokens: evaluation.usage.outputTokens,
      model: evaluation.model,
      success: true,
      turns: chunks.length,
      pricing,
    }),
  };
}

function sanitizeJevError(error: unknown): { code: string; message: string } {
  if (error instanceof JevClientError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'api_error',
    message: 'Jev evaluation failed.',
  };
}

function getPreviousJevEvaluation(
  verificationContext: ReviewVerificationContext | undefined
): JevEvaluation | undefined {
  const jev = verificationContext?.artifact.evaluations?.jev;
  return jev?.status === 'completed' ? jev.evaluation : undefined;
}

function isReviewVerificationContext(value: unknown): value is ReviewVerificationContext {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ReviewVerificationContext>;
  return (
    !!candidate.artifact &&
    typeof candidate.artifact === 'object' &&
    typeof candidate.artifact.reviewId === 'string' &&
    Array.isArray(candidate.artifact.findings)
  );
}

// Re-export display functions from core for backward compatibility
export const displayReviewSummary = displaySummary;
export const hasBlockingIssues = checkBlockingIssues;
