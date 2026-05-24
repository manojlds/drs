import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { exitProcess } from '../lib/exit.js';
import { runWorkflow } from './workflow.js';

const mocks = vi.hoisted(() => {
  const githubAdapter = {
    getPullRequest: vi.fn(),
    getChangedFiles: vi.fn(),
    getComments: vi.fn(),
    getInlineComments: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    createBulkInlineComments: vi.fn(),
    addLabels: vi.fn(),
  };
  const gitlabAdapter = {
    getPullRequest: vi.fn(),
    getChangedFiles: vi.fn(),
    getComments: vi.fn(),
    getInlineComments: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    createBulkInlineComments: vi.fn(),
    addLabels: vi.fn(),
  };

  return {
    git: {
      checkIsRepo: vi.fn(async () => true),
      diff: vi.fn(async () => 'diff --git a/src/app.ts b/src/app.ts'),
      add: vi.fn(async () => ''),
      commit: vi.fn(async () => ({
        commit: 'abc1234',
        summary: {
          changes: 1,
          insertions: 2,
          deletions: 0,
        },
      })),
    },
    simpleGit: vi.fn(),
    createGitHubClient: vi.fn(() => ({ platform: 'github' })),
    GitHubPlatformAdapter: vi.fn(() => githubAdapter),
    githubAdapter,
    createGitLabClient: vi.fn(() => ({ platform: 'gitlab' })),
    GitLabPlatformAdapter: vi.fn(() => gitlabAdapter),
    gitlabAdapter,
    parseDiff: vi.fn(() => [{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }]),
    getChangedFiles: vi.fn(() => ['src/app.ts']),
    getFilesWithDiffs: vi.fn(() => [{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }]),
    executeReview: vi.fn(async (_config: unknown, source: { files: string[] }) => ({
      issues: [] as unknown[],
      summary: {
        filesReviewed: source.files.length,
        issuesFound: 0,
        bySeverity: {} as Record<string, number>,
        byCategory: {} as Record<string, number>,
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
  };
});

mocks.simpleGit.mockReturnValue(mocks.git);

vi.mock('simple-git', () => ({
  default: mocks.simpleGit,
}));

vi.mock('../github/client.js', () => ({
  createGitHubClient: mocks.createGitHubClient,
}));

vi.mock('../github/platform-adapter.js', () => ({
  GitHubPlatformAdapter: mocks.GitHubPlatformAdapter,
}));

vi.mock('../gitlab/client.js', () => ({
  createGitLabClient: mocks.createGitLabClient,
}));

vi.mock('../gitlab/platform-adapter.js', () => ({
  GitLabPlatformAdapter: mocks.GitLabPlatformAdapter,
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

  function createMockAgentResult(agent: string, response: string) {
    return {
      timestamp: '2026-06-16T00:00:00.000Z',
      agent,
      response,
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
    };
  }

  function timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.simpleGit.mockReturnValue(mocks.git);
    mocks.git.checkIsRepo.mockResolvedValue(true);
    mocks.git.diff.mockResolvedValue('diff --git a/src/app.ts b/src/app.ts');
    mocks.git.add.mockResolvedValue('');
    mocks.git.commit.mockResolvedValue({
      commit: 'abc1234',
      summary: {
        changes: 1,
        insertions: 2,
        deletions: 0,
      },
    });
    mocks.parseDiff.mockReturnValue([{ filename: 'src/app.ts', patch: '@@ +1 @@\n+change' }]);
    mocks.getChangedFiles.mockReturnValue(['src/app.ts']);
    mocks.getFilesWithDiffs.mockReturnValue([
      { filename: 'src/app.ts', patch: '@@ +1 @@\n+change' },
    ]);
    mocks.createGitHubClient.mockReturnValue({ platform: 'github' });
    mocks.GitHubPlatformAdapter.mockReturnValue(mocks.githubAdapter);
    mocks.githubAdapter.getPullRequest.mockResolvedValue({
      number: 7,
      title: 'GitHub PR',
      author: 'octocat',
      sourceBranch: 'feature',
      targetBranch: 'main',
      headSha: 'abc123',
    });
    mocks.githubAdapter.getChangedFiles.mockResolvedValue([
      {
        filename: 'src/github.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ +1 @@\n+github',
      },
    ]);
    mocks.githubAdapter.getComments.mockResolvedValue([]);
    mocks.githubAdapter.getInlineComments.mockResolvedValue([]);
    mocks.githubAdapter.createComment.mockResolvedValue(undefined);
    mocks.githubAdapter.updateComment.mockResolvedValue(undefined);
    mocks.githubAdapter.deleteComment.mockResolvedValue(undefined);
    mocks.githubAdapter.createBulkInlineComments.mockResolvedValue(undefined);
    mocks.githubAdapter.addLabels.mockResolvedValue(undefined);
    mocks.createGitLabClient.mockReturnValue({ platform: 'gitlab' });
    mocks.GitLabPlatformAdapter.mockReturnValue(mocks.gitlabAdapter);
    mocks.gitlabAdapter.getPullRequest.mockResolvedValue({
      number: 8,
      title: 'GitLab MR',
      author: 'gitlab-user',
      sourceBranch: 'feature',
      targetBranch: 'main',
      headSha: 'def456',
    });
    mocks.gitlabAdapter.getChangedFiles.mockResolvedValue([
      {
        filename: 'src/gitlab.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        patch: '@@ +1 @@\n+gitlab',
      },
    ]);
    mocks.gitlabAdapter.getComments.mockResolvedValue([]);
    mocks.gitlabAdapter.getInlineComments.mockResolvedValue([]);
    mocks.gitlabAdapter.createComment.mockResolvedValue(undefined);
    mocks.gitlabAdapter.updateComment.mockResolvedValue(undefined);
    mocks.gitlabAdapter.deleteComment.mockResolvedValue(undefined);
    mocks.gitlabAdapter.createBulkInlineComments.mockResolvedValue(undefined);
    mocks.gitlabAdapter.addLabels.mockResolvedValue(undefined);
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

  it('rejects writes paths that render to empty strings', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        emptyWrite: {
          inputs: {
            outputPath: '',
          },
          nodes: {
            writeSummary: {
              action: 'write',
              input: 'content',
              writes: '{{inputs.outputPath}}',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'emptyWrite')).rejects.toThrow(
      'Workflow node "writeSummary" writes resolved to an empty path.'
    );
  });

  it('uses strict boolean checks for node JSON writes', async () => {
    const projectRoot = createTempDir('drs-workflow-json-');
    const config = {
      ...baseConfig,
      workflows: {
        jsonFlag: {
          nodes: {
            summarize: {
              agent: 'task/summarizer',
              input: 'Summarize',
              writes: 'summary.txt',
              json: 'false',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'jsonFlag', { workingDir: projectRoot });

    expect(readFileSync(join(projectRoot, 'summary.txt'), 'utf-8')).toBe(
      'task/summarizer: Summarize'
    );
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

  it('runs agentsFrom agents concurrently', async () => {
    let resolveSecurity: () => void = () => {};
    let resolveQuality: () => void = () => {};
    let resolveBothStarted: () => void = () => {};
    const starts: string[] = [];
    const securityDone = new Promise<void>((resolve) => {
      resolveSecurity = resolve;
    });
    const qualityDone = new Promise<void>((resolve) => {
      resolveQuality = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });

    mocks.runAgent.mockImplementation(async (_config: unknown, agent: string) => {
      starts.push(agent);
      if (starts.length === 2) {
        resolveBothStarted();
      }

      await (agent === 'review/security' ? securityDone : qualityDone);
      return createMockAgentResult(agent, `${agent} done`);
    });

    const config = {
      ...baseConfig,
      review: {
        agents: ['review/security', 'review/quality'],
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

    const runPromise = runWorkflow(config, 'review', { workingDir: process.cwd() });
    await Promise.race([bothStarted, timeoutAfter(250)]);
    resolveSecurity();
    resolveQuality();

    const result = await runPromise;
    expect(starts).toEqual(['review/security', 'review/quality']);
    expect(result.artifacts.reviewResult).toContain('review/security done');
    expect(result.artifacts.reviewResult).toContain('review/quality done');
  });

  it('runs independent workflow nodes concurrently', async () => {
    let resolveOne: () => void = () => {};
    let resolveTwo: () => void = () => {};
    let resolveBothStarted: () => void = () => {};
    const starts: string[] = [];
    const oneDone = new Promise<void>((resolve) => {
      resolveOne = resolve;
    });
    const twoDone = new Promise<void>((resolve) => {
      resolveTwo = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });

    mocks.runAgent.mockImplementation(async (_config: unknown, agent: string) => {
      starts.push(agent);
      if (starts.length === 2) {
        resolveBothStarted();
      }

      await (agent === 'task/one' ? oneDone : twoDone);
      return createMockAgentResult(agent, `${agent} done`);
    });

    const config = {
      ...baseConfig,
      workflows: {
        parallel: {
          nodes: {
            one: { agent: 'task/one', input: 'one', output: 'one' },
            two: { agent: 'task/two', input: 'two', output: 'two' },
            join: {
              action: 'write',
              needs: ['one', 'two'],
              input: '{{artifacts.one}}\n{{artifacts.two}}',
              writes: 'joined.txt',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const projectRoot = createTempDir('drs-workflow-parallel-');
    const runPromise = runWorkflow(config, 'parallel', { workingDir: projectRoot });
    await Promise.race([bothStarted, timeoutAfter(250)]);
    resolveOne();
    resolveTwo();

    await runPromise;
    expect(starts).toEqual(['task/one', 'task/two']);
    expect(readFileSync(join(projectRoot, 'joined.txt'), 'utf-8')).toBe(
      'task/one done\ntask/two done'
    );
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

  it('stages paths with a git-add action', async () => {
    const projectRoot = createTempDir('drs-workflow-git-add-');
    const config = {
      ...baseConfig,
      workflows: {
        stageChangelog: {
          nodes: {
            stage: {
              action: 'git-add',
              with: { paths: 'CHANGELOG.md, README.md' },
              output: 'stagedPaths',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'stageChangelog', {
      workingDir: projectRoot,
    });

    expect(mocks.git.add).toHaveBeenCalledWith(['CHANGELOG.md', 'README.md']);
    expect(result.artifacts.stagedPaths).toEqual(['CHANGELOG.md', 'README.md']);
  });

  it('commits only configured paths with a git-commit action', async () => {
    const projectRoot = createTempDir('drs-workflow-git-commit-');
    const config = {
      ...baseConfig,
      workflows: {
        commitChangelog: {
          nodes: {
            commit: {
              action: 'git-commit',
              with: {
                paths: 'CHANGELOG.md',
                message: 'docs: update changelog',
              },
              output: 'commitResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'commitChangelog', {
      workingDir: projectRoot,
    });

    expect(mocks.git.add).toHaveBeenCalledWith(['CHANGELOG.md']);
    expect(mocks.git.commit).toHaveBeenCalledWith('docs: update changelog', ['CHANGELOG.md']);
    expect(result.artifacts.commitResult).toMatchObject({
      commit: 'abc1234',
      message: 'docs: update changelog',
      paths: ['CHANGELOG.md'],
    });
  });

  it('rejects git action paths outside the working directory', async () => {
    const projectRoot = createTempDir('drs-workflow-git-path-');
    const config = {
      ...baseConfig,
      workflows: {
        unsafeStage: {
          nodes: {
            stage: {
              action: 'git-add',
              with: { path: '../outside.md' },
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(
      runWorkflow(config, 'unsafeStage', {
        workingDir: projectRoot,
      })
    ).rejects.toThrow('Refusing to access outside working directory');
    expect(mocks.git.add).not.toHaveBeenCalled();
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

  it('suppresses review action logs when workflow JSON output is enabled', async () => {
    const logSpy = vi.mocked(console.log);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.executeReview.mockImplementation(
      async (_config: unknown, source: { files: string[] }) => {
        console.log('review progress');
        console.warn('review warning');
        return {
          issues: [],
          summary: {
            filesReviewed: source.files.length,
            issuesFound: 0,
            bySeverity: {},
            byCategory: {},
          },
          filesReviewed: source.files.length,
        };
      }
    );

    const config = {
      ...baseConfig,
      workflows: {
        localReview: {
          nodes: {
            change: {
              action: 'change-source',
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'localReview', {
      jsonOutput: true,
      workingDir: process.cwd(),
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(logSpy.mock.calls[0][0]))).not.toThrow();
  });

  it('keeps review action log suppression isolated for concurrent JSON nodes', async () => {
    const logSpy = vi.mocked(console.log);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveFirstStarted: () => void = () => {};
    let resolveFirstCanReturn: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const firstCanReturn = new Promise<void>((resolve) => {
      resolveFirstCanReturn = resolve;
    });
    let reviewCalls = 0;

    mocks.executeReview.mockImplementation(
      async (_config: unknown, source: { files: string[] }) => {
        const callNumber = ++reviewCalls;
        if (callNumber === 1) {
          console.log('first review progress');
          resolveFirstStarted();
          await firstCanReturn;
        } else {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
          console.log('second review progress');
          console.warn('second review warning');
        }

        return {
          issues: [],
          summary: {
            filesReviewed: source.files.length,
            issuesFound: 0,
            bySeverity: {},
            byCategory: {},
          },
          filesReviewed: source.files.length,
        };
      }
    );

    const config = {
      ...baseConfig,
      workflows: {
        concurrentReview: {
          nodes: {
            change: {
              action: 'change-source',
              output: 'change',
            },
            reviewOne: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewOneResult',
            },
            reviewTwo: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewTwoResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const runPromise = runWorkflow(config, 'concurrentReview', {
      jsonOutput: true,
      workingDir: process.cwd(),
    });
    await Promise.race([firstStarted, timeoutAfter(250)]);
    resolveFirstCanReturn();
    await runPromise;

    expect(reviewCalls).toBe(2);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(logSpy.mock.calls[0][0]))).not.toThrow();
    expect(console.log).toBe(logSpy);
  });

  it('converts review action process exits into workflow errors', async () => {
    mocks.executeReview.mockImplementation(async () => {
      exitProcess(1);
    });

    const config = {
      ...baseConfig,
      workflows: {
        localReview: {
          nodes: {
            change: {
              action: 'change-source',
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'localReview')).rejects.toThrow(
      'Workflow review node "review" failed: all review agents failed.'
    );
  });

  it('loads a GitHub PR change source and reviews it', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        githubReview: {
          inputs: {
            owner: '',
            repo: '',
            pr: '',
          },
          nodes: {
            change: {
              action: 'change-source',
              with: {
                type: 'github-pr',
                owner: '{{inputs.owner}}',
                repo: '{{inputs.repo}}',
                pr: '{{inputs.pr}}',
              },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'githubReview', {
      inputs: { owner: 'octocat', repo: 'hello-world', pr: '7' },
      workingDir: process.cwd(),
    });

    expect(mocks.createGitHubClient).toHaveBeenCalled();
    expect(mocks.GitHubPlatformAdapter).toHaveBeenCalled();
    expect(mocks.githubAdapter.getPullRequest).toHaveBeenCalledWith('octocat/hello-world', 7);
    expect(mocks.githubAdapter.getChangedFiles).toHaveBeenCalledWith('octocat/hello-world', 7);
    expect(mocks.executeReview).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: 'GitHub PR octocat/hello-world#7',
        files: ['src/github.ts'],
        filesWithDiffs: [{ filename: 'src/github.ts', patch: '@@ +1 @@\n+github' }],
        context: expect.objectContaining({
          platform: 'github',
          projectId: 'octocat/hello-world',
        }),
      })
    );
  });

  it('updates an existing marked platform comment', async () => {
    mocks.githubAdapter.getComments.mockResolvedValue([
      { id: 9, body: '<!-- drs-comment-id: release-notes -->\nold body' },
    ]);
    const config = {
      ...baseConfig,
      workflows: {
        postComment: {
          nodes: {
            comment: {
              action: 'post-comment',
              input: 'new body',
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                pr: 7,
                marker: 'release-notes',
              },
              output: 'commentResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'postComment', { workingDir: process.cwd() });

    expect(mocks.githubAdapter.updateComment).toHaveBeenCalledWith(
      'octocat/hello-world',
      7,
      9,
      '<!-- drs-comment-id: release-notes -->\nnew body'
    );
    expect(mocks.githubAdapter.createComment).not.toHaveBeenCalled();
    expect(result.artifacts.commentResult).toMatchObject({
      platform: 'github',
      projectId: 'octocat/hello-world',
      prNumber: 7,
      marker: 'release-notes',
      operation: 'updated',
    });
  });

  it('posts GitHub review comments from workflow review artifacts', async () => {
    mocks.githubAdapter.getChangedFiles.mockResolvedValue([
      {
        filename: 'src/github.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+github',
      },
    ]);
    mocks.executeReview.mockImplementation(async () => ({
      issues: [
        {
          category: 'QUALITY',
          severity: 'HIGH',
          title: 'Validate input',
          file: 'src/github.ts',
          line: 1,
          problem: 'Input is not validated.',
          solution: 'Validate it before use.',
          agent: 'review/quality',
        },
      ],
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      filesReviewed: 1,
    }));
    const config = {
      ...baseConfig,
      workflows: {
        githubReview: {
          nodes: {
            change: {
              action: 'change-source',
              with: {
                type: 'github-pr',
                owner: 'octocat',
                repo: 'hello-world',
                pr: 7,
              },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            post: {
              action: 'post-review-comments',
              needs: ['review'],
              with: {
                source: 'change',
                review: 'review',
              },
              output: 'postResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'githubReview', { workingDir: process.cwd() });

    expect(mocks.githubAdapter.deleteComment).not.toHaveBeenCalled();
    expect(mocks.githubAdapter.createComment).toHaveBeenCalledWith(
      'octocat/hello-world',
      7,
      expect.stringContaining('<!-- drs-comment-id: drs-review-summary -->')
    );
    expect(mocks.githubAdapter.createBulkInlineComments).toHaveBeenCalledWith(
      'octocat/hello-world',
      7,
      [
        expect.objectContaining({
          body: expect.stringContaining(
            '<!-- issue-fp: src/github.ts:1:QUALITY:Validate input -->'
          ),
          position: {
            path: 'src/github.ts',
            line: 1,
            commitSha: 'abc123',
          },
        }),
      ]
    );
    expect(mocks.githubAdapter.addLabels).toHaveBeenCalledWith('octocat/hello-world', 7, [
      'ai-reviewed',
    ]);
    expect(result.artifacts.postResult).toMatchObject({
      platform: 'github',
      projectId: 'octocat/hello-world',
      prNumber: 7,
      issues: 1,
    });
  });

  it('loads a GitLab MR change source and reviews it', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        gitlabReview: {
          inputs: {
            project: '',
            mr: '',
          },
          nodes: {
            change: {
              action: 'change-source',
              with: {
                type: 'gitlab-mr',
                project: '{{inputs.project}}',
                mr: '{{inputs.mr}}',
              },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewResult',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'gitlabReview', {
      inputs: { project: 'group/repo', mr: '8' },
      workingDir: process.cwd(),
    });

    expect(mocks.createGitLabClient).toHaveBeenCalled();
    expect(mocks.GitLabPlatformAdapter).toHaveBeenCalled();
    expect(mocks.gitlabAdapter.getPullRequest).toHaveBeenCalledWith('group/repo', 8);
    expect(mocks.gitlabAdapter.getChangedFiles).toHaveBeenCalledWith('group/repo', 8);
    expect(mocks.executeReview).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: 'GitLab MR group/repo!8',
        files: ['src/gitlab.ts'],
        filesWithDiffs: [{ filename: 'src/gitlab.ts', patch: '@@ +1 @@\n+gitlab' }],
        context: expect.objectContaining({
          platform: 'gitlab',
          projectId: 'group/repo',
        }),
      })
    );
  });

  it('rejects empty GitLab MR aliases without falling through to mrIid', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        gitlabReview: {
          inputs: {
            project: 'group/repo',
            mr: '',
          },
          nodes: {
            change: {
              action: 'change-source',
              with: {
                type: 'gitlab-mr',
                project: '{{inputs.project}}',
                mr: '{{inputs.mr}}',
              },
              output: 'change',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'gitlabReview')).rejects.toThrow(
      'Workflow node "change" must define with.mr.'
    );
    expect(mocks.gitlabAdapter.getPullRequest).not.toHaveBeenCalled();
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

  it('rejects workflows with invalid nodes config', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        invalid: {
          nodes: 'not an object',
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'invalid')).rejects.toThrow(
      'Workflow "invalid" must define at least one node.'
    );
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
