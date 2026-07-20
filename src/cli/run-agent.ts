import { readFile, writeFile } from 'fs/promises';
import chalk from 'chalk';
import type { DRSConfig } from '../lib/config.js';
import {
  getRuntimeConfig,
  resolveAgentRunConfig,
  resolveAgentThinkingLevel,
} from '../lib/config.js';
import { requireAgentId } from '../lib/agent-id.js';
import { resolveWithinWorkingDir } from '../lib/path-utils.js';
import { applyUsageMessage, createAgentUsageSummary } from '../lib/review-usage.js';
import type { AgentRunResult } from '../lib/agent-result.js';
export type { AgentRunResult } from '../lib/agent-result.js';
import { getLogger } from '../lib/logger.js';
import { getAgent } from '../runtime/agent-loader.js';
import { createRuntimeClientInstance, type Session } from '../runtime/client.js';
import type { TraceCollector } from '../lib/trace-collector.js';
import {
  AgentFilesystemAuthorizer,
  assertAgentWorkspaceChangesAllowed,
  captureAgentWorkspaceSnapshot,
  type AgentPermissions,
  type AgentValidation,
  type AgentWorkspaceSnapshot,
} from '../lib/agent-permissions.js';

export interface RunAgentOptions {
  prompt?: string;
  file?: string;
  stdin?: boolean;
  model?: string;
  outputPath?: string;
  jsonOutput?: boolean;
  debug?: boolean;
  thinkingLevel?: string;
  workingDir?: string;
  quiet?: boolean;
  allowImplicitStdin?: boolean;
  ignoreConfiguredOutput?: boolean;
  traceCollector?: TraceCollector;
  permissions?: AgentPermissions;
  validation?: AgentValidation;
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf-8');

  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

async function readPrompt(options: RunAgentOptions, workingDir: string): Promise<string> {
  const promptSources = [
    options.prompt !== undefined,
    options.file !== undefined,
    options.stdin,
  ].filter(Boolean).length;

  if (promptSources > 1) {
    throw new Error('Use only one prompt source: --prompt, --file, or --stdin.');
  }

  if (options.prompt !== undefined) {
    return options.prompt;
  }

  if (options.file) {
    const promptPath = resolveWithinWorkingDir(workingDir, options.file, 'read');
    return readFile(promptPath, 'utf-8');
  }

  const shouldReadStdin =
    options.stdin === true ||
    (options.allowImplicitStdin !== false && process.stdin.isTTY !== true);
  if (shouldReadStdin) {
    return readStdin();
  }

  throw new Error('Provide a prompt with --prompt, --file, or --stdin.');
}

function formatAgentRunJson(result: AgentRunResult): string {
  return JSON.stringify(result, null, 2);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function runAgent(
  config: DRSConfig,
  agentId: string,
  options: RunAgentOptions = {}
): Promise<AgentRunResult> {
  requireAgentId(agentId);

  const workingDir = options.workingDir ?? process.cwd();
  const agent = getAgent(workingDir, agentId, config);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}". Run "drs list-agents" to see available agents.`);
  }

  const configuredRun = resolveAgentRunConfig(config, agentId);
  const effectiveOptions: RunAgentOptions = {
    ...options,
    prompt: options.prompt ?? configuredRun.prompt,
    file: options.file ?? configuredRun.promptFile,
    outputPath: options.ignoreConfiguredOutput
      ? options.outputPath
      : (options.outputPath ?? configuredRun.output),
    jsonOutput: options.ignoreConfiguredOutput
      ? (options.jsonOutput ?? false)
      : (options.jsonOutput ?? configuredRun.json ?? false),
    thinkingLevel: options.thinkingLevel ?? resolveAgentThinkingLevel(config, agentId),
  };

  const prompt = await readPrompt(effectiveOptions, workingDir);
  if (!prompt.trim()) {
    throw new Error('Agent prompt cannot be empty.');
  }

  const runtimeConfig = getRuntimeConfig(config);
  let workspaceSnapshot: AgentWorkspaceSnapshot | undefined;
  if (
    effectiveOptions.permissions?.filesystem?.write ||
    effectiveOptions.permissions?.filesystem?.delete
  ) {
    workspaceSnapshot = await captureAgentWorkspaceSnapshot(workingDir);
  }
  const runtimeClient = await createRuntimeClientInstance({
    directory: workingDir,
    provider: runtimeConfig.provider,
    operationTimeoutMs: runtimeConfig.runtime?.operationTimeoutMs,
    streamTimeoutMs: runtimeConfig.runtime?.streamTimeoutMs,
    streamPollIntervalMs: runtimeConfig.runtime?.streamPollIntervalMs,
    providerRetry: runtimeConfig.retry?.provider,
    config,
    debug: options.debug,
    thinkingLevel: effectiveOptions.thinkingLevel,
    modelOverrides: options.model ? { [agentId]: options.model } : undefined,
    traceCollector: options.traceCollector,
    permissions: effectiveOptions.permissions,
    validation: effectiveOptions.validation,
  });

  if (options.traceCollector) {
    options.traceCollector.setContext('run-agent', agentId, prompt);
  }

  let session: Session | undefined;
  let usage = createAgentUsageSummary(agentId);
  let response = '';
  let result: AgentRunResult | undefined;
  let operationError: Error | undefined;
  let cleanupError: Error | undefined;
  const logger = getLogger();

  try {
    if (!effectiveOptions.jsonOutput && !effectiveOptions.quiet) {
      console.log(chalk.gray(`Running ${agentId}...\n`));
    }

    session = await runtimeClient.createSession({
      agent: agentId,
      message: prompt,
    });

    for await (const message of runtimeClient.streamMessages(session.id)) {
      if (message.role === 'assistant') {
        usage = applyUsageMessage(usage, message);
        response += message.content;
        continue;
      }

      if (message.role === 'tool' && options.debug) {
        logger.toolOutput(message.toolName ?? 'unknown', agentId, message.content);
      }
    }

    usage = {
      ...usage,
      success: true,
    };

    result = {
      timestamp: new Date().toISOString(),
      agent: agentId,
      response,
      usage,
    };

    const output = effectiveOptions.jsonOutput ? formatAgentRunJson(result) : response;

    if (effectiveOptions.outputPath) {
      if (effectiveOptions.permissions?.filesystem) {
        if (!effectiveOptions.permissions.filesystem.write) {
          throw new Error('Agent outputPath requires filesystem write permission.');
        }
        await new AgentFilesystemAuthorizer(
          workingDir,
          effectiveOptions.permissions.filesystem
        ).authorize('write', effectiveOptions.outputPath);
      }
      const outputPath = resolveWithinWorkingDir(workingDir, effectiveOptions.outputPath, 'write');
      await writeFile(outputPath, output, 'utf-8');
      if (!effectiveOptions.jsonOutput && !effectiveOptions.quiet) {
        console.log(chalk.green(`\n✓ Agent output saved to ${effectiveOptions.outputPath}`));
      }
    }

    if (effectiveOptions.quiet) {
      // Workflow execution handles its own output.
    } else if (effectiveOptions.jsonOutput) {
      console.log(formatAgentRunJson(result));
    } else if (response.trim()) {
      console.log(response);
    }
  } catch (error) {
    operationError = asError(error);
  } finally {
    try {
      if (session) await runtimeClient.closeSession(session.id);
    } catch (error) {
      cleanupError = asError(error);
    }
    try {
      await runtimeClient.shutdown();
    } catch (error) {
      cleanupError ??= asError(error);
    }
    try {
      if (
        workspaceSnapshot &&
        (effectiveOptions.permissions?.filesystem?.write ||
          effectiveOptions.permissions?.filesystem?.delete)
      ) {
        await assertAgentWorkspaceChangesAllowed(
          workingDir,
          effectiveOptions.permissions.filesystem,
          workspaceSnapshot
        );
      }
    } catch (error) {
      cleanupError = asError(error);
    }
  }

  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (!result) throw new Error(`Agent "${agentId}" completed without a result.`);
  return result;
}
