/**
 * Agent runtime client wrapper for DRS with in-process server support.
 *
 * This client maintains the existing internal interface used by review orchestration
 * while delegating SDK calls through the Pi integration adapter in src/pi/sdk.ts.
 */

import type { CustomProvider, DRSConfig } from '../lib/config.js';
import { getDefaultSkills, normalizeAgentConfig } from '../lib/config.js';
import { loadReviewAgents } from './agent-loader.js';
import { resolveReviewPaths } from './path-config.js';
import { createPiInProcessServer, type PiClient, type PiSessionMessage } from '../pi/sdk.js';

export interface RuntimeClientConfig {
  /**
   * @deprecated DRS runs Pi in-process only. Providing a remote endpoint is unsupported.
   */
  baseUrl?: string;
  directory?: string;
  modelOverrides?: Record<string, string>; // Model overrides from DRS config
  provider?: Record<string, CustomProvider>; // Custom provider config from DRS config
  debug?: boolean; // Print runtime config for debugging
  config?: DRSConfig;
}

/**
 * @deprecated Use RuntimeClientConfig.
 */
export type OpencodeConfig = RuntimeClientConfig;

const SERVER_START_TIMEOUT_MS = 10000;

export interface SessionCreateOptions {
  agent: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolCallId?: string;
  provider?: string;
  model?: string;
  usage?: SessionUsage;
}

export interface Session {
  id: string;
  agent: string;
  createdAt: Date;
}

function mapPiRuntimeError(operation: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  const connectionError =
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('connection refused');

  if (connectionError) {
    return new Error(
      `Failed to ${operation}: ${message}. Verify local Pi runtime setup and model provider connectivity.`
    );
  }

  const authError =
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    normalized.includes('api key') ||
    normalized.includes('401');

  if (authError) {
    return new Error(
      `Failed to ${operation}: Authentication failed with the configured model provider. Verify API keys and provider settings. (Details: ${message})`
    );
  }

  const modelError =
    normalized.includes('failed to resolve model') ||
    (normalized.includes('model') && normalized.includes('not found'));

  if (modelError) {
    return new Error(
      `Failed to ${operation}: Model configuration is invalid or unavailable. Check configured provider/model names and overrides. (Details: ${message})`
    );
  }

  return new Error(`Failed to ${operation}: ${message}`);
}

/**
 * Runtime client wrapper for DRS backed by in-process Pi sessions.
 */
export class RuntimeClient {
  private baseUrl?: string;
  private directory?: string;
  private inProcessServer?: Awaited<ReturnType<typeof createPiInProcessServer>>;
  private client?: PiClient;
  private config: RuntimeClientConfig;

  constructor(config: RuntimeClientConfig) {
    this.baseUrl = config.baseUrl;
    this.directory = config.directory;
    this.config = config;
  }

  private getConfiguredModelPricing(provider?: string, model?: string) {
    const pricing = this.config.config?.pricing?.models;
    if (!pricing) {
      return undefined;
    }

    const fullModelId = provider && model ? `${provider}/${model}` : undefined;
    return (
      (fullModelId ? pricing[fullModelId] : undefined) ??
      (model ? pricing[model] : undefined) ??
      undefined
    );
  }

  private estimateConfiguredCost(
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    provider?: string,
    model?: string
  ): number | undefined {
    const pricing = this.getConfiguredModelPricing(provider, model);
    if (!pricing) {
      return undefined;
    }

    const inputCost = ((pricing.input ?? 0) / 1_000_000) * input;
    const outputCost = ((pricing.output ?? 0) / 1_000_000) * output;
    const cacheReadCost = ((pricing.cacheRead ?? 0) / 1_000_000) * cacheRead;
    const cacheWriteCost = ((pricing.cacheWrite ?? 0) / 1_000_000) * cacheWrite;

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  /**
   * Initialize in-process Pi runtime.
   */
  async initialize(): Promise<void> {
    if (this.baseUrl) {
      throw new Error(
        `Remote Pi runtime endpoints are not supported by DRS. Remove baseUrl/PI_SERVER/opencode.serverUrl (received: ${this.baseUrl}).`
      );
    }

    // Start server in-process
    // Build runtime config programmatically from DRS config
    const originalCwd = process.cwd();
    const projectDir = this.directory ?? originalCwd;
    const reviewPaths = resolveReviewPaths(projectDir, this.config.config);

    const opencodeConfig: Record<string, unknown> = {
      // Tools available to DRS review agents
      tools: {
        Read: true,
        Glob: true,
        Grep: true,
        Bash: true,
        write_json_output: true,
        skill: false,
        Write: false,
        Edit: false,
      },
    };

    const agentConfig: Record<string, Record<string, unknown>> = {};

    if (this.config.config) {
      const runtimeAgents = loadReviewAgents(projectDir, this.config.config);
      for (const agent of runtimeAgents) {
        const runtimeEntry: Record<string, unknown> = {};
        if (agent.model) runtimeEntry.model = agent.model;
        if (agent.prompt) runtimeEntry.prompt = agent.prompt;
        if (agent.description) runtimeEntry.description = agent.description;
        if (agent.color) runtimeEntry.color = agent.color;
        if (agent.tools) runtimeEntry.tools = agent.tools;

        if (Object.keys(runtimeEntry).length > 0) {
          agentConfig[agent.name] = runtimeEntry;
        }
      }

      if (runtimeAgents.length > 0) {
        console.log(`🧠 Loaded ${runtimeAgents.length} agent definitions for Pi runtime.`);
      }
    }

    // Set log level to DEBUG when --debug flag is used
    // This shows full system prompts, tools, and provider calls from Pi runtime.
    if (this.config.debug) {
      opencodeConfig.logLevel = 'DEBUG';
      console.log('🔍 Pi runtime debug logging enabled');
    }

    // Add custom provider if configured in DRS config
    if (this.config.provider && Object.keys(this.config.provider).length > 0) {
      // Deep clone and resolve environment variable references
      opencodeConfig.provider = this.resolveEnvReferences(this.config.provider);
      const providerNames = Object.keys(this.config.provider);
      console.log(`📦 Custom provider configured: ${providerNames.join(', ')}`);
    }

    // Apply model overrides from DRS config
    if (this.config.modelOverrides && Object.keys(this.config.modelOverrides).length > 0) {
      console.log('📋 Agent model configuration:');

      // Merge model overrides into agent configuration
      for (const [agentName, model] of Object.entries(this.config.modelOverrides)) {
        const entry = agentConfig[agentName] ?? {};
        agentConfig[agentName] = {
          ...entry,
          model,
        };
        console.log(`  • ${agentName}: ${model}`);
      }

      console.log('');
    }

    if (Object.keys(agentConfig).length > 0) {
      opencodeConfig.agent = agentConfig;
    }

    opencodeConfig.skillSearchPaths = reviewPaths.skillSearchPaths;

    if (this.config.config) {
      const normalizedAgents = normalizeAgentConfig(this.config.config.review.agents);
      const defaultSkills = getDefaultSkills(this.config.config);
      const agentSkills = normalizedAgents
        .map((agent) => {
          const combined = new Set([
            ...defaultSkills,
            ...(agent.skills ? agent.skills.map(String) : []),
          ]);
          const fullAgentName = agent.name.startsWith('review/')
            ? agent.name
            : `review/${agent.name}`;

          return {
            name: fullAgentName,
            skills: Array.from(combined).filter((skill) => skill.length > 0),
          };
        })
        .filter((agent) => agent.skills.length > 0);

      if (agentSkills.length > 0) {
        console.log('🧩 Agent skill configuration:');
        for (const agent of agentSkills) {
          console.log(`  • ${agent.name}: ${agent.skills.join(', ')}`);
        }
        console.log('');

        opencodeConfig.agentSkills = Object.fromEntries(
          agentSkills.map((agent) => [agent.name, agent.skills])
        );
      }
    }

    // Debug: Print final runtime config
    if (this.config.debug) {
      console.log('🔧 DEBUG: Final Pi runtime configuration (after env resolution):');
      console.log('─'.repeat(50));

      // Show environment variable status for custom providers
      if (this.config.provider) {
        console.log('\n📍 Environment variable status:');
        for (const [providerName, provider] of Object.entries(this.config.provider)) {
          const apiKeyConfig = provider.options?.apiKey;
          if (apiKeyConfig && typeof apiKeyConfig === 'string') {
            const envMatch = apiKeyConfig.match(/^\{env:([^}]+)\}$/);
            if (envMatch) {
              const envVarName = envMatch[1];
              const envValue = process.env[envVarName];
              if (envValue) {
                console.log(`  ✓ ${envVarName}: SET (${envValue.substring(0, 8)}...)`);
              } else {
                console.log(`  ✗ ${envVarName}: NOT SET`);
              }
            } else {
              console.log(`  • ${providerName}: API key is hardcoded (not env var)`);
            }
          }
        }
        console.log('');
      }

      // Sanitize config to hide API keys
      const sanitizedConfig = JSON.parse(JSON.stringify(opencodeConfig));
      if (sanitizedConfig.provider) {
        for (const providerName of Object.keys(sanitizedConfig.provider)) {
          if (sanitizedConfig.provider[providerName]?.options?.apiKey) {
            const apiKey = sanitizedConfig.provider[providerName].options.apiKey;
            // Always redact since we've resolved env vars
            if (apiKey && apiKey.length > 0) {
              sanitizedConfig.provider[providerName].options.apiKey =
                `***REDACTED (${apiKey.length} chars)***`;
            } else {
              sanitizedConfig.provider[providerName].options.apiKey = '***EMPTY***';
            }
          }
        }
      }

      if (sanitizedConfig.agent) {
        for (const agentName of Object.keys(sanitizedConfig.agent)) {
          const prompt = sanitizedConfig.agent[agentName]?.prompt;
          if (typeof prompt === 'string' && prompt.length > 0) {
            sanitizedConfig.agent[agentName].prompt = `***OMITTED (${prompt.length} chars)***`;
          }
        }
      }

      console.log('Config being passed to Pi runtime:');
      console.log(JSON.stringify(sanitizedConfig, null, 2));

      const configuredAgentSkills = opencodeConfig.agentSkills as
        | Record<string, string[]>
        | undefined;

      if (configuredAgentSkills && Object.keys(configuredAgentSkills).length > 0) {
        console.log('Agent skills configuration:');
        console.log(JSON.stringify(configuredAgentSkills, null, 2));
      }

      console.log('─'.repeat(50));
      console.log('');
    }

    // Change to project directory so the Pi runtime can resolve project-relative assets
    const discoveryRoot = projectDir;
    if (discoveryRoot !== originalCwd) {
      process.chdir(discoveryRoot);
    }

    // Pi SDK reads provider-specific API keys from environment automatically
    // (ANTHROPIC_API_KEY, ZHIPU_API_KEY, OPENAI_API_KEY, etc.)
    this.inProcessServer = await createPiInProcessServer({
      timeout: SERVER_START_TIMEOUT_MS,
      config: opencodeConfig,
    });

    // Restore original working directory
    if (discoveryRoot !== originalCwd) {
      process.chdir(originalCwd);
    }

    this.client = this.inProcessServer.client;
    this.baseUrl = this.inProcessServer.server.url;
  }

  /**
   * Create a new session with an agent and send initial message
   */
  async createSession(options: SessionCreateOptions): Promise<Session> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized. Call initialize() first.');
    }

    try {
      // Step 1: Create empty session
      const createResponse = (await this.client.session.create({
        query: {
          directory: this.directory,
        },
      })) as { data?: { id?: string } };

      const sessionId = createResponse.data?.id;
      if (!sessionId) {
        throw new Error('Failed to get session ID from create response');
      }

      // Step 2: Send initial message to start the agent
      await this.client.session.prompt({
        path: { id: sessionId },
        query: {
          directory: this.directory,
        },
        body: {
          agent: options.agent,
          parts: [
            {
              type: 'text',
              text: options.message,
            },
          ],
        },
      });

      return {
        id: sessionId,
        agent: options.agent,
        createdAt: new Date(),
      };
    } catch (error) {
      throw mapPiRuntimeError('create session', error);
    }
  }

  /**
   * Stream messages from a session (polls until agent completes)
   */
  async *streamMessages(sessionId: string): AsyncGenerator<SessionMessage> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized. Call initialize() first.');
    }

    try {
      // Poll messages until agent completes
      let lastMessageCount = 0;
      let attempts = 0;
      const maxAttempts = 60; // 60 attempts * 2s = 2 minutes max

      while (attempts < maxAttempts) {
        attempts++;

        // Get current messages
        const messagesResponse = (await this.client.session.messages({
          path: { id: sessionId },
        })) as { data?: PiSessionMessage[] };

        const messages = messagesResponse.data ?? [];

        // Yield any new messages
        for (let i = lastMessageCount; i < messages.length; i++) {
          const msg = messages[i];
          const provider = msg.info?.provider;
          const model = msg.info?.model;

          const mappedUsage = msg.info?.usage
            ? (() => {
                const input = msg.info?.usage?.input ?? 0;
                const output = msg.info?.usage?.output ?? 0;
                const cacheRead = msg.info?.usage?.cacheRead ?? 0;
                const cacheWrite = msg.info?.usage?.cacheWrite ?? 0;
                const totalTokens =
                  msg.info?.usage?.totalTokens ?? input + output + cacheRead + cacheWrite;
                const reportedCost = msg.info?.usage?.cost?.total;
                const configuredCost = this.estimateConfiguredCost(
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  provider,
                  model
                );
                const cost =
                  reportedCost !== undefined && reportedCost > 0
                    ? reportedCost
                    : (configuredCost ?? reportedCost ?? 0);

                return {
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  totalTokens,
                  cost,
                };
              })()
            : undefined;

          yield {
            id: msg.info?.id ?? 'msg-' + Date.now(),
            role: (msg.info?.role ?? 'assistant') as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.parts?.map((p) => p.text ?? '').join('') ?? '',
            timestamp: new Date(),
            toolName: msg.info?.toolName,
            toolCallId: msg.info?.toolCallId,
            provider,
            model,
            usage: mappedUsage,
          };
        }

        lastMessageCount = messages.length;

        // Check if the last assistant message has completed
        const lastAssistantMsg = [...messages].reverse().find((m) => m.info?.role === 'assistant');

        if (lastAssistantMsg) {
          const isComplete = lastAssistantMsg.info?.time?.completed !== undefined;
          const hasError = lastAssistantMsg.info?.error !== undefined;

          if (hasError) {
            throw new Error(`Agent error: ${JSON.stringify(lastAssistantMsg.info?.error)}`);
          }

          if (isComplete) {
            break;
          }
        }

        // Wait before polling again
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Session ${sessionId} timed out after ${maxAttempts * 2} seconds`);
      }
    } catch (error) {
      throw mapPiRuntimeError('get messages', error);
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
   * Send a message to an existing session
   */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized. Call initialize() first.');
    }

    try {
      const sessionWithSendMessage = this.client.session as PiClient['session'] & {
        sendMessage?: (args: {
          path: { id: string };
          body: { content: string };
        }) => Promise<unknown>;
      };

      if (!sessionWithSendMessage.sendMessage) {
        throw new Error('Pi runtime does not support follow-up messages for active sessions');
      }

      await sessionWithSendMessage.sendMessage({
        path: { id: sessionId },
        body: { content },
      });
    } catch (error) {
      throw mapPiRuntimeError('send message', error);
    }
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized. Call initialize() first.');
    }

    try {
      await this.client.session.delete({
        path: { id: sessionId },
      });
    } catch (error) {
      throw mapPiRuntimeError('close session', error);
    }
  }

  /**
   * Shutdown - close in-process server if applicable
   */
  async shutdown(): Promise<void> {
    if (this.inProcessServer) {
      // Close the in-process Pi runtime
      this.inProcessServer.server.close();
      // Give server time to clean up connections
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Get server URL
   */
  getServerUrl(): string {
    if (!this.baseUrl) {
      throw new Error('Server not initialized');
    }
    return this.baseUrl;
  }

  /**
   * Resolve {env:VAR_NAME} references to actual environment variable values
   */
  private resolveEnvReferences<T>(obj: T): T {
    if (typeof obj === 'string') {
      // Check for {env:VAR_NAME} pattern
      const envMatch = obj.match(/^\{env:([^}]+)\}$/);
      if (envMatch) {
        const envVarName = envMatch[1];
        const envValue = process.env[envVarName];
        if (!envValue) {
          console.warn(`⚠️  Environment variable ${envVarName} is not set`);
          return '' as T;
        }
        return envValue as T;
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.resolveEnvReferences(item)) as T;
    }

    if (obj !== null && typeof obj === 'object') {
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveEnvReferences(value);
      }
      return resolved as T;
    }

    return obj;
  }
}

/**
 * Create a runtime client with the given configuration.
 */
export function createRuntimeClient(config: RuntimeClientConfig): RuntimeClient {
  return new RuntimeClient(config);
}

/**
 * Create and initialize a runtime client with the given configuration.
 */
export async function createRuntimeClientInstance(
  config: RuntimeClientConfig
): Promise<RuntimeClient> {
  const client = new RuntimeClient(config);
  await client.initialize();
  return client;
}

/**
 * @deprecated Use RuntimeClient.
 */
export { RuntimeClient as OpencodeClient };

/**
 * @deprecated Use createRuntimeClient instead.
 */
export function createOpencodeClient(config: RuntimeClientConfig): RuntimeClient {
  return createRuntimeClient(config);
}

/**
 * @deprecated Use createRuntimeClientInstance instead.
 */
export async function createOpencodeClientInstance(
  config: RuntimeClientConfig
): Promise<RuntimeClient> {
  return createRuntimeClientInstance(config);
}
