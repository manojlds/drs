import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  filterIgnoredFiles,
  connectToRuntime,
  executeReview,
  type ReviewSource,
} from './review-orchestrator.js';
import type { DRSConfig } from './config.js';

// Mock dependencies
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    shouldIgnoreFile: vi.fn((file: string, config: DRSConfig) => {
      const patterns = config.review.ignorePatterns || [];
      return patterns.some((pattern: string) => {
        if (pattern.endsWith('/*')) {
          const dir = pattern.slice(0, -2);
          return file.startsWith(dir + '/');
        }
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          return regex.test(file);
        }
        return file === pattern;
      });
    }),
    getModelOverrides: vi.fn(() => ({})),
    getUnifiedModelOverride: vi.fn(() => ({})),
  };
});

// Store mock client instance for verification
let mockRuntimeClient: any;

vi.mock('../runtime/client.js', () => {
  const createRuntimeClientInstance = vi.fn(async () => {
    mockRuntimeClient = {
      createSession: vi.fn(async () => ({ id: 'session-1' })),
      streamMessages: vi.fn(async function* () {
        yield {
          role: 'assistant',
          content: JSON.stringify({
            issues: [
              {
                category: 'QUALITY',
                severity: 'MEDIUM',
                title: 'Test issue',
                file: 'src/app.ts',
                line: 10,
                problem: 'Test problem',
                solution: 'Test solution',
              },
            ],
          }),
        };
      }),
      closeSession: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      getMinContextWindow: vi.fn(() => undefined),
    };
    return mockRuntimeClient;
  });

  return {
    createRuntimeClientInstance,
  };
});

vi.mock('./review-core.js', () => ({
  buildBaseInstructions: vi.fn((label: string) => `Instructions for ${label}`),
  runReviewPipeline: vi.fn(async (_runtime, _config, _instructions, _label, files) => ({
    issues: [
      {
        category: 'QUALITY',
        severity: 'MEDIUM',
        title: 'Test issue',
        file: files[0] || 'src/app.ts',
        line: 10,
        problem: 'Test problem',
        solution: 'Test solution',
        agent: 'quality',
      },
    ],
    summary: {
      filesReviewed: files.length,
      issuesFound: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
      byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
    },
    filesReviewed: files.length,
    agentResults: [],
  })),
  displayReviewSummary: vi.fn(),
  hasBlockingIssues: vi.fn(() => false),
}));

vi.mock('./comment-formatter.js', () => ({
  calculateSummary: vi.fn((filesReviewed: number, issues: any[]) => ({
    filesReviewed,
    issuesFound: issues.length,
    bySeverity: {
      CRITICAL: issues.filter((i) => i.severity === 'CRITICAL').length,
      HIGH: issues.filter((i) => i.severity === 'HIGH').length,
      MEDIUM: issues.filter((i) => i.severity === 'MEDIUM').length,
      LOW: issues.filter((i) => i.severity === 'LOW').length,
    },
    byCategory: {
      SECURITY: issues.filter((i) => i.category === 'SECURITY').length,
      QUALITY: issues.filter((i) => i.category === 'QUALITY').length,
      STYLE: issues.filter((i) => i.category === 'STYLE').length,
      PERFORMANCE: issues.filter((i) => i.category === 'PERFORMANCE').length,
      DOCUMENTATION: issues.filter((i) => i.category === 'DOCUMENTATION').length,
    },
  })),
}));

vi.mock('./context-compression.js', () => ({
  compressFilesWithDiffs: vi.fn((files) => ({
    files,
    omitted: { deletionsOnly: [], dueToBudget: [], generated: [] },
  })),
  prepareDiffsForAgent: vi.fn((files) => ({
    files,
    omitted: { deletionsOnly: [], dueToBudget: [], generated: [] },
  })),
  formatCompressionSummary: vi.fn(() => null),
  resolveCompressionBudget: vi.fn((_contextWindow: unknown, options: unknown) => options ?? {}),
}));

describe('review-orchestrator', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('filterIgnoredFiles', () => {
    it('should filter files based on ignore patterns', () => {
      const config: DRSConfig = {
        review: {
          ignorePatterns: ['*.test.ts', 'dist/*', 'node_modules/*'],
        },
      } as DRSConfig;

      const files = [
        'src/app.ts',
        'src/app.test.ts',
        'dist/bundle.js',
        'node_modules/package/index.js',
        'src/utils.ts',
      ];

      const result = filterIgnoredFiles(files, config);

      expect(result).toEqual(['src/app.ts', 'src/utils.ts']);
    });

    it('should return all files when no ignore patterns', () => {
      const config = {
        pi: {},
        gitlab: { url: '', token: '' },
        github: { token: '' },
        review: {
          ignorePatterns: [],
        },
      } as unknown as DRSConfig;

      const files = ['src/app.ts', 'src/utils.ts', 'README.md'];

      const result = filterIgnoredFiles(files, config);

      expect(result).toEqual(files);
    });

    it('should handle glob patterns correctly', () => {
      const config: DRSConfig = {
        review: {
          ignorePatterns: ['**/*.spec.ts', 'test/**'],
        },
      } as DRSConfig;

      const files = ['src/app.ts', 'src/app.spec.ts', 'test/integration.ts', 'lib/utils.ts'];

      const result = filterIgnoredFiles(files, config);

      expect(result).toContain('src/app.ts');
      expect(result).toContain('lib/utils.ts');
    });

    it('should handle empty file list', () => {
      const config: DRSConfig = {
        review: {
          ignorePatterns: ['*.test.ts'],
        },
      } as DRSConfig;

      const result = filterIgnoredFiles([], config);

      expect(result).toEqual([]);
    });
  });

  describe('connectToRuntime', () => {
    it('should connect to in-process Pi runtime successfully', async () => {
      const config: DRSConfig = {
        pi: {},
        review: {},
      } as DRSConfig;

      const client = await connectToRuntime(config, '/test/dir');

      expect(client).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(client.createSession).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(client.shutdown).toBeDefined();
    });

    it('should handle connection failure', async () => {
      const { createRuntimeClientInstance } = await import('../runtime/client.js');
      vi.mocked(createRuntimeClientInstance).mockRejectedValueOnce(new Error('Connection failed'));

      const config: DRSConfig = {
        pi: {},
        review: {},
      } as DRSConfig;

      await expect(connectToRuntime(config)).rejects.toThrow('Connection failed');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect to Pi runtime')
      );
    });

    it('should pass model overrides to runtime client', async () => {
      const { createRuntimeClientInstance } = await import('../runtime/client.js');
      const { getModelOverrides, getUnifiedModelOverride } = await import('./config.js');

      vi.mocked(getModelOverrides).mockReturnValue({
        'review/security': 'claude-opus-4',
      });
      vi.mocked(getUnifiedModelOverride).mockReturnValue({
        'review/unified-reviewer': 'claude-sonnet-4',
      });

      const config: DRSConfig = {
        pi: {},
        review: {},
      } as DRSConfig;

      await connectToRuntime(config, '/test/dir', { debug: true });

      expect(createRuntimeClientInstance).toHaveBeenCalledWith({
        config,
        directory: '/test/dir',
        modelOverrides: {
          'review/security': 'claude-opus-4',
          'review/unified-reviewer': 'claude-sonnet-4',
        },
        provider: undefined,
        debug: true,
      });
    });

    it('should use process.cwd() when no working directory provided', async () => {
      const { createRuntimeClientInstance } = await import('../runtime/client.js');

      const config: DRSConfig = {
        pi: {},
        review: {},
      } as DRSConfig;

      await connectToRuntime(config);

      expect(createRuntimeClientInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          directory: process.cwd(),
        })
      );
    });
  });

  describe('executeReview', () => {
    let mockConfig: DRSConfig;

    beforeEach(() => {
      mockConfig = {
        pi: {},
        review: {
          agents: ['security', 'quality'],
          ignorePatterns: ['*.test.ts'],
        },
        contextCompression: {
          enabled: false,
        },
      } as DRSConfig;
    });

    it('should execute review successfully with files', async () => {
      const source: ReviewSource = {
        name: 'Local diff',
        files: ['src/app.ts', 'src/utils.ts'],
        context: {},
        workingDir: '/test/dir',
      };

      const result = await executeReview(mockConfig, source);

      expect(result.issues).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.filesReviewed).toBe(2);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should filter ignored files before executing review agents', async () => {
      const source: ReviewSource = {
        name: 'Local diff',
        files: ['src/app.ts', 'src/app.test.ts', 'src/utils.ts'],
        context: {},
      };

      const result = await executeReview(mockConfig, source);
      const { runReviewPipeline } = await import('./review-core.js');

      // Should have filtered out .test.ts file before review execution
      expect(result.filesReviewed).toBe(2);
      expect(runReviewPipeline).toHaveBeenCalledWith(
        expect.anything(),
        mockConfig,
        expect.anything(),
        'Local diff',
        ['src/app.ts', 'src/utils.ts'],
        {},
        process.cwd(),
        false
      );
    });

    it('should return empty result when all files are ignored', async () => {
      const { createRuntimeClientInstance } = await import('../runtime/client.js');
      const { runReviewPipeline } = await import('./review-core.js');
      vi.mocked(createRuntimeClientInstance).mockClear();
      vi.mocked(runReviewPipeline).mockClear();

      const source: ReviewSource = {
        name: 'Local diff',
        files: ['test1.test.ts', 'test2.test.ts'],
        context: {},
      };

      const result = await executeReview(mockConfig, source);

      expect(result.issues).toEqual([]);
      expect(result.filesReviewed).toBe(0);
      expect(result.summary.issuesFound).toBe(0);
      expect(createRuntimeClientInstance).not.toHaveBeenCalled();
      expect(runReviewPipeline).not.toHaveBeenCalled();
    });

    it('should handle staged diff command', async () => {
      const { buildBaseInstructions } = await import('./review-core.js');

      const source: ReviewSource = {
        name: 'Staged changes',
        files: ['src/app.ts'],
        context: {},
        staged: true,
      };

      await executeReview(mockConfig, source);

      expect(buildBaseInstructions).toHaveBeenCalledWith(
        'Staged changes',
        expect.anything(),
        'git diff --cached -- <file>',
        null
      );
    });

    it('should handle unstaged diff command', async () => {
      const { buildBaseInstructions } = await import('./review-core.js');

      const source: ReviewSource = {
        name: 'Unstaged changes',
        files: ['src/app.ts'],
        context: {},
        staged: false,
      };

      await executeReview(mockConfig, source);

      expect(buildBaseInstructions).toHaveBeenCalledWith(
        'Unstaged changes',
        expect.anything(),
        'git diff -- <file>',
        null
      );
    });

    it('should use provided diffs when available', async () => {
      const source: ReviewSource = {
        name: 'PR #123',
        files: ['src/app.ts', 'src/utils.ts'],
        filesWithDiffs: [
          { filename: 'src/app.ts', patch: '+ new code' },
          { filename: 'src/utils.ts', patch: '- old code\n+ new code' },
        ],
        context: {},
      };

      const result = await executeReview(mockConfig, source);

      expect(result.filesReviewed).toBe(2);
    });

    it('should filter filesWithDiffs to match filtered files', async () => {
      const source: ReviewSource = {
        name: 'PR #123',
        files: ['src/app.ts', 'src/app.test.ts', 'src/utils.ts'],
        filesWithDiffs: [
          { filename: 'src/app.ts', patch: '+ new code' },
          { filename: 'src/app.test.ts', patch: '+ test code' },
          { filename: 'src/utils.ts', patch: '+ util code' },
        ],
        context: {},
      };

      await executeReview(mockConfig, source);

      // Should filter out .test.ts file from diffs as well
      const { buildBaseInstructions } = await import('./review-core.js');
      expect(buildBaseInstructions).toHaveBeenCalled();
    });

    it('should handle empty file list', async () => {
      const source: ReviewSource = {
        name: 'Empty review',
        files: [],
        context: {},
      };

      const result = await executeReview(mockConfig, source);

      expect(result.issues).toEqual([]);
      expect(result.filesReviewed).toBe(0);
    });

    it('should pass debug flag to agents', async () => {
      const source: ReviewSource = {
        name: 'Debug review',
        files: ['src/app.ts'],
        context: {},
        debug: true,
      };

      await executeReview(mockConfig, source);

      const { runReviewPipeline } = await import('./review-core.js');
      expect(runReviewPipeline).toHaveBeenCalledWith(
        expect.anything(),
        mockConfig,
        expect.anything(),
        'Debug review',
        ['src/app.ts'],
        {},
        process.cwd(),
        true
      );
    });

    it('should pass additional context to agents', async () => {
      const source: ReviewSource = {
        name: 'PR #123',
        files: ['src/app.ts'],
        context: {
          prNumber: 123,
          author: 'test-user',
        },
      };

      await executeReview(mockConfig, source);

      const { runReviewPipeline } = await import('./review-core.js');
      expect(runReviewPipeline).toHaveBeenCalledWith(
        expect.anything(),
        mockConfig,
        expect.anything(),
        'PR #123',
        ['src/app.ts'],
        { prNumber: 123, author: 'test-user' },
        process.cwd(),
        false
      );
    });

    it('uses only unified model IDs for budget sizing in unified mode', async () => {
      const { getModelOverrides, getUnifiedModelOverride } = await import('./config.js');
      vi.mocked(getModelOverrides).mockReturnValueOnce({
        'review/security': 'provider/small-8k',
      });
      vi.mocked(getUnifiedModelOverride).mockReturnValueOnce({
        'review/unified-reviewer': 'provider/large-200k',
      });

      const source: ReviewSource = {
        name: 'Unified review',
        files: ['src/app.ts'],
        context: {},
      };

      await executeReview(
        {
          ...mockConfig,
          review: {
            ...mockConfig.review,
            mode: 'unified',
          },
        } as DRSConfig,
        source
      );

      expect(mockRuntimeClient.getMinContextWindow).toHaveBeenCalledWith(['provider/large-200k']);
    });

    it('uses only multi-agent model IDs for budget sizing in multi-agent mode', async () => {
      const { getModelOverrides, getUnifiedModelOverride } = await import('./config.js');
      vi.mocked(getModelOverrides).mockReturnValueOnce({
        'review/security': 'provider/large-200k',
      });
      vi.mocked(getUnifiedModelOverride).mockReturnValueOnce({
        'review/unified-reviewer': 'provider/small-8k',
      });

      const source: ReviewSource = {
        name: 'Multi-agent review',
        files: ['src/app.ts'],
        context: {},
      };

      await executeReview(
        {
          ...mockConfig,
          review: {
            ...mockConfig.review,
            mode: 'multi-agent',
          },
        } as DRSConfig,
        source
      );

      expect(mockRuntimeClient.getMinContextWindow).toHaveBeenCalledWith(['provider/large-200k']);
    });

    it('should shutdown runtime client after review', async () => {
      const source: ReviewSource = {
        name: 'Test review',
        files: ['src/app.ts'],
        context: {},
      };

      await executeReview(mockConfig, source);

      // Verify shutdown was called on the mock client
      expect(mockRuntimeClient.shutdown).toHaveBeenCalled();
    });

    it('should shutdown runtime client even on error', async () => {
      const { runReviewPipeline } = await import('./review-core.js');
      vi.mocked(runReviewPipeline).mockRejectedValueOnce(new Error('Review failed'));

      const source: ReviewSource = {
        name: 'Test review',
        files: ['src/app.ts'],
        context: {},
      };

      await expect(executeReview(mockConfig, source)).rejects.toThrow('Review failed');

      // Verify shutdown was called even on error
      expect(mockRuntimeClient.shutdown).toHaveBeenCalled();
    });

    it('should handle "All review agents failed" error specially', async () => {
      const { runReviewPipeline } = await import('./review-core.js');
      vi.mocked(runReviewPipeline).mockRejectedValueOnce(new Error('All review agents failed'));

      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const source: ReviewSource = {
        name: 'Test review',
        files: ['src/app.ts'],
        context: {},
      };

      await expect(executeReview(mockConfig, source)).rejects.toThrow('All review agents failed');

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });

    it('should log compression warning when context is compressed', async () => {
      const { formatCompressionSummary } = await import('./context-compression.js');
      vi.mocked(formatCompressionSummary).mockReturnValueOnce(
        '⚠️  Removed 5 files to fit token budget'
      );

      const source: ReviewSource = {
        name: 'Large PR',
        files: ['src/app.ts'],
        context: {},
      };

      await executeReview(mockConfig, source);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Diff content trimmed to fit token budget')
      );
    });
  });
});
