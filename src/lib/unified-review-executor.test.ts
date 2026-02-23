/**
 * Tests for unified-review-executor.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeUnifiedReview, type UnifiedReviewOptions } from './unified-review-executor.js';
import type { DRSConfig } from './config.js';
import type { PlatformClient } from './platform-client.js';

// Mock all dependencies
vi.mock('./config.js', () => ({
  getModelOverrides: vi.fn(() => ({})),
  getUnifiedModelOverride: vi.fn(() => ({})),
  getDescriberModelOverride: vi.fn(() => ({})),
  getDefaultModel: vi.fn(() => undefined),
}));

vi.mock('./repository-validator.js', () => ({
  enforceRepoBranchMatch: vi.fn().mockResolvedValue(undefined),
  resolveBaseBranch: vi.fn(() => ({
    baseBranch: 'main',
    resolvedBaseBranch: 'origin/main',
    source: 'pr:targetBranch',
  })),
  getCanonicalDiffCommand: vi.fn(() => 'git diff origin/main origin/feature -- <file>'),
}));

vi.mock('./review-orchestrator.js', () => {
  const connectToRuntime = vi.fn(() => ({
    createSession: vi.fn(),
    streamMessages: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getMinContextWindow: vi.fn(() => undefined),
  }));

  return {
    filterIgnoredFiles: vi.fn((files) => files),
    connectToRuntime,
    connectToOpenCode: connectToRuntime,
  };
});

vi.mock('./review-core.js', () => ({
  buildBaseInstructions: vi.fn(() => 'Review these files...'),
  runReviewPipeline: vi.fn(() => ({
    summary: {
      issuesFound: 2,
      filesReviewed: 2,
      bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 0 },
      byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 1, PERFORMANCE: 0, DOCUMENTATION: 0 },
    },
    issues: [
      {
        severity: 'HIGH',
        category: 'QUALITY',
        title: 'Test issue',
        problem: 'Test issue detected',
        solution: 'Fix this issue',
        file: 'test.ts',
        line: 10,
        agent: 'quality',
      },
    ],
    changeSummary: undefined,
    filesReviewed: 2,
    agentResults: [],
  })),
  displayReviewSummary: vi.fn(),
}));

vi.mock('./comment-poster.js', () => ({
  postReviewComments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./description-executor.js', () => ({
  runDescribeIfEnabled: vi.fn().mockResolvedValue({
    title: 'Test PR',
    description: 'Test description',
  }),
}));

vi.mock('./code-quality-report.js', () => ({
  generateCodeQualityReport: vi.fn(() => []),
  formatCodeQualityReport: vi.fn(() => '[]'),
}));

vi.mock('./json-output.js', () => ({
  formatReviewJson: vi.fn(() => ({})),
  writeReviewJson: vi.fn().mockResolvedValue(undefined),
  printReviewJson: vi.fn(),
}));

vi.mock('./context-compression.js', () => ({
  prepareDiffsForAgent: vi.fn((files: any[]) => ({ files, generated: [] })),
  formatCompressionSummary: vi.fn(() => ''),
  resolveCompressionBudget: vi.fn((_contextWindow: unknown, options: unknown) => options ?? {}),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('unified-review-executor', () => {
  let mockPlatformClient: PlatformClient;
  let mockConfig: DRSConfig;
  let consoleLogSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    // Mock console.log to suppress output during tests
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    mockPlatformClient = {
      getPullRequest: vi.fn().mockResolvedValue({
        number: 123,
        title: 'Test PR',
        author: 'test-user',
        sourceBranch: 'feature',
        targetBranch: 'main',
        platformData: {},
      }),
      getChangedFiles: vi.fn().mockResolvedValue([
        { filename: 'src/test.ts', status: 'modified', patch: '+added line' },
        { filename: 'src/utils.ts', status: 'added', patch: '+new file' },
      ]),
      getComments: vi.fn().mockResolvedValue([]),
      getInlineComments: vi.fn().mockResolvedValue([]),
      createComment: vi.fn(),
      updateComment: vi.fn(),
      createBulkInlineComments: vi.fn(),
      addLabels: vi.fn(),
    } as unknown as PlatformClient;

    mockConfig = {
      review: {
        agents: ['security', 'quality'],
        mode: 'multi-agent',
        ignorePatterns: [],
        includePatterns: [],
      },
      contextCompression: {
        maxTokens: 10000,
      },
      opencode: {},
      gitlab: {
        url: 'https://gitlab.com',
        token: 'mock-token',
      },
      github: {
        token: 'mock-token',
      },
    } as unknown as DRSConfig;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe('executeUnifiedReview', () => {
    it('should execute a complete review successfully', async () => {
      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
        workingDir: '/test/dir',
      };

      await executeUnifiedReview(mockConfig, options);

      expect(mockPlatformClient.getPullRequest).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockPlatformClient.getChangedFiles).toHaveBeenCalledWith('owner/repo', 123);
    });

    it('should use pre-fetched PR and file data when provided', async () => {
      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
        pullRequest: {
          number: 123,
          title: 'Preloaded PR',
          author: 'test-user',
          sourceBranch: 'feature',
          targetBranch: 'main',
          headSha: 'head-sha',
          platformData: {},
        },
        changedFiles: [
          {
            filename: 'src/preloaded.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            patch: '+preloaded change',
          },
        ],
      };

      await executeUnifiedReview(mockConfig, options);

      expect(mockPlatformClient.getPullRequest).not.toHaveBeenCalled();
      expect(mockPlatformClient.getChangedFiles).not.toHaveBeenCalled();
    });

    it('should include platform patches in review instructions when available', async () => {
      const { buildBaseInstructions } = await import('./review-core.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(buildBaseInstructions).toHaveBeenCalledWith(
        'PR/MR #123',
        expect.arrayContaining([
          expect.objectContaining({ filename: 'src/test.ts', patch: '+added line' }),
          expect.objectContaining({ filename: 'src/utils.ts', patch: '+new file' }),
        ]),
        'git diff origin/main origin/feature -- <file>',
        ''
      );
    });

    it('uses only unified model IDs for budget sizing in unified mode', async () => {
      const { getModelOverrides, getUnifiedModelOverride } = await import('./config.js');
      const { connectToRuntime } = await import('./review-orchestrator.js');

      vi.mocked(getModelOverrides).mockReturnValueOnce({
        'review/security': 'provider/small-8k',
      });
      vi.mocked(getUnifiedModelOverride).mockReturnValueOnce({
        'review/unified-reviewer': 'provider/large-200k',
      });

      const mockRuntimeClient = {
        shutdown: vi.fn().mockResolvedValue(undefined),
        getMinContextWindow: vi.fn(() => undefined),
      };
      vi.mocked(connectToRuntime).mockResolvedValueOnce(mockRuntimeClient as any);

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(
        {
          ...mockConfig,
          review: {
            ...mockConfig.review,
            mode: 'unified',
          },
        } as DRSConfig,
        options
      );

      expect(mockRuntimeClient.getMinContextWindow).toHaveBeenCalledWith(['provider/large-200k']);
    });

    it('uses only multi-agent model IDs for budget sizing in multi-agent mode', async () => {
      const { getModelOverrides, getUnifiedModelOverride } = await import('./config.js');
      const { connectToRuntime } = await import('./review-orchestrator.js');

      vi.mocked(getModelOverrides).mockReturnValueOnce({
        'review/security': 'provider/large-200k',
      });
      vi.mocked(getUnifiedModelOverride).mockReturnValueOnce({
        'review/unified-reviewer': 'provider/small-8k',
      });

      const mockRuntimeClient = {
        shutdown: vi.fn().mockResolvedValue(undefined),
        getMinContextWindow: vi.fn(() => undefined),
      };
      vi.mocked(connectToRuntime).mockResolvedValueOnce(mockRuntimeClient as any);

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(
        {
          ...mockConfig,
          review: {
            ...mockConfig.review,
            mode: 'multi-agent',
          },
        } as DRSConfig,
        options
      );

      expect(mockRuntimeClient.getMinContextWindow).toHaveBeenCalledWith(['provider/large-200k']);
    });

    it('should enforce repository branch match', async () => {
      const { enforceRepoBranchMatch } = await import('./repository-validator.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
        workingDir: '/test/dir',
      };

      await executeUnifiedReview(mockConfig, options);

      expect(enforceRepoBranchMatch).toHaveBeenCalledWith(
        '/test/dir',
        'owner/repo',
        expect.objectContaining({ number: 123 }),
        expect.objectContaining({
          skipRepoCheck: undefined,
          skipBranchCheck: undefined,
        })
      );
    });

    it('should filter ignored files', async () => {
      const { filterIgnoredFiles } = await import('./review-orchestrator.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(filterIgnoredFiles).toHaveBeenCalledWith(
        expect.arrayContaining(['src/test.ts', 'src/utils.ts']),
        mockConfig
      );
    });

    it('should skip review when no files changed', async () => {
      mockPlatformClient.getChangedFiles = vi.fn().mockResolvedValue([]);

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      const { runReviewPipeline } = await import('./review-core.js');
      expect(runReviewPipeline).not.toHaveBeenCalled();
    });

    it('should skip deleted files', async () => {
      mockPlatformClient.getChangedFiles = vi.fn().mockResolvedValue([
        { filename: 'src/deleted.ts', status: 'removed', patch: '' },
        { filename: 'src/added.ts', status: 'added', patch: '+new' },
      ]);

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      const { filterIgnoredFiles } = await import('./review-orchestrator.js');
      expect(filterIgnoredFiles).toHaveBeenCalledWith(
        expect.not.arrayContaining(['src/deleted.ts']),
        mockConfig
      );
    });

    it('should post comments when postComments is true', async () => {
      const { postReviewComments } = await import('./comment-poster.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: true,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(postReviewComments).toHaveBeenCalled();
    });

    it('should not post comments when postComments is false', async () => {
      const { postReviewComments } = await import('./comment-poster.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(postReviewComments).not.toHaveBeenCalled();
    });

    it('should generate code quality report when requested', async () => {
      const { writeFile } = await import('fs/promises');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
        codeQualityReport: 'report.json',
        workingDir: '/test/dir',
      };

      await executeUnifiedReview(mockConfig, options);

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('report.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should generate JSON output when requested', async () => {
      const { formatReviewJson, printReviewJson } = await import('./json-output.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
        jsonOutput: true,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(formatReviewJson).toHaveBeenCalled();
      expect(printReviewJson).toHaveBeenCalled();
    });

    it('should write JSON output to file when outputPath provided', async () => {
      const { writeReviewJson } = await import('./json-output.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
        outputPath: 'output.json',
        workingDir: '/test/dir',
      };

      await executeUnifiedReview(mockConfig, options);

      expect(writeReviewJson).toHaveBeenCalledWith(expect.any(Object), 'output.json', '/test/dir');
    });

    it('should exit with error code when critical issues found', async () => {
      const { runReviewPipeline } = await import('./review-core.js');
      vi.mocked(runReviewPipeline).mockResolvedValueOnce({
        summary: {
          issuesFound: 1,
          filesReviewed: 1,
          bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0 },
          byCategory: { SECURITY: 1, QUALITY: 0, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
        },
        issues: [],
        changeSummary: undefined,
        filesReviewed: 1,
        agentResults: [],
      });

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should run description generation when enabled', async () => {
      const { runDescribeIfEnabled } = await import('./description-executor.js');

      const configWithDescribe = {
        ...mockConfig,
        review: {
          ...mockConfig.review,
          describe: {
            enabled: true,
            postDescription: true,
          },
        },
      };

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(configWithDescribe, options);

      expect(runDescribeIfEnabled).toHaveBeenCalled();
    });

    it('should use default working directory if not provided', async () => {
      const { enforceRepoBranchMatch } = await import('./repository-validator.js');

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(enforceRepoBranchMatch).toHaveBeenCalledWith(
        process.cwd(),
        'owner/repo',
        expect.any(Object),
        expect.objectContaining({
          skipRepoCheck: undefined,
          skipBranchCheck: undefined,
        })
      );
    });

    it('should shutdown runtime client on completion', async () => {
      const { connectToRuntime } = await import('./review-orchestrator.js');
      const mockRuntimeClient = {
        shutdown: vi.fn().mockResolvedValue(undefined),
        getMinContextWindow: vi.fn(() => undefined),
      };
      vi.mocked(connectToRuntime).mockResolvedValueOnce(mockRuntimeClient as any);

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await executeUnifiedReview(mockConfig, options);

      expect(mockRuntimeClient.shutdown).toHaveBeenCalled();
    });

    it('should shutdown runtime client on error', async () => {
      const { runReviewPipeline } = await import('./review-core.js');
      const { connectToRuntime } = await import('./review-orchestrator.js');

      const mockRuntimeClient = {
        shutdown: vi.fn().mockResolvedValue(undefined),
        getMinContextWindow: vi.fn(() => undefined),
      };
      vi.mocked(connectToRuntime).mockResolvedValueOnce(mockRuntimeClient as any);
      vi.mocked(runReviewPipeline).mockRejectedValueOnce(new Error('Test error'));

      const options: UnifiedReviewOptions = {
        platformClient: mockPlatformClient,
        projectId: 'owner/repo',
        prNumber: 123,
        postComments: false,
      };

      await expect(executeUnifiedReview(mockConfig, options)).rejects.toThrow('Test error');
      expect(mockRuntimeClient.shutdown).toHaveBeenCalled();
    });
  });
});
