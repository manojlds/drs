/**
 * OpenCode SDK client wrapper for DRS with in-process server support
 *
 * This client can either:
 * 1. Connect to an existing remote OpenCode server (when baseUrl is provided)
 * 2. Start an OpenCode server in-process (when baseUrl is not provided)
 */

import { createOpencode, createOpencodeClient as createSDKClient } from '@opencode-ai/sdk';
import net from 'net';
import type { CustomProvider } from '../lib/config.js';

export interface OpencodeConfig {
  baseUrl?: string; // Optional - will start in-process if not provided
  directory?: string;
  serverPort?: number;
  serverHostname?: string;
  modelOverrides?: Record<string, string>; // Model overrides from DRS config
  provider?: Record<string, CustomProvider>; // Custom provider config from DRS config
  debug?: boolean; // Print OpenCode config for debugging
}

export interface SessionCreateOptions {
  agent: string;
  message: string;
  context?: Record<string, any>;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface Session {
  id: string;
  agent: string;
  createdAt: Date;
}

/**
 * OpenCode client that can start a server in-process or connect to remote
 */
export class OpencodeClient {
  private baseUrl?: string;
  private directory?: string;
  private inProcessServer?: Awaited<ReturnType<typeof createOpencode>>;
  private client?: ReturnType<typeof createSDKClient>;
  private config: OpencodeConfig;

  constructor(config: OpencodeConfig) {
    this.baseUrl = config.baseUrl;
    this.directory = config.directory;
    this.config = config;
  }

  /**
   * Initialize - either connect to remote server or start in-process
   */
  async initialize(): Promise<void> {
    if (this.baseUrl) {
      // Connect to existing remote server
      this.client = createSDKClient({
        baseUrl: this.baseUrl,
      });
      console.log(`Connected to OpenCode server at ${this.baseUrl}`);
    } else {
      // Start server in-process
      // Build OpenCode config programmatically from DRS config

      const opencodeConfig: any = {
        // Tools available to DRS review agents
        tools: {
          Read: true,
          Glob: true,
          Grep: true,
          Bash: true,
          Write: false,
          Edit: false,
        },
      };

      // Add custom provider if configured in DRS config
      if (this.config.provider && Object.keys(this.config.provider).length > 0) {
        // Deep clone and resolve environment variable references
        opencodeConfig.provider = this.resolveEnvReferences(this.config.provider);
        const providerNames = Object.keys(this.config.provider);
        console.log(`📦 Custom provider configured: ${providerNames.join(', ')}`);
      }

      // Apply model overrides from DRS config
      if (this.config.modelOverrides && Object.keys(this.config.modelOverrides).length > 0) {
        opencodeConfig.agent = {};

        console.log('📋 Agent model configuration:');

        // Merge model overrides into agent configuration
        for (const [agentName, model] of Object.entries(this.config.modelOverrides)) {
          opencodeConfig.agent[agentName] = { model };
          console.log(`  • ${agentName}: ${model}`);
        }

        console.log('');
      }

      // Debug: Print final OpenCode config
      if (this.config.debug) {
        console.log('🔧 DEBUG: Final OpenCode configuration (after env resolution):');
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
        console.log('Config being passed to OpenCode:');
        console.log(JSON.stringify(sanitizedConfig, null, 2));
        console.log('─'.repeat(50));
        console.log('');
      }

      // Change to project directory so OpenCode can discover agents
      const originalCwd = process.cwd();
      const projectDir = this.directory || originalCwd;

      if (projectDir !== originalCwd) {
        process.chdir(projectDir);
      }

      const hostname = this.config.serverHostname || '127.0.0.1';
      const defaultPort = this.config.serverPort || 4096;

      const startServer = async (port: number) => {
        return await createOpencode({
          hostname,
          port,
          timeout: 10000,
          config: opencodeConfig,
        });
      };

      // OpenCode SDK reads provider-specific API keys from environment automatically
      // (ANTHROPIC_API_KEY, ZHIPU_API_KEY, OPENAI_API_KEY, etc.)
      try {
        this.inProcessServer = await startServer(defaultPort);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          message.includes('EADDRINUSE') ||
          message.includes('address already in use') ||
          message.includes(`Failed to start server on port ${defaultPort}`);

        if (!shouldRetry) {
          throw error;
        }

        const fallbackPort = await findAvailablePort(defaultPort + 1, 10);
        if (fallbackPort === null) {
          throw error;
        }

        console.warn(
          `⚠️  Port ${defaultPort} unavailable. Retrying OpenCode server on port ${fallbackPort}.`
        );
        this.inProcessServer = await startServer(fallbackPort);
      }

      // Restore original working directory
      if (projectDir !== originalCwd) {
        process.chdir(originalCwd);
      }

      this.client = this.inProcessServer.client;
      this.baseUrl = this.inProcessServer.server.url;
    }
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
      const createResponse: any = await this.client.session.create({
        query: {
          directory: this.directory,
        },
      });

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
      const message = error instanceof Error ? error.message : String(error);
      const connectionHint =
        message.includes('fetch failed') || message.includes('ECONNREFUSED')
          ? ` Check the OpenCode server URL (${this.baseUrl ?? 'in-process'}) and ensure it is reachable.`
          : '';

      throw new Error(`Failed to create session: ${message}${connectionHint}`);
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
        const messagesResponse: any = await this.client.session.messages({
          path: { id: sessionId },
        });

        const messages = messagesResponse.data || [];

        // Yield any new messages
        for (let i = lastMessageCount; i < messages.length; i++) {
          const msg = messages[i];
          yield {
            id: msg.info?.id || 'msg-' + Date.now(),
            role: (msg.info?.role || 'assistant') as 'user' | 'assistant' | 'system',
            content: msg.parts?.map((p: any) => p.text || '').join('') || '',
            timestamp: new Date(),
          };
        }

        lastMessageCount = messages.length;

        // Check if the last assistant message has completed
        const lastAssistantMsg = [...messages]
          .reverse()
          .find((m: any) => m.info?.role === 'assistant');

        if (lastAssistantMsg) {
          const isComplete = lastAssistantMsg.info?.time?.completed !== undefined;
          const hasError = lastAssistantMsg.info?.error !== undefined;

          if (hasError) {
            throw new Error(`Agent error: ${JSON.stringify(lastAssistantMsg.info.error)}`);
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
      throw new Error(
        `Failed to get messages: ${error instanceof Error ? error.message : String(error)}`
      );
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
      // Send message using OpenCode SDK
      await (this.client as any).session.sendMessage({
        path: { id: sessionId },
        body: { content },
      });
    } catch (error) {
      throw new Error(
        `Failed to send message: ${error instanceof Error ? error.message : String(error)}`
      );
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
      throw new Error(
        `Failed to close session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Shutdown - close in-process server if applicable
   */
  async shutdown(): Promise<void> {
    if (this.inProcessServer) {
      // Close the OpenCode server
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
      const resolved: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveEnvReferences(value);
      }
      return resolved as T;
    }

    return obj;
  }
}

async function findAvailablePort(startPort: number, attempts: number): Promise<number | null> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  return null;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Create an OpenCode client with the given configuration
 * @deprecated Use createOpencodeClientInstance instead, which properly initializes the client
 */
export function createOpencodeClient(config: OpencodeConfig): OpencodeClient {
  return new OpencodeClient(config);
}

/**
 * Create and initialize an OpenCode client with the given configuration
 */
export async function createOpencodeClientInstance(
  config: OpencodeConfig
): Promise<OpencodeClient> {
  const client = new OpencodeClient(config);
  await client.initialize();
  return client;
}
