import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { collectFileChanges } from './subagent-adapter.js';

vi.mock('./client.js', () => ({}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

interface MockMessage {
  role: string;
  content: string;
}

async function* mockStream(messages: MockMessage[]) {
  for (const msg of messages) {
    yield { id: 'msg-1', ...msg, timestamp: new Date() };
  }
}

function createMockClient() {
  return {
    createSession: vi.fn(),
    streamMessages: vi.fn(),
    closeSession: vi.fn(),
  } as any;
}

describe('subagent-adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('collectFileChanges', () => {
    it('should process files in batches based on concurrency', async () => {
      const mockClient = createMockClient();
      const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

      mockClient.createSession.mockImplementation((_opts: any) =>
        Promise.resolve({ id: 'sess-1', agent: 'describe/file-analyzer', createdAt: new Date() })
      );
      mockClient.streamMessages.mockImplementation(() =>
        mockStream([{ role: 'assistant', content: 'Summary for file' }])
      );
      mockClient.closeSession.mockResolvedValue(undefined);

      const result = await collectFileChanges(mockClient, files, 'HEAD~1', '/tmp/project', {
        concurrency: 2,
      });

      expect(mockClient.createSession).toHaveBeenCalledTimes(5);
      expect(result.filesAnalyzed).toBe(5);
      expect(result.filesFailed).toBe(0);
    });

    it('should collect markdown from assistant messages', async () => {
      const mockClient = createMockClient();

      mockClient.createSession.mockResolvedValue({
        id: 'sess-1',
        agent: 'describe/file-analyzer',
        createdAt: new Date(),
      });
      mockClient.streamMessages.mockImplementation(() =>
        mockStream([
          { role: 'assistant', content: '## src/app.ts\n\nAdded new route.' },
          { role: 'assistant', content: 'Additional details here.' },
        ])
      );
      mockClient.closeSession.mockResolvedValue(undefined);

      const result = await collectFileChanges(mockClient, ['src/app.ts'], 'HEAD~1', '/tmp/project');

      expect(result.summaries).toHaveLength(1);
      expect(result.summaries[0].success).toBe(true);
      expect(result.summaries[0].summary).toContain('Added new route.');
      expect(result.summaries[0].summary).toContain('Additional details here.');
      expect(result.combinedMarkdown).toContain('Added new route.');
    });

    it('should handle failed analysis when agent returns empty content', async () => {
      vi.useFakeTimers();
      const mockClient = createMockClient();

      mockClient.createSession.mockResolvedValue({
        id: 'sess-1',
        agent: 'describe/file-analyzer',
        createdAt: new Date(),
      });
      mockClient.streamMessages.mockImplementation(() => mockStream([]));
      mockClient.closeSession.mockResolvedValue(undefined);

      const resultPromise = collectFileChanges(
        mockClient,
        ['src/empty.ts'],
        'HEAD~1',
        '/tmp/project'
      );

      // Advance timers past retry delays
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      // Should have retried (1 initial + 2 retries = 3 sessions)
      expect(mockClient.createSession).toHaveBeenCalledTimes(3);
      expect(result.summaries).toHaveLength(1);
      expect(result.summaries[0].success).toBe(false);
      expect(result.summaries[0].summary).toBe('');
      expect(result.filesFailed).toBe(1);
      expect(result.filesAnalyzed).toBe(0);

      vi.useRealTimers();
    });

    it('should handle agent errors (promise rejection)', async () => {
      const mockClient = createMockClient();

      mockClient.createSession.mockRejectedValue(new Error('Agent crashed'));

      const result = await collectFileChanges(mockClient, ['src/bad.ts'], 'HEAD~1', '/tmp/project');

      expect(result.summaries).toHaveLength(1);
      expect(result.summaries[0].success).toBe(false);
      expect(result.filesFailed).toBe(1);
    });

    it('should write summary files to .drs/file-changes/ directory', async () => {
      const mockClient = createMockClient();

      mockClient.createSession.mockResolvedValue({
        id: 'sess-1',
        agent: 'describe/file-analyzer',
        createdAt: new Date(),
      });
      mockClient.streamMessages.mockImplementation(() =>
        mockStream([{ role: 'assistant', content: 'File summary content' }])
      );
      mockClient.closeSession.mockResolvedValue(undefined);

      await collectFileChanges(mockClient, ['src/app.ts'], 'HEAD~1', '/tmp/project');

      expect(mkdir).toHaveBeenCalledWith('/tmp/project/.drs/file-changes', { recursive: true });
      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/project/.drs/file-changes/src__app.ts.md',
        'File summary content',
        'utf-8'
      );
    });

    it('should return correct combined markdown and stats', async () => {
      vi.useFakeTimers();
      const mockClient = createMockClient();

      // Track which file each createSession call is for
      const sessionFiles: string[] = [];
      mockClient.createSession.mockImplementation((opts: any) => {
        // Extract filename from the message
        const match = (opts.message as string).match(/`([^`]+)`/);
        sessionFiles.push(match?.[1] ?? '');
        return Promise.resolve({
          id: `sess-${sessionFiles.length}`,
          agent: 'describe/file-analyzer',
          createdAt: new Date(),
        });
      });
      mockClient.streamMessages.mockImplementation(() => {
        const currentFile = sessionFiles[sessionFiles.length - 1];
        // b.ts always returns empty (simulates persistent failure)
        if (currentFile === 'b.ts') {
          return mockStream([]);
        }
        return mockStream([{ role: 'assistant', content: `Summary for ${currentFile}` }]);
      });
      mockClient.closeSession.mockResolvedValue(undefined);

      const resultPromise = collectFileChanges(
        mockClient,
        ['a.ts', 'b.ts', 'c.ts'],
        'HEAD~1',
        '/tmp/project'
      );

      await vi.advanceTimersByTimeAsync(20000);
      const result = await resultPromise;

      expect(result.filesAnalyzed).toBe(2);
      expect(result.filesFailed).toBe(1);
      expect(result.combinedMarkdown).toContain('Summary for a.ts');
      expect(result.combinedMarkdown).toContain('Summary for c.ts');
      expect(result.combinedMarkdown).toContain('---');

      vi.useRealTimers();
    });

    it('should sanitize filenames correctly', async () => {
      const mockClient = createMockClient();

      mockClient.createSession.mockResolvedValue({
        id: 'sess-1',
        agent: 'describe/file-analyzer',
        createdAt: new Date(),
      });
      mockClient.streamMessages.mockImplementation(() =>
        mockStream([{ role: 'assistant', content: 'summary' }])
      );
      mockClient.closeSession.mockResolvedValue(undefined);

      await collectFileChanges(
        mockClient,
        ['src/utils/helpers.ts', '.hidden/config.ts'],
        'HEAD~1',
        '/tmp/project'
      );

      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/project/.drs/file-changes/src__utils__helpers.ts.md',
        'summary',
        'utf-8'
      );
      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/project/.drs/file-changes/hidden__config.ts.md',
        'summary',
        'utf-8'
      );
    });
  });
});
