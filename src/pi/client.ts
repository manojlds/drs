/**
 * Pi-mono Agent client wrapper for DRS
 *
 * Uses @mariozechner/pi-coding-agent SDK (createAgentSession) for
 * in-process agent execution. No HTTP server needed.
 */

import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { getEnvApiKey } from '@mariozechner/pi-ai/dist/env-api-keys.js';
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  readTool,
  bashTool,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import type { DRSConfig } from '../lib/config.js';
import { createWriteJsonOutputTool } from './tools/write-json-output.js';
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
  agentSession: AgentSession;
  agentName: string;
  _message: string;
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
 * Log agent events in debug mode for full visibility into agent turns,
 * tool calls, and responses.
 */
function logAgentEvent(event: AgentEvent, agentName: string): void {
  switch (event.type) {
    case 'agent_start':
      console.error(chalk.gray(`\n┌── 🚀 Agent started: ${agentName}`));
      break;
    case 'turn_start':
      console.error(chalk.gray('│'));
      console.error(chalk.gray('├── 🔄 New turn'));
      break;
    case 'message_start':
      console.error(chalk.gray(`├── 💬 Message start [${event.message.role}]`));
      break;
    case 'message_end': {
      const msg = event.message as any;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        if (msg.content.length === 0) {
          console.error(chalk.gray('│   📝 Assistant message: (empty content array)'));
        }
        for (const block of msg.content) {
          const blockType = block.type;
          if (blockType === 'text') {
            const text = block.text || '';
            const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
            console.error(chalk.gray('│   📝 Assistant text:'));
            for (const line of preview.split('\n')) {
              console.error(chalk.gray(`│     ${line}`));
            }
          } else if (blockType === 'toolCall') {
            const tc = block;
            console.error(chalk.magenta(`│   🔧 Tool call: ${tc.name} (id: ${tc.id})`));
            const argsStr = JSON.stringify(tc.arguments, null, 2);
            const argsPreview = argsStr.length > 1000 ? `${argsStr.slice(0, 1000)}…` : argsStr;
            for (const line of argsPreview.split('\n')) {
              console.error(chalk.gray(`│     ${line}`));
            }
          } else if (blockType === 'thinking') {
            const text = block.thinking || '';
            const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
            console.error(chalk.gray('│   🧠 Thinking:'));
            for (const line of preview.split('\n')) {
              console.error(chalk.gray(`│     ${line}`));
            }
          } else {
            console.error(
              chalk.gray(`│   📦 Block type="${blockType}": ${JSON.stringify(block).slice(0, 300)}`)
            );
          }
        }
      } else {
        const contentStr =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const preview = contentStr.length > 500 ? `${contentStr.slice(0, 500)}…` : contentStr;
        console.error(chalk.gray(`│   Message end [${msg.role}]: ${preview || '(empty)'}`));
      }
      break;
    }
    case 'tool_execution_start':
      console.error(
        chalk.magenta(`├── ⚙️  Tool executing: ${event.toolName} (id: ${event.toolCallId})`)
      );
      break;
    case 'tool_execution_end': {
      const status = event.isError ? chalk.red('❌ error') : chalk.green('✅ ok');
      console.error(chalk.gray(`├── Tool result [${event.toolName}]: ${status}`));
      let resultText = '';
      const r = event.result;
      if (r && typeof r === 'object' && Array.isArray(r.content)) {
        resultText = r.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text || '')
          .join('');
      } else if (typeof r === 'string') {
        resultText = r;
      }
      if (resultText) {
        const preview = resultText.length > 500 ? `${resultText.slice(0, 500)}…` : resultText;
        for (const line of preview.split('\n')) {
          console.error(chalk.gray(`│     ${line}`));
        }
      }
      break;
    }
    case 'turn_end':
      console.error(chalk.gray('├── 🏁 Turn end'));
      break;
    case 'agent_end':
      console.error(chalk.gray(`└── ✅ Agent finished: ${agentName}\n`));
      break;
  }
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
   * Create a session - creates an AgentSession via the SDK and sends the initial prompt
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

    if (this.config.debug) {
      console.log(chalk.gray('┌── DEBUG: System prompt'));
      console.log(chalk.gray(`│ Agent definition: ${agentDef?.path ?? 'not found'}`));
      console.log(chalk.gray('│ System prompt:'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log(systemPrompt || '(empty)');
      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.gray('└── End system prompt\n'));
      console.log(chalk.gray(`📨 User message (${options.message.length} chars):`));
      console.log(chalk.gray('─'.repeat(60)));
      const msgPreview =
        options.message.length > 2000
          ? `${options.message.slice(0, 2000)}\n… (${options.message.length} chars total)`
          : options.message;
      console.log(msgPreview);
      console.log(chalk.gray('─'.repeat(60)));
      console.log('');
    }

    // Resolve the model
    const model = getModel(provider as any, modelId as any);
    if (!model) {
      throw new Error(
        `Failed to resolve model "${provider}/${modelId}". Check your model configuration.`
      );
    }

    // Set up auth storage with API key from environment
    const authStorage = new AuthStorage();
    const envKey = getEnvApiKey(provider);
    if (envKey) authStorage.setRuntimeApiKey(provider, envKey);
    if (provider === 'opencode') {
      const zenKey = process.env.OPENCODE_ZEN_API_KEY;
      if (zenKey) authStorage.setRuntimeApiKey('opencode', zenKey);
    }

    const modelRegistry = new ModelRegistry(authStorage);

    // Create the agent session via the SDK
    const { session: agentSession } = await createAgentSession({
      model,
      thinkingLevel: 'off',
      tools: [readTool, bashTool],
      customTools: [createWriteJsonOutputTool(projectDir)],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      authStorage,
      modelRegistry,
    });

    // Set the system prompt from the agent definition
    agentSession.agent.setSystemPrompt(systemPrompt);

    // Store session (prompt is deferred to streamMessages)
    this.sessions.set(sessionId, {
      id: sessionId,
      agentSession,
      agentName: options.agent,
      _message: options.message,
    });

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

    const { agentSession, agentName, _message: message } = session;
    const debugMode = this.config.debug;

    // Collect messages via events
    const pendingMessages: SessionMessage[] = [];
    let resolveWaiting: (() => void) | null = null;
    let done = false;
    let promptError: Error | null = null;
    let msgCounter = 0;

    // Subscribe to events BEFORE sending the prompt
    const unsubscribe = agentSession.subscribe((event) => {
      // AgentSessionEvent is a superset of AgentEvent; filter to core events for logging
      if (debugMode && 'type' in event) {
        logAgentEvent(event as AgentEvent, agentName);
      }

      if (event.type === 'message_end') {
        const msg = (event as any).message;
        let role: SessionMessage['role'] = 'assistant';
        let content = '';

        if (msg.role === 'assistant') {
          role = 'assistant';
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
        let content = '';
        const result = (event as any).result;
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

    const promptPromise = agentSession
      .prompt(message, { expandPromptTemplates: false })
      .catch((err) => {
        promptError = err instanceof Error ? err : new Error(String(err));
        done = true;
        resolveWaiting?.();
      });

    try {
      while (true) {
        if (promptError) {
          throw promptError;
        }

        if (pendingMessages.length > 0) {
          yield pendingMessages.shift()!;
          continue;
        }

        if (done) {
          break;
        }

        await new Promise<void>((resolve) => {
          resolveWaiting = resolve;
        });
      }

      // Check for error one more time after loop exits
      if (promptError) {
        throw promptError;
      }

      // Yield any remaining messages
      while (pendingMessages.length > 0) {
        yield pendingMessages.shift()!;
      }

      await promptPromise;
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
   * Close a session - clean up the agent session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agentSession.dispose();
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Shutdown - clean up all sessions
   */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.agentSession.dispose();
    }
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
