import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { DRSConfig } from './config.js';
import { getRuntimeConfig } from './config.js';
import { resolveWithinWorkingDir } from './path-utils.js';
import {
  loadLatestReviewArtifact,
  reviewArtifactToJsonOutput,
  toRepoRelativePath,
} from './review-artifact-store.js';
import {
  createRuntimeClientInstance,
  type RuntimeClient,
  type Session,
  type SessionMessage,
} from '../runtime/client.js';

export const DEFAULT_CONVERSATION_AGENT = 'task/review-assistant';
export const DEFAULT_WORKFLOW_OUTPUT_PATH = '.drs/.desktop-run.json';

export type ConversationSubjectKind = 'review' | 'workflow-run' | 'local-diff' | 'finding';
export type ConversationMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationSubject {
  kind: ConversationSubjectKind;
  reviewId?: string;
  workflowRunId?: string;
  findingIds?: string[];
}

export interface ConversationMessage {
  id: string;
  role: ConversationMessageRole;
  content: string;
  timestamp: string;
  toolName?: string;
  toolCallId?: string;
}

export interface ConversationArtifact {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDir: string;
  agent: string;
  subject: ConversationSubject;
  piSessionId?: string;
  artifactPaths: {
    reviewOutput?: string;
    workflowOutput?: string;
  };
  messages: ConversationMessage[];
  state: 'active' | 'closed';
}

export interface ConversationContext {
  reviewOutput?: unknown;
  workflowOutput?: unknown;
  artifactPaths: ConversationArtifact['artifactPaths'];
}

export interface StartConversationOptions {
  workingDir?: string;
  agent?: string;
  subject?: ConversationSubject;
  workflowOutputPath?: string;
}

export interface SendConversationMessageOptions {
  conversationId: string;
  message: string;
}

export interface ConversationTurnResult {
  conversation: ConversationArtifact;
  messages: ConversationMessage[];
  response: string;
}

export type ConversationStreamEvent =
  | {
      type: 'user_message';
      conversationId: string;
      message: ConversationMessage;
    }
  | {
      type: 'message';
      conversationId: string;
      message: ConversationMessage;
    }
  | {
      type: 'response_delta';
      conversationId: string;
      messageId: string;
      text: string;
    }
  | {
      type: 'turn_done';
      conversationId: string;
      conversation: ConversationArtifact;
      response: string;
    };

export interface ConversationRuntime {
  createSession(options: { agent: string; message: string }): Promise<Session>;
  sendMessage(sessionId: string, content: string): Promise<void>;
  streamMessages(sessionId: string): AsyncGenerator<SessionMessage>;
  closeSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ConversationRuntimeFactoryOptions {
  config: DRSConfig;
  workingDir: string;
  agent: string;
}

export type ConversationRuntimeFactory = (
  options: ConversationRuntimeFactoryOptions
) => Promise<ConversationRuntime>;

export interface ConversationServiceOptions {
  config: DRSConfig;
  workingDir?: string;
  runtimeFactory?: ConversationRuntimeFactory;
}

function createConversationId(date: Date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '');
  const random = Math.random().toString(36).slice(2, 8);
  return `conv_${timestamp}_${random}`;
}

function serializeRuntimeMessage(message: SessionMessage): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    toolName: message.toolName,
    toolCallId: message.toolCallId,
  };
}

async function readJsonIfExists(workingDir: string, relativePath: string): Promise<unknown> {
  const fullPath = resolveWithinWorkingDir(workingDir, relativePath, 'read');
  try {
    return JSON.parse(await readFile(fullPath, 'utf-8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildConversationPrompt(context: ConversationContext, userMessage: string): string {
  const sections = [
    'You are DRS review assistant, helping the user understand and act on DRS review/workflow output.',
    'Answer using the supplied DRS artifacts as ground truth. Cite finding ids when present. If the artifacts do not contain enough information, say what is missing instead of guessing.',
    'This first conversational implementation is read-oriented. Do not edit files unless the user explicitly asks for a fix and your available tools allow it.',
  ];

  if (context.reviewOutput !== undefined) {
    sections.push(
      `## Review Output (${context.artifactPaths.reviewOutput})\n\n${compactJson(context.reviewOutput)}`
    );
  }

  if (context.workflowOutput !== undefined) {
    sections.push(
      `## Workflow Output (${context.artifactPaths.workflowOutput})\n\n${compactJson(context.workflowOutput)}`
    );
  }

  if (context.reviewOutput === undefined && context.workflowOutput === undefined) {
    sections.push(
      'No DRS review or workflow artifact was found for this conversation. Explain that limitation and answer only from available repository context.'
    );
  }

  sections.push(`## User Message\n\n${userMessage}`);
  return sections.join('\n\n');
}

async function defaultRuntimeFactory({
  config,
  workingDir,
}: ConversationRuntimeFactoryOptions): Promise<RuntimeClient> {
  const runtimeConfig = getRuntimeConfig(config);
  return createRuntimeClientInstance({
    directory: workingDir,
    provider: runtimeConfig.provider,
    operationTimeoutMs: runtimeConfig.runtime?.operationTimeoutMs,
    streamTimeoutMs: runtimeConfig.runtime?.streamTimeoutMs,
    streamPollIntervalMs: runtimeConfig.runtime?.streamPollIntervalMs,
    providerRetry: runtimeConfig.retry?.provider,
    config,
  });
}

export class ConversationService {
  private readonly config: DRSConfig;
  private readonly workingDir: string;
  private readonly runtimeFactory: ConversationRuntimeFactory;
  private readonly conversations = new Map<string, ConversationArtifact>();
  private readonly runtimes = new Map<string, ConversationRuntime>();
  private readonly contexts = new Map<string, ConversationContext>();
  private readonly seenRuntimeMessageIds = new Map<string, Set<string>>();

  constructor(options: ConversationServiceOptions) {
    this.config = options.config;
    this.workingDir = options.workingDir ?? process.cwd();
    this.runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
  }

  async startConversation(options: StartConversationOptions = {}): Promise<ConversationArtifact> {
    const workingDir = options.workingDir ?? this.workingDir;
    const workflowOutputPath = options.workflowOutputPath ?? DEFAULT_WORKFLOW_OUTPUT_PATH;
    const now = new Date().toISOString();
    const id = createConversationId();

    const latestReviewArtifact = await loadLatestReviewArtifact(workingDir);
    const canonicalReviewOutput = latestReviewArtifact
      ? {
          ...reviewArtifactToJsonOutput(latestReviewArtifact.artifact.payload),
          artifact: {
            reviewId: latestReviewArtifact.artifact.payload.reviewId,
            path: toRepoRelativePath(workingDir, latestReviewArtifact.path),
          },
        }
      : undefined;
    const effectiveReviewOutputPath = latestReviewArtifact
      ? toRepoRelativePath(workingDir, latestReviewArtifact.path)
      : undefined;
    const context: ConversationContext = {
      reviewOutput: canonicalReviewOutput,
      workflowOutput: await readJsonIfExists(workingDir, workflowOutputPath),
      artifactPaths: {
        reviewOutput: effectiveReviewOutputPath,
        workflowOutput: workflowOutputPath,
      },
    };

    const conversation: ConversationArtifact = {
      schemaVersion: 1,
      id,
      createdAt: now,
      updatedAt: now,
      workingDir,
      agent: options.agent ?? DEFAULT_CONVERSATION_AGENT,
      subject: options.subject ?? { kind: 'review' },
      artifactPaths: context.artifactPaths,
      messages: [],
      state: 'active',
    };

    this.conversations.set(id, conversation);
    this.contexts.set(id, context);
    await this.persistConversation(conversation);
    return conversation;
  }

  getConversation(conversationId: string): ConversationArtifact {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation "${conversationId}".`);
    }
    return conversation;
  }

  async sendMessage(options: SendConversationMessageOptions): Promise<ConversationTurnResult> {
    const messages: ConversationMessage[] = [];
    let response = '';
    let conversation = this.getConversation(options.conversationId);

    for await (const event of this.streamMessage(options)) {
      if (event.type === 'message') {
        messages.push(event.message);
      }
      if (event.type === 'response_delta') {
        response += event.text;
      }
      if (event.type === 'turn_done') {
        conversation = event.conversation;
      }
    }

    return { conversation, messages, response };
  }

  async *streamMessage(
    options: SendConversationMessageOptions
  ): AsyncGenerator<ConversationStreamEvent> {
    const conversation = this.getConversation(options.conversationId);
    if (conversation.state !== 'active') {
      throw new Error(`Conversation "${conversation.id}" is closed.`);
    }
    if (!options.message.trim()) {
      throw new Error('Conversation message cannot be empty.');
    }

    const userMessage: ConversationMessage = {
      id: `${conversation.id}-user-${conversation.messages.length + 1}`,
      role: 'user',
      content: options.message,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(userMessage);
    yield { type: 'user_message', conversationId: conversation.id, message: userMessage };

    const runtime = await this.getOrCreateRuntime(conversation);
    const context = this.contexts.get(conversation.id) ?? {
      artifactPaths: conversation.artifactPaths,
    };

    if (!conversation.piSessionId) {
      const session = await runtime.createSession({
        agent: conversation.agent,
        message: buildConversationPrompt(context, options.message),
      });
      conversation.piSessionId = session.id;
    } else {
      await runtime.sendMessage(conversation.piSessionId, options.message);
    }

    const seen = this.seenRuntimeMessageIds.get(conversation.id) ?? new Set<string>();
    this.seenRuntimeMessageIds.set(conversation.id, seen);
    let response = '';
    for await (const runtimeMessage of runtime.streamMessages(conversation.piSessionId)) {
      if (seen.has(runtimeMessage.id)) {
        continue;
      }
      seen.add(runtimeMessage.id);
      const message = serializeRuntimeMessage(runtimeMessage);
      conversation.messages.push(message);
      yield { type: 'message', conversationId: conversation.id, message };
      if (message.role === 'assistant') {
        response += message.content;
        yield {
          type: 'response_delta',
          conversationId: conversation.id,
          messageId: message.id,
          text: message.content,
        };
      }
    }

    conversation.updatedAt = new Date().toISOString();
    await this.persistConversation(conversation);
    yield { type: 'turn_done', conversationId: conversation.id, conversation, response };
  }

  async closeConversation(conversationId: string): Promise<ConversationArtifact> {
    const conversation = this.getConversation(conversationId);
    const runtime = this.runtimes.get(conversationId);
    if (runtime && conversation.piSessionId) {
      await runtime.closeSession(conversation.piSessionId);
      await runtime.shutdown();
    }
    this.runtimes.delete(conversationId);
    conversation.state = 'closed';
    conversation.updatedAt = new Date().toISOString();
    await this.persistConversation(conversation);
    return conversation;
  }

  private async getOrCreateRuntime(
    conversation: ConversationArtifact
  ): Promise<ConversationRuntime> {
    const existing = this.runtimes.get(conversation.id);
    if (existing) {
      return existing;
    }
    const runtime = await this.runtimeFactory({
      config: this.config,
      workingDir: conversation.workingDir,
      agent: conversation.agent,
    });
    this.runtimes.set(conversation.id, runtime);
    return runtime;
  }

  private async persistConversation(conversation: ConversationArtifact): Promise<void> {
    const directory = resolveWithinWorkingDir(this.workingDir, '.drs/conversations', 'write');
    const content = `${JSON.stringify(conversation, null, 2)}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${conversation.id}.json`), content, 'utf-8');
    await writeFile(join(directory, 'latest.json'), content, 'utf-8');
  }
}
