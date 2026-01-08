/**
 * OpenCode SDK client wrapper for DRS
 *
 * Note: This is a placeholder implementation as @opencode-ai/sdk is still in development.
 * The actual implementation will use the OpenCode SDK once it's available.
 *
 * For now, this provides the interface that we'll implement against.
 */

export interface OpencodeConfig {
  baseUrl: string;
  directory?: string;
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
 * OpenCode client for interacting with OpenCode server
 */
export class OpencodeClient {
  private baseUrl: string;
  private directory?: string;

  constructor(config: OpencodeConfig) {
    this.baseUrl = config.baseUrl;
    this.directory = config.directory;
  }

  /**
   * Create a new session with an agent
   */
  async createSession(options: SessionCreateOptions): Promise<Session> {
    // TODO: Implement actual OpenCode SDK call
    // This is a placeholder that will be replaced with:
    // const session = await opencode.session.create(options)

    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent: options.agent,
        message: options.message,
        directory: this.directory,
        context: options.context,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      agent: data.agent,
      createdAt: new Date(data.createdAt),
    };
  }

  /**
   * Stream messages from a session
   */
  async *streamMessages(sessionId: string): AsyncGenerator<SessionMessage> {
    // TODO: Implement actual OpenCode SDK call with streaming
    // This is a placeholder that will be replaced with:
    // for await (const message of opencode.session.messages(sessionId))

    const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`);

    if (!response.ok) {
      throw new Error(`Failed to get messages: ${response.statusText}`);
    }

    const data = await response.json();

    for (const msg of data.messages) {
      yield {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
      };
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
    const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Failed to close session: ${response.statusText}`);
    }
  }
}

/**
 * Create an OpenCode client with the given configuration
 */
export function createOpencodeClient(config: OpencodeConfig): OpencodeClient {
  return new OpencodeClient(config);
}
