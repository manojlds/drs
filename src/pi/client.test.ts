import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiClient, createPiClientInstance } from './client.js';

describe('PiClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with directory', () => {
      const client = new PiClient({
        directory: '/test/dir',
      });

      expect(client).toBeInstanceOf(PiClient);
    });

    it('should create an instance with model overrides', () => {
      const client = new PiClient({
        modelOverrides: {
          'review/security': 'anthropic/claude-opus-4',
        },
      });

      expect(client).toBeInstanceOf(PiClient);
    });

    it('should create an instance with minimal config', () => {
      const client = new PiClient({});

      expect(client).toBeInstanceOf(PiClient);
    });
  });

  describe('initialize', () => {
    it('should initialize without error', async () => {
      const client = new PiClient({});
      await expect(client.initialize()).resolves.toBeUndefined();
    });

    it('should log debug info when debug is enabled', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const client = new PiClient({
        debug: true,
        modelOverrides: {
          'review/security': 'anthropic/claude-opus-4',
        },
      });
      await client.initialize();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Pi-mono client initialized')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('closeSession', () => {
    it('should not throw error for non-existent session', async () => {
      const client = new PiClient({});
      await client.initialize();
      await expect(client.closeSession('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('streamMessages', () => {
    it('should throw error for non-existent session', async () => {
      const client = new PiClient({});
      await client.initialize();

      const generator = client.streamMessages('nonexistent');
      await expect(generator.next()).rejects.toThrow('Session nonexistent not found');
    });
  });

  describe('shutdown', () => {
    it('should not throw error', async () => {
      const client = new PiClient({});
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('factory functions', () => {
    it('should create and initialize client with createPiClientInstance', async () => {
      const client = await createPiClientInstance({
        directory: '/test/dir',
      });

      expect(client).toBeInstanceOf(PiClient);
    });
  });
});
