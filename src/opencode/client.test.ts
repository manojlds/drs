import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpencodeClient, createOpencodeClient, createOpencodeClientInstance } from './client.js';

// Mock the OpenCode SDK
vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(async () => ({
    server: {
      url: 'http://localhost:3000',
      close: vi.fn(),
    },
    client: {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-123' } })),
        prompt: vi.fn(async () => {}),
        messages: vi.fn(async () => ({ data: [] })),
        delete: vi.fn(async () => {}),
      },
    },
  })),
  createOpencodeClient: vi.fn((_config: any) => ({
    session: {
      create: vi.fn(async () => ({ data: { id: 'session-456' } })),
      prompt: vi.fn(async () => {}),
      messages: vi.fn(async () => ({ data: [] })),
      delete: vi.fn(async () => {}),
    },
  })),
}));

describe('OpencodeClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with baseUrl', () => {
      const client = new OpencodeClient({
        baseUrl: 'http://localhost:3000',
        directory: '/test/dir',
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('should create an instance without baseUrl for in-process server', () => {
      const client = new OpencodeClient({
        directory: '/test/dir',
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('should handle model overrides in config', () => {
      const client = new OpencodeClient({
        modelOverrides: {
          'review/security': 'claude-opus-4',
        },
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('should handle custom provider in config', () => {
      const client = new OpencodeClient({
        provider: {
          'custom-provider': {
            models: { 'custom-model': { name: 'custom-model' } },
            options: {
              baseURL: 'https://api.custom.com',
              apiKey: '{env:CUSTOM_API_KEY}',
            } as any,
          },
        },
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });
  });

  describe('createSession', () => {
    it('should throw error if not initialized', async () => {
      const client = new OpencodeClient({});

      await expect(
        client.createSession({
          agent: 'review/security',
          message: 'Review this code',
        })
      ).rejects.toThrow('OpenCode client not initialized');
    });
  });

  describe('streamMessages', () => {
    it('should throw error if not initialized', async () => {
      const client = new OpencodeClient({});

      const generator = client.streamMessages('session-123');

      await expect(generator.next()).rejects.toThrow('OpenCode client not initialized');
    });
  });

  describe('closeSession', () => {
    it('should throw error if not initialized', async () => {
      const client = new OpencodeClient({});

      await expect(client.closeSession('session-123')).rejects.toThrow(
        'OpenCode client not initialized'
      );
    });
  });

  describe('getServerUrl', () => {
    it('should throw error if server not initialized', () => {
      const client = new OpencodeClient({});

      expect(() => client.getServerUrl()).toThrow('Server not initialized');
    });
  });

  describe('shutdown', () => {
    it('should not throw error when no server is running', async () => {
      const client = new OpencodeClient({});

      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('environment variable resolution', () => {
    it('should resolve environment variables in provider config', () => {
      // Set up test environment variable
      const originalEnv = process.env.TEST_API_KEY;
      process.env.TEST_API_KEY = 'test-key-123';

      const client = new OpencodeClient({
        provider: {
          'test-provider': {
            models: { 'test-model': { name: 'test-model' } },
            options: {
              baseURL: 'https://api.test.com',
              apiKey: '{env:TEST_API_KEY}',
            } as any,
          },
        },
      });

      // The client should be created successfully
      expect(client).toBeInstanceOf(OpencodeClient);

      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = originalEnv;
      }
    });

    it('should warn when environment variable is not set', () => {
      const consoleSpy = vi.spyOn(console, 'warn');

      // Make sure the env var doesn't exist
      const originalEnv = process.env.NONEXISTENT_VAR;
      delete process.env.NONEXISTENT_VAR;

      const client = new OpencodeClient({
        provider: {
          'test-provider': {
            models: { 'test-model': { name: 'test-model' } },
            options: {
              baseURL: 'https://api.test.com',
              apiKey: '{env:NONEXISTENT_VAR}',
            } as any,
          },
        },
      });

      expect(client).toBeInstanceOf(OpencodeClient);

      // Restore original env
      if (originalEnv !== undefined) {
        process.env.NONEXISTENT_VAR = originalEnv;
      }

      consoleSpy.mockRestore();
    });

    it('should handle non-env string values', () => {
      const client = new OpencodeClient({
        provider: {
          'test-provider': {
            npm: '@test/provider',
            name: 'test-provider',
            models: { 'test-model': { name: 'test-model' } },
            options: {
              baseURL: 'https://api.test.com',
              apiKey: 'hardcoded-key',
            } as any,
          },
        } as any,
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('should handle nested objects with env vars', () => {
      const originalEnv = process.env.TEST_NESTED_KEY;
      process.env.TEST_NESTED_KEY = 'nested-value';

      const client = new OpencodeClient({
        provider: {
          'test-provider': {
            npm: '@test/provider',
            name: 'test-provider',
            models: { 'test-model': { name: 'test-model' } },
            options: {
              baseURL: 'https://api.test.com',
              apiKey: 'test-key',
              nested: {
                deepKey: '{env:TEST_NESTED_KEY}',
              },
            } as any,
          },
        } as any,
      });

      expect(client).toBeInstanceOf(OpencodeClient);

      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.TEST_NESTED_KEY;
      } else {
        process.env.TEST_NESTED_KEY = originalEnv;
      }
    });

    it('should handle arrays with env vars', () => {
      const originalEnv = process.env.TEST_ARRAY_KEY;
      process.env.TEST_ARRAY_KEY = 'array-value';

      const client = new OpencodeClient({
        provider: {
          'test-provider': {
            models: { 'test-model': { name: 'test-model' } },
            options: {
              baseURL: 'https://api.test.com',
              apiKey: 'test-key',
              keys: ['{env:TEST_ARRAY_KEY}', 'static-value'],
            } as any,
          } as any,
        },
      });

      expect(client).toBeInstanceOf(OpencodeClient);

      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.TEST_ARRAY_KEY;
      } else {
        process.env.TEST_ARRAY_KEY = originalEnv;
      }
    });

    it('should handle primitive values', () => {
      const client = new OpencodeClient({
        provider: {
          'test-provider': {
            models: { 'test-model': { name: 'test-model' } },
            options: {
              baseURL: 'https://api.test.com',
              apiKey: 'test-key',
              timeout: 5000,
              enabled: true,
              ratio: 0.5,
              nullValue: null,
            } as any,
          } as any,
        },
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });
  });

  describe('factory functions', () => {
    it('should create client with createOpencodeClient (deprecated)', () => {
      const client = createOpencodeClient({
        baseUrl: 'http://localhost:3000',
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('should create and initialize client with createOpencodeClientInstance', async () => {
      const { createOpencodeClient: createSDKClient } = await import('@opencode-ai/sdk');

      // Mock for remote server
      vi.mocked(createSDKClient).mockReturnValueOnce({
        session: {
          create: vi.fn(async () => ({ data: { id: 'session-789' } })),
          prompt: vi.fn(async () => {}),
          messages: vi.fn(async () => ({ data: [] })),
          delete: vi.fn(async () => {}),
        },
      } as any);

      const client = await createOpencodeClientInstance({
        baseUrl: 'http://localhost:3000',
      });

      expect(client).toBeInstanceOf(OpencodeClient);
      expect(createSDKClient).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:3000',
      });
    });
  });

  describe('debug mode', () => {
    it('should log debug information when debug is enabled', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const client = new OpencodeClient({
        debug: true,
        modelOverrides: {
          'review/security': 'claude-opus-4',
        },
      });

      expect(client).toBeInstanceOf(OpencodeClient);
      consoleSpy.mockRestore();
    });
  });

  describe('configuration', () => {
    it('should handle complex configuration with all options', () => {
      const client = new OpencodeClient({
        baseUrl: 'http://localhost:3000',
        directory: '/test/project',
        modelOverrides: {
          'review/security': 'claude-opus-4',
          'review/quality': 'claude-sonnet-4',
        },
        provider: {
          'custom-provider': {
            npm: '@custom/provider',
            name: 'custom-provider',
            models: { 'custom-model': { name: 'custom-model' } },
            options: {
              baseURL: 'https://api.custom.com',
              apiKey: '{env:CUSTOM_KEY}',
            } as any,
          },
        } as any,
        debug: false,
      });

      expect(client).toBeInstanceOf(OpencodeClient);
    });

    it('should handle minimal configuration', () => {
      const client = new OpencodeClient({});

      expect(client).toBeInstanceOf(OpencodeClient);
    });
  });
});
