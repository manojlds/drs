import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';

export interface PiSessionPart {
  text?: string;
}

export interface PiSessionMessage {
  info?: {
    id?: string;
    role?: string;
    time?: { completed?: number };
    error?: unknown;
  };
  parts?: PiSessionPart[];
}

export interface PiSessionApi {
  create(input: { query: { directory?: string } }): Promise<{ data?: { id?: string } }>;
  prompt(input: {
    path: { id: string };
    query: { directory?: string };
    body: { agent: string; parts: Array<{ type: 'text'; text: string }> };
  }): Promise<unknown>;
  messages(input: { path: { id: string } }): Promise<{ data?: PiSessionMessage[] }>;
  delete(input: { path: { id: string } }): Promise<unknown>;
  sendMessage?(input: { path: { id: string }; body: { content: string } }): Promise<unknown>;
}

export interface PiClient {
  session: PiSessionApi;
}

export interface PiInProcessServer {
  server: {
    url: string;
    close: () => void;
  };
  client: PiClient;
}

/**
 * Temporary Pi SDK compatibility wrapper.
 *
 * This module isolates SDK-specific imports/types so higher-level orchestration
 * code can stay stable during migration.
 */
export async function createPiInProcessServer(options: {
  timeout: number;
  config: Record<string, unknown>;
}): Promise<PiInProcessServer> {
  return (await createOpencode(options)) as unknown as PiInProcessServer;
}

export function createPiRemoteClient(options: { baseUrl: string }): PiClient {
  return createOpencodeClient(options) as unknown as PiClient;
}
