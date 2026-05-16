import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { runWorkflow } from './workflow.js';

const mocks = vi.hoisted(() => ({
  git: {
    checkIsRepo: vi.fn(async () => true),
    diff: vi.fn(async () => 'diff --git a/src/app.ts b/src/app.ts'),
  },
  simpleGit: vi.fn(),
  parseDiff: vi.fn(() => [{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }]),
  getChangedFiles: vi.fn(() => ['src/app.ts']),
  getFilesWithDiffs: vi.fn(() => [{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }]),
  executeReview: vi.fn(async (_config: unknown, source: { files: string[] }) => ({
    issues: [],
    summary: {
      filesReviewed: source.files.length,
      issuesFound: 0,
      bySeverity: {},
      byCategory: {},
    },
    filesReviewed: source.files.length,
  })),
  runAgent: vi.fn(async (_config, agent: string, options: { prompt?: string }) => ({
    timestamp: '2026-06-16T00:00:00.000Z',
    agent,
    response: `${agent}: ${options.prompt ?? 'configured prompt'}`,
    usage: {
      agent,
      success: true,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      cost: 0,
      messages: 1,
    },
  })),
}));

mocks.simpleGit.mockReturnValue(mocks.git);

vi.mock('simple-git', () => ({
  default: mocks.simpleGit,
}));

vi.mock('./run-agent.js', () => ({
  runAgent: mocks.runAgent,
}));

vi.mock('../lib/diff-parser.js', () => ({
  parseDiff: mocks.parseDiff,
  getChangedFiles: mocks.getChangedFiles,
  getFilesWithDiffs: mocks.getFilesWithDiffs,
}));

vi.mock('../lib/review-orchestrator.js', () => ({
  executeReview: mocks.executeReview,
}));

const baseConfig = {
  pi: {},
  agents: { default: { model: 'provider/default-model', skills: [] } },
  gitlab: { url: '', token: '' },
  github: { token: '' },
  review: {
    agents: ['review/security'],
    ignorePatterns: [],
  },
} as unknown as DRSConfig;

describe('workflow runner', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.simpleGit.mockReturnValue(mocks.git);
    mocks.git.checkIsRepo.mockResolvedValue(true);
    mocks.git.diff.mockResolvedValue('diff --git a/src/app.ts b/src/app.ts');
    mocks.parseDiff.mockReturnValue([{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }]);
    mocks.getChangedFiles.mockReturnValue(['src/app.ts']);
    mocks.getFilesWithDiffs.mockReturnValue([
      { filename: 'src/app.ts', patch: '@@ +1 @@\n+change' },
    ]);
    mocks.executeReview.mockImplementation(
      async (_config: unknown, source: { files: string[] }) => ({
        issues: [],
        summary: {
          filesReviewed: source.files.length,
          issuesFound: 0,
          bySeverity: {},
          byCategory: {},
        },
        filesReviewed: source.files.length,
      })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs agent and write nodes in dependency order', async () => {
    const projectRoot = createTempDir('drs-workflow-');
    const config = {
      ...baseConfig,
      workflows: {
        release: {
          inputs: {
            diff: 'Diff text',
          },
          nodes: {
            summarize: {
              agent: 'task/summarizer',
              input: 'Summarize {{inputs.diff}}',
              output: 'summary',
            },
            writeSummary: {
              action: 'write',
              needs: ['summarize'],
              input: 'Summary:\n{{artifacts.summary}}',
              writes: 'out/summary.md',
              output: 'written',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'release', {
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledWith(
      config,
      'task/summarizer',
      expect.objectContaining({
        prompt: 'Summarize Diff text',
        quiet: true,
        allowImplicitStdin: false,
        ignoreConfiguredOutput: true,
      })
    );
    expect(readFileSync(join(projectRoot, 'out/summary.md'), 'utf-8')).toBe(
      'Summary:\ntask/summarizer: Summarize Diff text'
    );
    expect(result.output).toBe('Summary:\ntask/summarizer: Summarize Diff text');
  });

  it('lets CLI-style inputs override configured inputs', async () => {
    const projectRoot = createTempDir('drs-workflow-inputs-');
    writeFileSync(join(projectRoot, 'diff.md'), 'File diff');
    const config = {
      ...baseConfig,
      workflows: {
        describe: {
          inputs: {
            diff: 'Configured diff',
            title: 'Configured title',
          },
          nodes: {
            summarize: {
              agent: 'task/summarizer',
              input: '{{inputs.title}}\n{{inputs.diff}}',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'describe', {
      inputs: { title: 'CLI title' },
      inputFiles: { diff: 'diff.md' },
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledWith(
      config,
      'task/summarizer',
      expect.objectContaining({
        prompt: 'CLI title\nFile diff',
      })
    );
  });

  it('runs agentsFrom review.agents as a multi-agent node', async () => {
    const config = {
      ...baseConfig,
      review: {
        agents: ['review/security', { name: 'review/quality' }],
        ignorePatterns: [],
      },
      workflows: {
        review: {
          inputs: {
            diff: 'Diff text',
          },
          nodes: {
            reviewers: {
              agentsFrom: 'review.agents',
              input: 'Review {{inputs.diff}}',
              output: 'reviewResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'review', {
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent).toHaveBeenNthCalledWith(
      1,
      config,
      'review/security',
      expect.objectContaining({ prompt: 'Review Diff text' })
    );
    expect(mocks.runAgent).toHaveBeenNthCalledWith(
      2,
      config,
      'review/quality',
      expect.objectContaining({ prompt: 'Review Diff text' })
    );
    expect(result.artifacts.reviewResult).toContain('## review/security');
    expect(result.artifacts.reviewResult).toContain('## review/quality');
  });

  it('loads local git diff as an action artifact', async () => {
    const projectRoot = createTempDir('drs-workflow-git-diff-');
    const config = {
      ...baseConfig,
      workflows: {
        localReview: {
          nodes: {
            diff: {
              action: 'git-diff',
              with: { staged: true },
              output: 'localDiff',
            },
            summarize: {
              agent: 'task/summarizer',
              needs: ['diff'],
              input: 'Summarize {{artifacts.localDiff}}',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'localReview', {
      workingDir: projectRoot,
    });

    expect(mocks.simpleGit).toHaveBeenCalledWith({ baseDir: projectRoot });
    expect(mocks.git.diff).toHaveBeenCalledWith(['--cached']);
    expect(mocks.runAgent).toHaveBeenCalledWith(
      config,
      'task/summarizer',
      expect.objectContaining({
        prompt: 'Summarize diff --git a/src/app.ts b/src/app.ts',
      })
    );
  });

  it('loads a local change source and reviews it', async () => {
    const projectRoot = createTempDir('drs-workflow-review-');
    const config = {
      ...baseConfig,
      workflows: {
        localReview: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'local', staged: true },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewResult',
              writes: '.drs/review-result.json',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'localReview', {
      workingDir: projectRoot,
      debug: true,
      thinkingLevel: 'high',
    });

    expect(mocks.git.diff).toHaveBeenCalledWith(['--cached']);
    expect(mocks.parseDiff).toHaveBeenCalledWith('diff --git a/src/app.ts b/src/app.ts');
    expect(mocks.executeReview).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: 'Local staged diff',
        files: ['src/app.ts'],
        filesWithDiffs: [{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }],
        workingDir: projectRoot,
        staged: true,
        debug: true,
        thinkingLevel: 'high',
      })
    );
    expect(result.artifacts.reviewResult).toMatchObject({ filesReviewed: 1 });
    expect(
      JSON.parse(readFileSync(join(projectRoot, '.drs/review-result.json'), 'utf-8'))
    ).toMatchObject({
      filesReviewed: 1,
    });
  });

  it('rejects dependency cycles', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        cyclic: {
          nodes: {
            first: { agent: 'task/first', input: 'first', needs: ['second'] },
            second: { agent: 'task/second', input: 'second', needs: ['first'] },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'cyclic')).rejects.toThrow('dependency cycle');
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it('rejects unknown template references', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        badTemplate: {
          nodes: {
            summarize: { agent: 'task/summarizer', input: '{{inputs.missing}}' },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'badTemplate')).rejects.toThrow(
      'Unknown workflow template value "{{inputs.missing}}"'
    );
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });
});
