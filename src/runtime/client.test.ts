import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeClient, createRuntimeClient, createRuntimeClientInstance } from './client.js';

function createRuntime(
  sessionOverrides: Partial<{
    create: (...args: any[]) => Promise<unknown>;
    prompt: (...args: any[]) => Promise<unknown>;
    messages: (...args: any[]) => Promise<unknown>;
    delete: (...args: any[]) => Promise<unknown>;
  }> = {}
) {
  return {
    server: {
      url: 'pi://in-process',
      close: vi.fn(),
    },
    client: {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-123' } })),
        prompt: vi.fn(async () => {}),
        messages: vi.fn(async () => ({ data: [] })),
        delete: vi.fn(async () => {}),
        ...sessionOverrides,
      },
    },
  };
}

const mocks = vi.hoisted(() => ({
  createPiInProcessServer: vi.fn(),
  loadReviewAgents: vi.fn(() => []),
}));

vi.mock('../pi/sdk.js', () => ({
  createPiInProcessServer: mocks.createPiInProcessServer,
}));

vi.mock('./agent-loader.js', () => ({
  loadReviewAgents: mocks.loadReviewAgents,
}));

describe('RuntimeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mocks.createPiInProcessServer.mockResolvedValue(createRuntime());
    mocks.loadReviewAgents.mockReturnValue([]);
  });

  describe('constructor', () => {
    it('creates an instance with minimal config', () => {
      const client = new RuntimeClient({
        directory: '/test/dir',
      });

      expect(client).toBeInstanceOf(RuntimeClient);
    });

    it('supports optional model overrides and provider config', () => {
      const client = new RuntimeClient({
        modelOverrides: {
          'review/security': 'anthropic/claude-opus-4-5-20251101',
        },
        provider: {
          custom: {
            npm: '@custom/provider',
            name: 'custom',
            models: { model: { name: 'model' } },
            options: {
              baseURL: 'https://api.custom.example',
              apiKey: '{env:CUSTOM_API_KEY}',
            } as any,
          },
        } as any,
      });

      expect(client).toBeInstanceOf(RuntimeClient);
    });
  });

  describe('initialize', () => {
    it('wires Pi runtime agent prompts and model overrides', async () => {
      mocks.loadReviewAgents.mockReturnValue([
        {
          name: 'review/security',
          path: '/tmp/security.md',
          description: 'Security specialist',
          prompt: 'Security prompt',
          tools: { Read: true },
        },
        {
          name: 'review/quality',
          path: '/tmp/quality.md',
          description: 'Quality specialist',
          prompt: 'Quality prompt',
        },
      ] as any);

      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
        config: {
          review: {
            agents: ['security', 'quality'],
            default: {
              skills: [],
            },
          },
        } as any,
        modelOverrides: {
          'review/security': 'anthropic/claude-security',
        },
      });

      expect(mocks.createPiInProcessServer).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            agent: expect.objectContaining({
              'review/security': expect.objectContaining({
                prompt: 'Security prompt',
                model: 'anthropic/claude-security',
                tools: { Read: true },
              }),
              'review/quality': expect.objectContaining({
                prompt: 'Quality prompt',
              }),
            }),
          }),
        })
      );

      await client.shutdown();
    });

    it('passes skill search paths and agent skill configuration to Pi runtime', async () => {
      const projectRoot = process.cwd();

      const config = {
        review: {
          agents: [
            {
              name: 'security',
              skills: ['security-audit'],
            },
          ],
          default: {
            skills: ['baseline-review'],
          },
        },
      } as any;

      const client = await createRuntimeClientInstance({
        directory: projectRoot,
        config,
      });

      expect(mocks.createPiInProcessServer).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            skillSearchPaths: expect.any(Array),
            agentSkills: {
              'review/security': ['baseline-review', 'security-audit'],
            },
          }),
        })
      );

      await client.shutdown();
    });

    it('passes per-agent tool overrides to Pi runtime config', async () => {
      mocks.loadReviewAgents.mockReturnValue([
        {
          name: 'review/security',
          path: '/tmp/security.md',
          description: 'Security agent',
          prompt: 'Security prompt',
          tools: { Read: true, Bash: false, Edit: true },
        },
        {
          name: 'review/quality',
          path: '/tmp/quality.md',
          description: 'Quality agent',
          prompt: 'Quality prompt',
          // No tools override — uses global defaults
        },
      ] as any);

      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
        config: {
          review: {
            agents: ['security', 'quality'],
            default: { skills: [] },
          },
        } as any,
      });

      expect(mocks.createPiInProcessServer).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            agent: expect.objectContaining({
              'review/security': expect.objectContaining({
                tools: { Read: true, Bash: false, Edit: true },
              }),
              'review/quality': expect.not.objectContaining({
                tools: expect.anything(),
              }),
            }),
          }),
        })
      );

      await client.shutdown();
    });
  });

  describe('createSession', () => {
    it('throws error if not initialized', async () => {
      const client = new RuntimeClient({});

      await expect(
        client.createSession({
          agent: 'review/security',
          message: 'Review this code',
        })
      ).rejects.toThrow('Runtime client not initialized');
    });

    it('maps authentication errors to actionable messages', async () => {
      mocks.createPiInProcessServer.mockResolvedValueOnce(
        createRuntime({
          create: vi.fn(async () => {
            throw new Error('401 Unauthorized');
          }),
        })
      );

      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
      });

      await expect(
        client.createSession({
          agent: 'review/security',
          message: 'Review this code',
        })
      ).rejects.toThrow('Authentication failed with the configured model provider');
    });

    it('maps model resolution errors to actionable messages', async () => {
      mocks.createPiInProcessServer.mockResolvedValueOnce(
        createRuntime({
          create: vi.fn(async () => {
            throw new Error('Failed to resolve model "anthropic/does-not-exist"');
          }),
        })
      );

      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
      });

      await expect(
        client.createSession({
          agent: 'review/security',
          message: 'Review this code',
        })
      ).rejects.toThrow('Model configuration is invalid or unavailable');
    });

    it('includes local-runtime hint when connectivity errors occur', async () => {
      mocks.createPiInProcessServer.mockResolvedValueOnce(
        createRuntime({
          create: vi.fn(async () => {
            throw new Error('fetch failed');
          }),
        })
      );

      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
      });

      await expect(
        client.createSession({
          agent: 'review/security',
          message: 'Review this code',
        })
      ).rejects.toThrow('Verify local Pi runtime setup and model provider connectivity');
    });
  });

  describe('lifecycle and helper methods', () => {
    it('streamMessages throws if not initialized', async () => {
      const client = new RuntimeClient({});
      const generator = client.streamMessages('session-123');
      await expect(generator.next()).rejects.toThrow('Runtime client not initialized');
    });

    it('applies configured model pricing when runtime cost is missing or zero', async () => {
      const runtimeMessages = [
        {
          info: {
            id: 'msg-1',
            role: 'assistant',
            time: { completed: Date.now() },
            provider: 'opencode',
            model: 'glm-5-free',
            usage: {
              input: 1000,
              output: 100,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1100,
            },
          },
          parts: [{ text: 'done' }],
        },
      ];

      mocks.createPiInProcessServer.mockResolvedValueOnce(
        createRuntime({
          messages: vi.fn(async () => ({ data: runtimeMessages })),
        })
      );

      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
        config: {
          review: {
            agents: [],
            default: {
              skills: [],
            },
          },
          pricing: {
            models: {
              'opencode/glm-5-free': {
                input: 2,
                output: 8,
              },
            },
          },
        } as any,
      });

      const collected = [];
      for await (const message of client.streamMessages('session-123')) {
        collected.push(message);
      }

      expect(collected).toHaveLength(1);
      expect(collected[0].usage?.cost).toBeCloseTo(0.0028, 10);

      await client.shutdown();
    });

    it('closeSession throws if not initialized', async () => {
      const client = new RuntimeClient({});
      await expect(client.closeSession('session-123')).rejects.toThrow(
        'Runtime client not initialized'
      );
    });

    it('getServerUrl throws when server is not initialized', () => {
      const client = new RuntimeClient({});
      expect(() => client.getServerUrl()).toThrow('Server not initialized');
    });

    it('shutdown does not throw when no runtime is active', async () => {
      const client = new RuntimeClient({});
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('environment variable resolution', () => {
    it('resolves provider apiKey env references before runtime init', async () => {
      const originalEnv = process.env.TEST_API_KEY;
      process.env.TEST_API_KEY = 'test-key-123';

      try {
        const client = await createRuntimeClientInstance({
          directory: process.cwd(),
          provider: {
            'test-provider': {
              npm: '@test/provider',
              name: 'test-provider',
              models: { 'test-model': { name: 'test-model' } },
              options: {
                baseURL: 'https://api.test.com',
                apiKey: '{env:TEST_API_KEY}',
              } as any,
            },
          } as any,
        });

        expect(mocks.createPiInProcessServer).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              provider: expect.objectContaining({
                'test-provider': expect.objectContaining({
                  options: expect.objectContaining({
                    apiKey: 'test-key-123',
                  }),
                }),
              }),
            }),
          })
        );

        await client.shutdown();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.TEST_API_KEY;
        } else {
          process.env.TEST_API_KEY = originalEnv;
        }
      }
    });

    it('warns when referenced environment variables are missing', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalEnv = process.env.NONEXISTENT_VAR;
      delete process.env.NONEXISTENT_VAR;

      try {
        const client = await createRuntimeClientInstance({
          directory: process.cwd(),
          provider: {
            'test-provider': {
              npm: '@test/provider',
              name: 'test-provider',
              models: { 'test-model': { name: 'test-model' } },
              options: {
                baseURL: 'https://api.test.com',
                apiKey: '{env:NONEXISTENT_VAR}',
              } as any,
            },
          } as any,
        });

        // Logger outputs warning via console.log (human format)
        const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(allOutput).toContain('NONEXISTENT_VAR is not set');

        await client.shutdown();
      } finally {
        logSpy.mockRestore();
        if (originalEnv !== undefined) {
          process.env.NONEXISTENT_VAR = originalEnv;
        }
      }
    });
  });

  describe('factory functions', () => {
    it('createRuntimeClient returns an uninitialized client instance', () => {
      const client = createRuntimeClient({
        directory: process.cwd(),
      });

      expect(client).toBeInstanceOf(RuntimeClient);
    });

    it('createRuntimeClientInstance initializes in-process runtime', async () => {
      const client = await createRuntimeClientInstance({
        directory: process.cwd(),
      });

      expect(client).toBeInstanceOf(RuntimeClient);
      expect(mocks.createPiInProcessServer).toHaveBeenCalled();

      await client.shutdown();
    });
  });
});
