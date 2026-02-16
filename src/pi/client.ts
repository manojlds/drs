/**
 * Pi-mono Agent client wrapper for DRS
 *
 * Uses @mariozechner/pi-agent-core Agent class for direct in-process
 * agent execution. No HTTP server needed.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { getEnvApiKey } from '@mariozechner/pi-ai/dist/env-api-keys.js';
import { readTool, bashTool } from '@mariozechner/coding-agent';
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
  agent: Agent;
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
      const msg = event.message;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        if (msg.content.length === 0) {
          console.error(chalk.gray('│   📝 Assistant message: (empty content array)'));
        }
        for (const block of msg.content) {
          const blockType = (block as any).type;
          if (blockType === 'text') {
            const text = (block as any).text || '';
            const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
            console.error(chalk.gray('│   📝 Assistant text:'));
            for (const line of preview.split('\n')) {
              console.error(chalk.gray(`│     ${line}`));
            }
          } else if (blockType === 'toolCall') {
            const tc = block as any;
            console.error(chalk.magenta(`│   🔧 Tool call: ${tc.name} (id: ${tc.id})`));
            const argsStr = JSON.stringify(tc.arguments, null, 2);
            const argsPreview = argsStr.length > 1000 ? `${argsStr.slice(0, 1000)}…` : argsStr;
            for (const line of argsPreview.split('\n')) {
              console.error(chalk.gray(`│     ${line}`));
            }
          } else if (blockType === 'thinking') {
            const text = (block as any).thinking || '';
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

    // Build tool list: built-in coding tools + DRS write_json_output
    // The coding-agent tools use a different AgentTool type internally,
    // but are structurally compatible with pi-agent-core's AgentTool.
    const tools: AgentTool<any>[] = [
      readTool as unknown as AgentTool<any>,
      bashTool as unknown as AgentTool<any>,
      createWriteJsonOutputTool(projectDir),
    ];

    // Create the agent with API key resolution from environment variables
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
      },
      getApiKey: async (providerName: string) => {
        const key = getEnvApiKey(providerName);
        if (key) return key;
        // Fallback: the CI secret may still be named OPENCODE_ZEN_API_KEY
        if (providerName === 'opencode') {
          return process.env.OPENCODE_ZEN_API_KEY;
        }
        return undefined;
      },
    });

    // Store session (prompt is deferred to streamMessages)
    this.sessions.set(sessionId, {
      id: sessionId,
      agent,
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

    const { agent, agentName, _message: message } = session;
    const debugMode = this.config.debug;

    // Collect messages via events
    const pendingMessages: SessionMessage[] = [];
    let resolveWaiting: (() => void) | null = null;
    let done = false;
    let promptError: Error | null = null;
    let msgCounter = 0;

    // Subscribe to events BEFORE sending the prompt
    const unsubscribe = agent.subscribe((event) => {
      if (debugMode) {
        logAgentEvent(event, agentName);
      }

      if (event.type === 'message_end') {
        const msg = event.message;
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

    // pi-mono's agentLoop uses a fire-and-forget async IIFE internally.
    // If the LLM provider throws (e.g., missing API key), the error becomes
    // an unhandled rejection that crashes Node.js. We install a temporary
    // process handler to capture these errors gracefully.
    const unhandledHandler = (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      if (!promptError) {
        promptError = err;
        done = true;
        resolveWaiting?.();
      }
    };
    process.on('unhandledRejection', unhandledHandler);

    const promptPromise = agent.prompt(message).catch((err) => {
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
      process.removeListener('unhandledRejection', unhandledHandler);
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
