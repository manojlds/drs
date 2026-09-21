import { describe, expect, it, vi } from 'vitest';
import {
  JEV_API_ENDPOINT,
  JEV_MODEL,
  JevClient,
  JevClientError,
  createJevClientFromEnvironment,
} from './client.js';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(
  status: number,
  body: unknown = {},
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function validBody() {
  return {
    model: JEV_MODEL,
    answers: {
      correctness_applicable: { type: 'noul', noul: 1 },
    },
    usage: { input_tokens: 10, output_tokens: 3 },
  };
}

describe('JevClient', () => {
  it('pins the benchmarked Jev model version', () => {
    expect(JEV_MODEL).toBe('jev-1.13.0');
  });

  it('sends the expected request shape and isolates the bearer key to Authorization', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        okResponse(validBody())
    );
    const client = new JevClient({
      apiKey: 'secret-key',
      fetch,
      sleep: async () => {},
    });

    await client.evaluate({ task: 'review', diff: 'abc' }, {});

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(JEV_API_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer secret-key',
      'Content-Type': 'application/json',
    });
    expect(typeof init?.body).toBe('string');
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('Expected JSON request body');
    expect(body).not.toContain('secret-key');
    expect(JSON.parse(body)).toMatchObject({
      state: { task: 'review', diff: 'abc' },
      model: JEV_MODEL,
    });
  });

  it('retries retryable statuses with Retry-After support', async () => {
    const sleeps: number[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(errorResponse(529))
      .mockResolvedValueOnce(okResponse(validBody()));
    const client = new JevClient({
      apiKey: 'secret-key',
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 2,
    });

    await expect(client.evaluate({}, {})).resolves.toMatchObject({ model: JEV_MODEL });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 500]);
  });

  it('reports timeout with a stable code', async () => {
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    );
    const client = new JevClient({
      apiKey: 'secret-key',
      fetch,
      timeoutMs: 1,
      sleep: async () => {},
    });

    await expect(client.evaluate({}, {})).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects malformed responses', async () => {
    const client = new JevClient({
      apiKey: 'secret-key',
      fetch: vi.fn(async () => okResponse({ model: JEV_MODEL, answers: {} })),
      sleep: async () => {},
    });

    await expect(client.evaluate({}, {})).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps token limit and rejected key errors without leaking bodies or keys', async () => {
    const tokenClient = new JevClient({
      apiKey: 'secret-key',
      fetch: vi.fn(async () =>
        errorResponse(400, { detail: { error_type: 'max_tokens_exceeded', apiKey: 'secret-key' } })
      ),
      sleep: async () => {},
    });

    await expect(tokenClient.evaluate({}, {})).rejects.toMatchObject({
      code: 'token_limit',
    });
    await expect(tokenClient.evaluate({}, {})).rejects.not.toThrow('secret-key');

    const rejectedClient = new JevClient({
      apiKey: 'secret-key',
      fetch: vi.fn(async () => errorResponse(401, { error: 'secret-key' })),
      sleep: async () => {},
    });
    await expect(rejectedClient.evaluate({}, {})).rejects.toMatchObject({
      code: 'rejected_key',
    });
    await expect(rejectedClient.evaluate({}, {})).rejects.not.toThrow('secret-key');
  });

  it('reads JEV_API_KEY only when constructing from the environment', () => {
    const oldKey = process.env.JEV_API_KEY;
    delete process.env.JEV_API_KEY;
    try {
      expect(() => createJevClientFromEnvironment({ fetch: vi.fn() })).toThrow(JevClientError);
      expect(() => createJevClientFromEnvironment({ fetch: vi.fn() })).toThrow('JEV_API_KEY');
    } finally {
      if (oldKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = oldKey;
    }
  });

  it('maps network failures without including the key', async () => {
    const client = new JevClient({
      apiKey: 'secret-key',
      fetch: vi.fn(async () => {
        throw new Error('boom secret-key');
      }),
      sleep: async () => {},
    });

    await expect(client.evaluate({}, {})).rejects.toMatchObject({ code: 'network_failure' });
    await expect(client.evaluate({}, {})).rejects.not.toThrow('secret-key');
  });
});
