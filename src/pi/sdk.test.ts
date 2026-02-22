import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiInProcessServer, createPiRemoteClient } from './sdk.js';

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(async () => ({
    server: {
      url: 'http://localhost:3000',
      close: vi.fn(),
    },
    client: {
      session: {
        create: vi.fn(),
      },
    },
  })),
  createOpencodeClient: vi.fn((options: { baseUrl: string }) => ({
    session: {
      baseUrl: options.baseUrl,
    },
  })),
}));

describe('pi/sdk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates in-process server through SDK adapter', async () => {
    const { createOpencode } = await import('@opencode-ai/sdk');

    const server = await createPiInProcessServer({
      timeout: 10000,
      config: {
        tools: {
          Read: true,
        },
      },
    });

    expect(createOpencode).toHaveBeenCalledWith({
      timeout: 10000,
      config: {
        tools: {
          Read: true,
        },
      },
    });
    expect(server.server.url).toBe('http://localhost:3000');
    expect(server.client).toBeDefined();
  });

  it('creates remote client through SDK adapter', async () => {
    const { createOpencodeClient } = await import('@opencode-ai/sdk');

    const client = createPiRemoteClient({
      baseUrl: 'http://localhost:4000',
    });

    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:4000',
    });
    expect(client.session).toBeDefined();
  });

  it('propagates SDK startup errors', async () => {
    const { createOpencode } = await import('@opencode-ai/sdk');

    vi.mocked(createOpencode).mockRejectedValueOnce(new Error('pi startup failed'));

    await expect(
      createPiInProcessServer({
        timeout: 10000,
        config: {},
      })
    ).rejects.toThrow('pi startup failed');
  });
});
