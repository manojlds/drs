import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { createPiInProcessServer } from './sdk.js';

const execFileAsync = promisify(execFile);

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
    availableSkills: [] as string[],
    loaderInstances: [] as Array<{
      options: Record<string, unknown>;
      reload: any;
      getSkills: any;
    }>,
    modelRegistryInstances: [] as Array<{ registerProvider: any }>,
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => {
  class DefaultResourceLoader {
    options: Record<string, unknown>;
    reload = vi.fn(async () => undefined);
    getSkills = vi.fn(() => ({
      skills: mocks.availableSkills.map((name) => ({ name })),
      diagnostics: [],
    }));

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

    static create() {
      return new ModelRegistry();
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
    SettingsManager: {
      inMemory: vi.fn((settings?: Record<string, unknown>) => ({
        type: 'settings-memory',
        settings,
      })),
    },
    createAgentSession: mocks.createAgentSession,
    getAgentDir: vi.fn(() => '/tmp/.pi/agent'),
  };
});

describe('pi/sdk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.messages = [];
    mocks.availableSkills.length = 0;
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

  it('registers models.json-style provider config and merges provider compat into models', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        provider: {
          opencode: {
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'TEST_API_KEY',
            api: 'openai-completions',
            compat: {
              supportsStore: false,
              supportsUsageInStreaming: false,
            },
            models: [
              {
                id: 'glm-5-free',
                name: 'GLM 5 Free',
                cost: {
                  input: 1,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 64000,
                maxTokens: 8192,
                compat: {
                  supportsStore: true,
                  maxTokensField: 'max_tokens',
                },
              },
            ],
          },
        },
      },
    });

    expect(mocks.modelRegistryInstances).toHaveLength(1);
    const registerProvider = mocks.modelRegistryInstances[0].registerProvider;
    expect(registerProvider).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'TEST_API_KEY',
        api: 'openai-completions',
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
            compat: {
              supportsStore: true,
              supportsUsageInStreaming: false,
              maxTokensField: 'max_tokens',
            },
          }),
        ],
      })
    );

    runtime.server.close();
  });

  it('passes provider and model headers into registered provider config', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        provider: {
          custom: {
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'TEST_API_KEY',
            api: 'openai-completions',
            headers: {
              'X-Provider-Header': 'provider-value',
            },
            models: [
              {
                id: 'custom-model',
                name: 'Custom Model',
                headers: {
                  'X-Model-Header': 'model-value',
                },
              },
            ],
          },
        },
      },
    });

    expect(mocks.modelRegistryInstances).toHaveLength(1);
    const registerProvider = mocks.modelRegistryInstances[0].registerProvider;
    expect(registerProvider).toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({
        headers: {
          'X-Provider-Header': 'provider-value',
        },
        models: [
          expect.objectContaining({
            id: 'custom-model',
            headers: {
              'X-Model-Header': 'model-value',
            },
          }),
        ],
      })
    );

    runtime.server.close();
  });

  it('supports legacy provider config format for backward compatibility', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        provider: {
          legacy: {
            options: {
              baseURL: 'https://legacy.example.com/v1',
              apiKey: 'LEGACY_API_KEY',
            },
            models: {
              'legacy-model': {
                name: 'Legacy Model',
              },
            },
          },
        },
      },
    });

    expect(mocks.modelRegistryInstances).toHaveLength(1);
    const registerProvider = mocks.modelRegistryInstances[0].registerProvider;
    expect(registerProvider).toHaveBeenCalledWith(
      'legacy',
      expect.objectContaining({
        baseUrl: 'https://legacy.example.com/v1',
        apiKey: 'LEGACY_API_KEY',
        models: [expect.objectContaining({ id: 'legacy-model', name: 'Legacy Model' })],
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
      tools: string[];
    };
    const toolNames = sessionArgs.tools;

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
      tools: string[];
    };
    const toolNames = sessionArgs.tools;

    // Only globally enabled tools
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('edit');
    expect(toolNames).not.toContain('write');
    expect(toolNames).not.toContain('grep');

    runtime.server.close();
  });

  it('registers a scoped git_diff custom tool', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'drs-git-diff-'));
    try {
      await execFileAsync('git', ['init'], { cwd: workdir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workdir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workdir });
      await writeFile(join(workdir, 'app.ts'), 'export const value = 1;\n');
      await execFileAsync('git', ['add', 'app.ts'], { cwd: workdir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: workdir });
      await writeFile(join(workdir, 'app.ts'), 'export const value = 2;\n');

      const runtime = await createPiInProcessServer({
        config: {
          agent: {
            'review/unified-reviewer': {
              tools: { Bash: false, git_diff: true },
            },
          },
        },
      });
      const created = await runtime.client.session.create({ query: { directory: workdir } });

      await runtime.client.session.prompt({
        path: { id: created.data?.id ?? '' },
        query: { directory: workdir },
        body: {
          agent: 'review/unified-reviewer',
          parts: [{ type: 'text', text: 'Review' }],
        },
      });

      const createArgs = mocks.createAgentSession.mock.calls[0][0] as {
        customTools?: Array<{
          name: string;
          execute: (
            toolCallId: string,
            params: Record<string, unknown>
          ) => Promise<{ details?: Record<string, unknown> }>;
        }>;
      };
      const gitDiff = createArgs.customTools?.find((tool) => tool.name === 'git_diff');

      expect(gitDiff).toBeDefined();
      expect((createArgs as { tools?: string[] }).tools).toContain('write_json_output');
      expect((createArgs as { tools?: string[] }).tools).not.toContain('write_artifact_output');
      expect((createArgs as { tools?: string[] }).tools).toContain('git_diff');
      expect((createArgs as { tools?: string[] }).tools).not.toContain('bash');

      const result = await gitDiff?.execute('tool-1', { file: 'app.ts' });
      expect(result?.details?.file).toBe('app.ts');
      expect(result?.details?.ok).toBe(true);
      expect(String(result?.details?.diff)).toContain('-export const value = 1;');
      expect(String(result?.details?.diff)).toContain('+export const value = 2;');
      expect(result?.details?.metadata).toEqual(
        expect.objectContaining({ binary: false, deleted: false, renamed: false, empty: false })
      );

      const missingRef = await gitDiff?.execute('tool-missing-ref', {
        file: 'app.ts',
        base: 'missing-ref',
      });
      expect(missingRef?.details?.ok).toBe(false);
      expect(String(missingRef?.details?.error)).toContain('missing-ref');

      await writeFile(join(workdir, 'deleted.ts'), 'remove me\n');
      await execFileAsync('git', ['add', 'deleted.ts'], { cwd: workdir });
      await execFileAsync('git', ['commit', '-m', 'add deleted file'], { cwd: workdir });
      await unlink(join(workdir, 'deleted.ts'));
      const deleted = await gitDiff?.execute('tool-deleted', { file: 'deleted.ts' });
      expect(deleted?.details?.metadata).toEqual(expect.objectContaining({ deleted: true }));
      await execFileAsync('git', ['add', '-A'], { cwd: workdir });
      await execFileAsync('git', ['commit', '-m', 'delete file'], { cwd: workdir });

      await writeFile(join(workdir, 'renamed-old.ts'), 'rename me\n');
      await execFileAsync('git', ['add', 'renamed-old.ts'], { cwd: workdir });
      await execFileAsync('git', ['commit', '-m', 'add renamed file'], { cwd: workdir });
      const renameBase = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workdir })
      ).stdout.trim();
      await execFileAsync('git', ['mv', 'renamed-old.ts', 'renamed-new.ts'], { cwd: workdir });
      await execFileAsync('git', ['commit', '-m', 'rename file'], { cwd: workdir });
      const renameHead = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workdir })
      ).stdout.trim();
      const renamed = await gitDiff?.execute('tool-renamed', {
        file: 'renamed-new.ts',
        base: renameBase,
        head: renameHead,
      });
      expect(renamed?.details?.metadata).toEqual(
        expect.objectContaining({
          renamed: true,
          oldPath: 'renamed-old.ts',
          newPath: 'renamed-new.ts',
        })
      );

      await writeFile(join(workdir, 'app.ts'), `${'y'.repeat(1_000)}\n`);
      const truncated = await gitDiff?.execute('tool-2', { file: 'app.ts', maxBytes: 80 });
      expect(truncated?.details?.truncated).toBe(true);

      await writeFile(join(workdir, 'app.ts'), `${'x'.repeat(650_000)}\n`);
      const largeResult = await gitDiff?.execute('tool-large', { file: 'app.ts' });
      expect(largeResult?.details?.truncated).toBe(true);
      expect(largeResult?.details?.bytes).toBeLessThanOrEqual(120_000);

      await expect(gitDiff?.execute('tool-3', { file: '../app.ts' })).rejects.toThrow(
        'must stay inside the repository'
      );

      runtime.server.close();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('registers write_artifact_output and writes validated HTML artifacts', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'drs-artifact-tool-'));
    try {
      const runtime = await createPiInProcessServer({
        config: {
          agent: {
            'visual/pr-explainer': {
              tools: { Bash: false, write_artifact_output: true },
            },
          },
        },
      });
      const created = await runtime.client.session.create({ query: { directory: workdir } });

      await runtime.client.session.prompt({
        path: { id: created.data?.id ?? '' },
        query: { directory: workdir },
        body: {
          agent: 'visual/pr-explainer',
          parts: [{ type: 'text', text: 'Generate visual' }],
        },
      });

      const createArgs = mocks.createAgentSession.mock.calls[0][0] as {
        customTools?: Array<{
          name: string;
          execute: (
            toolCallId: string,
            params: Record<string, unknown>
          ) => Promise<{ details?: Record<string, unknown> }>;
        }>;
        tools?: string[];
      };
      const artifactTool = createArgs.customTools?.find(
        (tool) => tool.name === 'write_artifact_output'
      );

      expect(artifactTool).toBeDefined();
      expect(createArgs.tools).toContain('write_artifact_output');

      const result = await artifactTool?.execute('tool-artifact', {
        outputPath: '.drs/visual.html',
        content: 'thinking\n<!DOCTYPE html><html><body>Visual</body></html>\ndone',
      });

      expect(result?.details).toEqual({
        outputType: 'artifact_output',
        outputPath: '.drs/visual.html',
      });
      await expect(readFile(join(workdir, '.drs/visual.html'), 'utf-8')).resolves.toBe(
        '<!DOCTYPE html><html><body>Visual</body></html>'
      );

      runtime.server.close();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('per-agent skills are filtered via skillsOverride', async () => {
    mocks.availableSkills.push('sql-injection', 'auth-bypass', 'performance-hints');

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

  it('returns an error when configured skills are missing', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        agentSkills: {
          'review/security': ['sql-injection'],
        },
      },
    });

    const created = await runtime.client.session.create({
      query: { directory: '/tmp/drs' },
    });

    const promptResult = await runtime.client.session.prompt({
      path: { id: created.data?.id ?? '' },
      query: { directory: '/tmp/drs' },
      body: {
        agent: 'review/security',
        parts: [{ type: 'text', text: 'Review' }],
      },
    });

    expect(promptResult).toEqual({ ok: false });

    const response = await runtime.client.session.messages({
      path: { id: created.data?.id ?? '' },
    });

    const errorMessage = response.data?.find((message) => message.info?.error)?.info?.error;
    expect(String(errorMessage)).toContain(
      'Missing skill definitions for review/security: sql-injection'
    );
    expect(String(errorMessage)).toContain('Checked skill search paths:');

    runtime.server.close();
  });

  it('passes provider retry settings to Pi SettingsManager when configured', async () => {
    const runtime = await createPiInProcessServer({
      config: {
        retry: {
          provider: {
            timeoutMs: 45000,
            maxRetries: 2,
            maxRetryDelayMs: 15000,
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

    const createArgs = mocks.createAgentSession.mock.calls[0][0] as {
      settingsManager?: {
        settings?: Record<string, unknown>;
      };
    };

    expect(createArgs.settingsManager).toBeDefined();
    expect(createArgs.settingsManager?.settings).toEqual({
      retry: {
        provider: {
          timeoutMs: 45000,
          maxRetries: 2,
          maxRetryDelayMs: 15000,
        },
      },
    });

    runtime.server.close();
  });
});
