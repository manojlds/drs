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
    createAgentSession: vi.fn(async (_opts?: Record<string, unknown>) => ({ session })),
    loaderInstances: [] as Array<{
      options: Record<string, unknown>;
      reload: any;
      getSkills: any;
    }>,
    modelRegistryInstances: [] as Array<{ registerProvider: any }>,
  };
});

vi.mock('@mariozechner/pi-coding-agent', () => {
  class DefaultResourceLoader {
    options: Record<string, unknown>;
    reload = vi.fn(async () => undefined);
    getSkills = vi.fn(() => ({ skills: [], diagnostics: [] }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.loaderInstances.push({ options, reload: this.reload, getSkills: this.getSkills });
    }
  }

  class ModelRegistry {
    registerProvider = vi.fn(() => undefined);
    find = vi.fn(() => undefined);

    constructor() {
      mocks.modelRegistryInstances.push({ registerProvider: this.registerProvider });
    }
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
    mocks.modelRegistryInstances.length = 0;
  });

  it('creates in-process runtime client', async () => {
    const runtime = await createPiInProcessServer({
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

  it('registers custom provider model cost metadata when configured', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        provider: {
          opencode: {
            options: {
              baseURL: 'https://api.example.com/v1',
              apiKey: 'secret',
            },
            models: {
              'glm-5-free': {
                name: 'GLM 5 Free',
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 64000,
                maxTokens: 8192,
              },
            },
          },
        },
      },
    });

    expect(mocks.modelRegistryInstances).toHaveLength(1);
    const registerProvider = mocks.modelRegistryInstances[0].registerProvider;
    expect(registerProvider).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        models: [
          expect.objectContaining({
            id: 'glm-5-free',
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: 64000,
            maxTokens: 8192,
          }),
        ],
      })
    );

    runtime.server.close();
  });

  it('creates session, prompts with configured agent, and maps messages', async () => {
    const runtime = await createPiInProcessServer({
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

  it('per-agent tool overrides are applied to session creation', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        tools: {
          Read: true,
          Bash: true,
          Edit: false,
          Write: false,
          Grep: true,
          Glob: true,
        },
        agent: {
          'review/security': {
            prompt: 'Security prompt',
            tools: { Edit: true, Bash: false },
          },
        },
      },
    });

    const created = await runtime.client.session.create({
      query: { directory: '/tmp/drs' },
    });

    await runtime.client.session.prompt({
      path: { id: created.data?.id ?? '' },
      query: { directory: '/tmp/drs' },
      body: {
        agent: 'review/security',
        parts: [{ type: 'text', text: 'Review' }],
      },
    });

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);

    const sessionArgs = mocks.createAgentSession.mock.calls[0][0] as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = sessionArgs.tools.map((t: { name: string }) => t.name);

    // Per-agent override: Edit=true (overrides global false), Bash=false (overrides global true)
    expect(toolNames).toContain('read'); // global: true, no override
    expect(toolNames).toContain('edit'); // global: false, agent override: true
    expect(toolNames).not.toContain('bash'); // global: true, agent override: false
    expect(toolNames).toContain('grep'); // global: true, no override

    runtime.server.close();
  });

  it('agents without tool overrides use global tool config', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        tools: {
          Read: true,
          Bash: true,
          Edit: false,
          Write: false,
          Grep: false,
          Glob: false,
        },
        agent: {
          'review/quality': {
            prompt: 'Quality prompt',
            // No tools override
          },
        },
      },
    });

    const created = await runtime.client.session.create({
      query: { directory: '/tmp/drs' },
    });

    await runtime.client.session.prompt({
      path: { id: created.data?.id ?? '' },
      query: { directory: '/tmp/drs' },
      body: {
        agent: 'review/quality',
        parts: [{ type: 'text', text: 'Review' }],
      },
    });

    const sessionArgs = mocks.createAgentSession.mock.calls[0][0] as unknown as {
      tools: Array<{ name: string }>;
    };
    const toolNames = sessionArgs.tools.map((t: { name: string }) => t.name);

    // Only globally enabled tools
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('edit');
    expect(toolNames).not.toContain('write');
    expect(toolNames).not.toContain('grep');

    runtime.server.close();
  });

  it('per-agent skills are filtered via skillsOverride', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        agentSkills: {
          'review/security': ['sql-injection', 'auth-bypass'],
        },
      },
    });

    const created = await runtime.client.session.create({
      query: { directory: '/tmp/drs' },
    });

    await runtime.client.session.prompt({
      path: { id: created.data?.id ?? '' },
      query: { directory: '/tmp/drs' },
      body: {
        agent: 'review/security',
        parts: [{ type: 'text', text: 'Review' }],
      },
    });

    // The agent session creates its own DefaultResourceLoader
    const agentLoader = mocks.loaderInstances[mocks.loaderInstances.length - 1];
    expect(agentLoader.options.noSkills).toBe(true);

    // skillsOverride should be a function that filters to configured skills
    const skillsOverride = agentLoader.options.skillsOverride as (base: {
      skills: Array<{ name: string }>;
      diagnostics: unknown[];
    }) => { skills: Array<{ name: string }>; diagnostics: unknown[] };

    expect(typeof skillsOverride).toBe('function');

    const filtered = skillsOverride({
      skills: [{ name: 'sql-injection' }, { name: 'auth-bypass' }, { name: 'performance-hints' }],
      diagnostics: [],
    });

    expect(filtered.skills.map((s) => s.name)).toEqual(['sql-injection', 'auth-bypass']);
    // performance-hints filtered out — not in agent config

    runtime.server.close();
  });
});
