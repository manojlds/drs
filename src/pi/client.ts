/**
 * Pi-mono Agent client wrapper for DRS
 *
 * Uses @mariozechner/pi-agent-core Agent class for direct in-process
 * agent execution. No HTTP server needed.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { readFileSync } from 'fs';
import type { DRSConfig } from '../lib/config.js';
import { writeJsonOutputTool } from './tools/write-json-output.js';
import { getAgent } from './agent-loader.js';

export interface PiClientConfig {
  directory?: string;
  modelOverrides?: Record<string, string>;
  debug?: boolean;
  config?: DRSConfig;
}

export interface SessionCreateOptions {
  agent: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
}

export interface Session {
  id: string;
  agent: string;
  createdAt: Date;
}

interface ActiveSession {
  id: string;
  agent: Agent;
  agentName: string;
}

/**
 * Parse a model string like "anthropic/claude-sonnet-4-5-20250929" into provider and model ID.
 * Falls back to "anthropic" provider if no slash is present.
 */
function parseModelString(modelStr: string): { provider: string; modelId: string } {
  const slashIndex = modelStr.indexOf('/');
  if (slashIndex === -1) {
    return { provider: 'anthropic', modelId: modelStr };
  }
  return {
    provider: modelStr.slice(0, slashIndex),
    modelId: modelStr.slice(slashIndex + 1),
  };
}

/**
 * Load the system prompt from an agent definition markdown file.
 * Strips YAML frontmatter and returns the body as the system prompt.
 */
function loadSystemPrompt(agentPath: string): string {
  const content = readFileSync(agentPath, 'utf-8');
  // Strip YAML frontmatter
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
  if (frontmatterMatch) {
    return content.slice(frontmatterMatch[0].length).trim();
  }
  return content.trim();
}

/**
 * Pi-mono client for DRS agent execution
 */
export class PiClient {
  private config: PiClientConfig;
  private sessions = new Map<string, ActiveSession>();
  private sessionCounter = 0;

  constructor(config: PiClientConfig) {
    this.config = config;
  }

  /**
   * Initialize - no-op for pi-mono (no server to start)
   */
  async initialize(): Promise<void> {
    if (this.config.debug) {
      console.log('🔍 Pi-mono client initialized (in-process)');
      if (this.config.modelOverrides && Object.keys(this.config.modelOverrides).length > 0) {
        console.log('📋 Agent model configuration:');
        for (const [agentName, model] of Object.entries(this.config.modelOverrides)) {
          console.log(`  • ${agentName}: ${model}`);
        }
        console.log('');
      }
    }
  }

  /**
   * Create a session - instantiates an Agent and sends the initial prompt
   */
  async createSession(options: SessionCreateOptions): Promise<Session> {
    const sessionId = `pi-session-${++this.sessionCounter}-${Date.now()}`;

    // Resolve model for this agent
    const modelStr =
      this.config.modelOverrides?.[options.agent] || 'anthropic/claude-sonnet-4-5-20250929';
    const { provider, modelId } = parseModelString(modelStr);

    if (this.config.debug) {
      console.log(`🔧 Creating session ${sessionId}`);
      console.log(`  Agent: ${options.agent}`);
      console.log(`  Model: ${provider}/${modelId}`);
    }

    // Load agent definition for system prompt
    const projectDir = this.config.directory || process.cwd();
    const agentDef = getAgent(projectDir, options.agent);
    let systemPrompt = '';
    if (agentDef) {
      systemPrompt = loadSystemPrompt(agentDef.path);
    }

    // Resolve the model
    let model;
    try {
      model = getModel(provider as any, modelId as any);
    } catch {
      throw new Error(
        `Failed to resolve model "${provider}/${modelId}". Check your model configuration.`
      );
    }

    // Create the agent
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [writeJsonOutputTool],
      },
    });

    // Store session
    this.sessions.set(sessionId, {
      id: sessionId,
      agent,
      agentName: options.agent,
    });

    // Send the initial prompt (don't await — we'll collect via streamMessages)
    // Attach a no-op catch to prevent unhandled promise rejection if the prompt
    // fails before streamMessages is called (e.g., missing API key).
    const promptPromise = agent.prompt(options.message);
    let promptError: Error | null = null;
    let promptErrorCallback: (() => void) | null = null;
    promptPromise.catch((err) => {
      promptError = err instanceof Error ? err : new Error(String(err));
      promptErrorCallback?.();
    });

    // Store the promise and error ref so streamMessages can access them
    const sessionEntry = this.sessions.get(sessionId) as any;
    sessionEntry._promptPromise = promptPromise;
    sessionEntry._getPromptError = () => promptError;
    sessionEntry._setPromptErrorCallback = (cb: () => void) => {
      promptErrorCallback = cb;
    };

    return {
      id: sessionId,
      agent: options.agent,
      createdAt: new Date(),
    };
  }

  /**
   * Stream messages from a session.
   * Subscribes to agent events and yields messages as they complete.
   */
  async *streamMessages(sessionId: string): AsyncGenerator<SessionMessage> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const { agent } = session;
    const promptPromise = (session as any)._promptPromise as Promise<void>;
    const getPromptError = (session as any)._getPromptError as () => Error | null;
    const setPromptErrorCallback = (session as any)._setPromptErrorCallback as (
      cb: () => void
    ) => void;

    // Collect messages via events
    const pendingMessages: SessionMessage[] = [];
    let resolveWaiting: (() => void) | null = null;
    let done = false;
    let msgCounter = 0;

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_end') {
        const msg = event.message;
        let role: SessionMessage['role'] = 'assistant';
        let content = '';

        if (msg.role === 'assistant') {
          role = 'assistant';
          // Extract text content from assistant message
          if (Array.isArray(msg.content)) {
            content = msg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text || '')
              .join('');
          } else if (typeof msg.content === 'string') {
            content = msg.content;
          }
        } else if (msg.role === 'user') {
          role = 'user';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text || '')
              .join('');
          }
        }

        if (content) {
          pendingMessages.push({
            id: `msg-${++msgCounter}`,
            role,
            content,
            timestamp: new Date(),
          });
          resolveWaiting?.();
        }
      }

      if (event.type === 'tool_execution_end') {
        // Yield tool results so review-core.ts can see them
        let content = '';
        const result = event.result;
        if (result && typeof result === 'object' && Array.isArray(result.content)) {
          content = result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text || '')
            .join('');
        } else if (typeof result === 'string') {
          content = result;
        }

        if (content) {
          pendingMessages.push({
            id: `msg-${++msgCounter}`,
            role: 'tool',
            content,
            timestamp: new Date(),
          });
          resolveWaiting?.();
        }
      }

      if (event.type === 'agent_end') {
        done = true;
        resolveWaiting?.();
      }
    });

    try {
      // Yield messages as they come in
      while (true) {
        // Check if the prompt errored (e.g., missing API key)
        const promptErr = getPromptError();
        if (promptErr) {
          throw promptErr;
        }

        if (pendingMessages.length > 0) {
          yield pendingMessages.shift()!;
          continue;
        }

        if (done) {
          break;
        }

        // Wait for next message, completion, or prompt error
        await new Promise<void>((resolve) => {
          resolveWaiting = resolve;
          setPromptErrorCallback(resolve);
        });
      }

      // Yield any remaining messages
      while (pendingMessages.length > 0) {
        yield pendingMessages.shift()!;
      }

      // Make sure the prompt has completed (re-throws if it failed)
      await promptPromise.catch(() => {
        // Already handled via getPromptError above; if we get here
        // and there's an error, throw it now
        const err = getPromptError();
        if (err) throw err;
      });
    } finally {
      unsubscribe();
    }
  }

  /**
   * Wait for session to complete and return all messages
   */
  async waitForCompletion(sessionId: string): Promise<SessionMessage[]> {
    const messages: SessionMessage[] = [];
    for await (const message of this.streamMessages(sessionId)) {
      messages.push(message);
    }
    return messages;
  }

  /**
   * Close a session - clean up the agent
   */
  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /**
   * Shutdown - clean up all sessions
   */
  async shutdown(): Promise<void> {
    this.sessions.clear();
  }
}

/**
 * Create and initialize a Pi client with the given configuration
 */
export async function createPiClientInstance(config: PiClientConfig): Promise<PiClient> {
  const client = new PiClient(config);
  await client.initialize();
  return client;
}
