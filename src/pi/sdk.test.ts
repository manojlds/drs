import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiInProcessServer } from './sdk.js';

const mocks = vi.hoisted(() => {
  const prompt = vi.fn(async () => undefined);
  const dispose = vi.fn(() => undefined);
  const session = {
    prompt,
    dispose,
    messages: [] as unknown[],
  };

  return {
    prompt,
    dispose,
    session,
    createAgentSession: vi.fn(async () => ({ session })),
    loaderInstances: [] as Array<{ options: Record<string, unknown>; reload: any }>,
  };
});

vi.mock('@mariozechner/pi-coding-agent', () => {
  class DefaultResourceLoader {
    options: Record<string, unknown>;
    reload = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.loaderInstances.push({ options, reload: this.reload });
    }
  }

  class ModelRegistry {
    registerProvider = vi.fn(() => undefined);
    find = vi.fn(() => undefined);
  }

  return {
    AuthStorage: {
      create: vi.fn(() => ({})),
    },
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager: {
      inMemory: vi.fn(() => ({ type: 'memory' })),
    },
    createAgentSession: mocks.createAgentSession,
    createReadTool: vi.fn(() => ({ name: 'read' })),
    createBashTool: vi.fn(() => ({ name: 'bash' })),
    createEditTool: vi.fn(() => ({ name: 'edit' })),
    createWriteTool: vi.fn(() => ({ name: 'write' })),
    createGrepTool: vi.fn(() => ({ name: 'grep' })),
    createFindTool: vi.fn(() => ({ name: 'find' })),
    createLsTool: vi.fn(() => ({ name: 'ls' })),
  };
});

describe('pi/sdk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.messages = [];
    mocks.loaderInstances.length = 0;
  });

  it('creates in-process runtime client', async () => {
    const runtime = await createPiInProcessServer({
      timeout: 10000,
      config: {
        tools: {
          Read: true,
          Bash: true,
        },
      },
    });

    expect(runtime.server.url).toBe('pi://in-process');
    expect(runtime.client.session.create).toBeDefined();
    expect(runtime.client.session.prompt).toBeDefined();
    expect(runtime.client.session.messages).toBeDefined();

    runtime.server.close();
  });

  it('creates session, prompts with configured agent, and maps messages', async () => {
    const runtime = await createPiInProcessServer({
      timeout: 10000,
      config: {
        agent: {
          'review/security': {
            prompt: 'Security prompt',
          },
        },
      },
    });

    const created = await runtime.client.session.create({
      query: {
        directory: '/tmp/drs',
      },
    });

    const sessionId = created.data?.id;
    expect(sessionId).toBeTruthy();

    await runtime.client.session.prompt({
      path: { id: sessionId ?? '' },
      query: {
        directory: '/tmp/drs',
      },
      body: {
        agent: 'review/security',
        parts: [{ type: 'text', text: 'Review this diff' }],
      },
    });

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.loaderInstances).toHaveLength(1);

    const loaderOptions = mocks.loaderInstances[0].options;
    expect(typeof loaderOptions.systemPromptOverride).toBe('function');
    expect((loaderOptions.systemPromptOverride as () => string)()).toBe('Security prompt');

    expect(mocks.prompt).toHaveBeenCalledWith('Review this diff');

    mocks.session.messages = [
      {
        role: 'toolResult',
        toolName: 'read',
        toolCallId: 'tool-1',
        isError: false,
        timestamp: 1709999999000,
        content: [{ type: 'text', text: 'src/app.ts\n1: export const ok = true;' }],
      },
      {
        role: 'assistant',
        provider: 'opencode',
        model: 'glm-5-free',
        usage: {
          input: 42,
          output: 8,
          cacheRead: 3,
          cacheWrite: 0,
          totalTokens: 53,
          cost: { total: 0.0012 },
        },
        timestamp: 1710000000000,
        content: [{ type: 'text', text: 'done' }],
      },
    ];

    const response = await runtime.client.session.messages({
      path: { id: sessionId ?? '' },
    });

    expect(response.data).toEqual([
      {
        info: {
          id: `${sessionId}-0`,
          role: 'tool',
          time: { completed: 1709999999000 },
          error: undefined,
          toolName: 'read',
          toolCallId: 'tool-1',
        },
        parts: [{ text: 'src/app.ts\n1: export const ok = true;' }],
      },
      {
        info: {
          id: `${sessionId}-1`,
          role: 'assistant',
          time: { completed: 1710000000000 },
          error: undefined,
          provider: 'opencode',
          model: 'glm-5-free',
          usage: {
            input: 42,
            output: 8,
            cacheRead: 3,
            cacheWrite: 0,
            totalTokens: 53,
            cost: { total: 0.0012 },
          },
        },
        parts: [{ text: 'done' }],
      },
    ]);
  });
});
