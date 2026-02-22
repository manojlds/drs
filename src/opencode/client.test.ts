import { existsSync, mkdirSync, rmSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpencodeClient, createOpencodeClient, createOpencodeClientInstance } from './client.js';

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

describe('OpencodeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mocks.createPiInProcessServer.mockResolvedValue(createRuntime());
    mocks.loadReviewAgents.mockReturnValue([]);
  });

  describe('constructor', () => {
    it('creates an instance with minimal config', () => {
      const client = new OpencodeClient({
        directory: '/test/dir',
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('supports optional model overrides and provider config', () => {
      const client = new OpencodeClient({
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

      expect(client).toBeInstanceOf(OpencodeClient);
    });
  });

  describe('initialize', () => {
    it('fails fast when remote endpoint is configured', async () => {
      const client = new OpencodeClient({
        baseUrl: 'http://localhost:3000',
      });

      await expect(client.initialize()).rejects.toThrow(
        'Remote Pi runtime endpoints are not supported by DRS'
      );
    });

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

      const client = await createOpencodeClientInstance({
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

    it('sets and restores skill search roots for runtime tool discovery', async () => {
      const projectRoot = process.cwd();
      const piSkillsPath = join(projectRoot, '.pi', 'skills');
      const hadPiSkillsPath = existsSync(piSkillsPath);

      if (!hadPiSkillsPath) {
        mkdirSync(piSkillsPath, { recursive: true });
      }

      const originalSkillRoot = process.env.DRS_SKILLS_ROOT;
      const originalSkillRoots = process.env.DRS_SKILLS_ROOTS;

      process.env.DRS_SKILLS_ROOT = '/tmp/original-skill-root';
      process.env.DRS_SKILLS_ROOTS = ['/tmp/original-a', '/tmp/original-b'].join(delimiter);

      let client: OpencodeClient | undefined;

      try {
        client = await createOpencodeClientInstance({
          directory: projectRoot,
          config: {
            review: {
              agents: ['security'],
              default: {
                skills: [],
              },
            },
          } as any,
        });

        expect(process.env.DRS_SKILLS_ROOT).toBe(resolve(projectRoot, '.drs/skills'));
        expect(process.env.DRS_SKILLS_ROOTS).toBe(
          [resolve(projectRoot, '.drs/skills'), resolve(projectRoot, '.pi/skills')].join(delimiter)
        );

        await client.shutdown();
        client = undefined;

        expect(process.env.DRS_SKILLS_ROOT).toBe('/tmp/original-skill-root');
        expect(process.env.DRS_SKILLS_ROOTS).toBe(
          ['/tmp/original-a', '/tmp/original-b'].join(delimiter)
        );
      } finally {
        if (client) {
          await client.shutdown();
        }

        if (originalSkillRoot === undefined) {
          delete process.env.DRS_SKILLS_ROOT;
        } else {
          process.env.DRS_SKILLS_ROOT = originalSkillRoot;
        }

        if (originalSkillRoots === undefined) {
          delete process.env.DRS_SKILLS_ROOTS;
        } else {
          process.env.DRS_SKILLS_ROOTS = originalSkillRoots;
        }

        if (!hadPiSkillsPath) {
          rmSync(piSkillsPath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('createSession', () => {
    it('throws error if not initialized', async () => {
      const client = new OpencodeClient({});

      await expect(
        client.createSession({
          agent: 'review/security',
          message: 'Review this code',
        })
      ).rejects.toThrow('OpenCode client not initialized');
    });

    it('maps authentication errors to actionable messages', async () => {
      mocks.createPiInProcessServer.mockResolvedValueOnce(
        createRuntime({
          create: vi.fn(async () => {
            throw new Error('401 Unauthorized');
          }),
        })
      );

      const client = await createOpencodeClientInstance({
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

      const client = await createOpencodeClientInstance({
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

      const client = await createOpencodeClientInstance({
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
      const client = new OpencodeClient({});
      const generator = client.streamMessages('session-123');
      await expect(generator.next()).rejects.toThrow('OpenCode client not initialized');
    });

    it('closeSession throws if not initialized', async () => {
      const client = new OpencodeClient({});
      await expect(client.closeSession('session-123')).rejects.toThrow(
        'OpenCode client not initialized'
      );
    });

    it('getServerUrl throws when server is not initialized', () => {
      const client = new OpencodeClient({});
      expect(() => client.getServerUrl()).toThrow('Server not initialized');
    });

    it('shutdown does not throw when no runtime is active', async () => {
      const client = new OpencodeClient({});
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('environment variable resolution', () => {
    it('resolves provider apiKey env references before runtime init', async () => {
      const originalEnv = process.env.TEST_API_KEY;
      process.env.TEST_API_KEY = 'test-key-123';

      try {
        const client = await createOpencodeClientInstance({
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
      const warnSpy = vi.spyOn(console, 'warn');
      const originalEnv = process.env.NONEXISTENT_VAR;
      delete process.env.NONEXISTENT_VAR;

      try {
        const client = await createOpencodeClientInstance({
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

        expect(warnSpy).toHaveBeenCalledWith('⚠️  Environment variable NONEXISTENT_VAR is not set');

        await client.shutdown();
      } finally {
        if (originalEnv !== undefined) {
          process.env.NONEXISTENT_VAR = originalEnv;
        }
      }
    });
  });

  describe('factory functions', () => {
    it('createOpencodeClient returns an uninitialized client instance', () => {
      const client = createOpencodeClient({
        directory: process.cwd(),
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('createOpencodeClientInstance initializes in-process runtime', async () => {
      const client = await createOpencodeClientInstance({
        directory: process.cwd(),
      });

      expect(client).toBeInstanceOf(OpencodeClient);
      expect(mocks.createPiInProcessServer).toHaveBeenCalled();

      await client.shutdown();
    });
  });
});
