/**
 * OpenCode SDK client wrapper for DRS with in-process server support
 *
 * This client can either:
 * 1. Connect to an existing remote OpenCode server (when baseUrl is provided)
 * 2. Start an OpenCode server in-process (when baseUrl is not provided)
 */

import { createOpencode, createOpencodeClient as createSDKClient } from '@opencode-ai/sdk';

export interface OpencodeConfig {
  baseUrl?: string; // Optional - will start in-process if not provided
  directory?: string;
  serverPort?: number;
  serverHostname?: string;
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
      console.log('Starting OpenCode server in-process...');

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required for in-process OpenCode server');
      }

      // OpenCode SDK reads ANTHROPIC_API_KEY from environment automatically
      this.inProcessServer = await createOpencode({
        hostname: this.config.serverHostname || '127.0.0.1',
        port: this.config.serverPort || 4096,
        timeout: 10000,
        config: {
          model: 'anthropic/claude-opus-4-20250514',
        },
      });

      this.client = this.inProcessServer.client;
      this.baseUrl = this.inProcessServer.server.url;
      console.log(`OpenCode server started at ${this.baseUrl}`);
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

      console.log(`Created session ${sessionId} in directory: ${this.directory || 'default'}`);

      // Step 2: Send initial message to start the agent
      console.log(`Attempting to invoke agent: ${options.agent}`);

      const promptResponse: any = await this.client.session.prompt({
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

      console.log(`Prompt response:`, JSON.stringify(promptResponse, null, 2));
      console.log(`Sent initial message to session ${sessionId} with agent ${options.agent}`);

      return {
        id: sessionId,
        agent: options.agent,
        createdAt: new Date(),
      };
    } catch (error) {
      throw new Error(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`
      );
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
        console.log(`Session ${sessionId}: ${messages.length} messages (attempt ${attempts})`);

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
        // Find the last assistant message (without mutating messages array)
        const lastAssistantMsg = [...messages].reverse().find((m: any) => m.info?.role === 'assistant');

        if (lastAssistantMsg) {
          const isComplete = lastAssistantMsg.info?.time?.completed !== undefined;
          const hasError = lastAssistantMsg.info?.error !== undefined;

          console.log(`Last assistant message: completed=${isComplete}, error=${hasError}`);

          if (hasError) {
            throw new Error(`Agent error: ${JSON.stringify(lastAssistantMsg.info.error)}`);
          }

          if (isComplete) {
            console.log(`Session ${sessionId} complete with ${messages.length} messages`);
            break;
          }
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (attempts >= maxAttempts) {
        console.warn(`Session ${sessionId} timeout after ${maxAttempts} attempts`);
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
      this.inProcessServer.server.close();
      console.log('OpenCode server stopped');
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
