import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type DRSConfig } from '../lib/config.js';
import { exitProcess } from '../lib/exit.js';
import { runWorkflow, listWorkflows, showWorkflow } from './workflow.js';

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
      raw: vi.fn(async (_args?: string[]) => ''),
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
    runtimeClient: {
      shutdown: vi.fn(async () => undefined),
    },
    connectToRuntime: vi.fn(),
    runDescribeIfEnabled: vi.fn(),
    enforceRepoBranchMatch: vi.fn(async () => undefined),
    executeReview: vi.fn(async (_config: unknown, source: { files: string[] }) => ({
      issues: [] as unknown[],
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
  connectToRuntime: mocks.connectToRuntime,
  executeReview: mocks.executeReview,
  filterIgnoredFiles: (files: string[], config: DRSConfig) =>
    files.filter((file) => !(config.review.ignorePatterns ?? []).includes(file)),
}));

vi.mock('../lib/description-executor.js', () => ({
  runDescribeIfEnabled: mocks.runDescribeIfEnabled,
}));

vi.mock('../lib/repository-validator.js', () => ({
  enforceRepoBranchMatch: mocks.enforceRepoBranchMatch,
  resolveBaseBranch: (_baseBranch?: string, targetBranch?: string) => ({
    resolvedBaseBranch: targetBranch ? `origin/${targetBranch}` : undefined,
    source: targetBranch ? 'pr:targetBranch' : undefined,
  }),
  getCanonicalDiffCommand: () => 'git diff origin/main origin/feature -- <file>',
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
    mocks.git.raw.mockResolvedValue('');
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
    mocks.runtimeClient.shutdown.mockResolvedValue(undefined);
    mocks.connectToRuntime.mockResolvedValue(mocks.runtimeClient);
    mocks.runAgent.mockImplementation(
      async (_config, agent: string, options: { prompt?: string }) => ({
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
      })
    );
    mocks.runDescribeIfEnabled.mockResolvedValue({
      type: 'feature',
      title: 'Generated description',
      summary: ['Describe the change'],
    });
    mocks.enforceRepoBranchMatch.mockResolvedValue(undefined);
    mocks.createGitHubClient.mockReturnValue({ platform: 'github' });
    mocks.GitHubPlatformAdapter.mockImplementation(
      class {
        constructor() {
          return mocks.githubAdapter;
        }
      } as unknown as () => typeof mocks.githubAdapter
    );
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
    mocks.GitLabPlatformAdapter.mockImplementation(
      class {
        constructor() {
          return mocks.gitlabAdapter;
        }
      } as unknown as () => typeof mocks.gitlabAdapter
    );
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

  it('runs packaged local visual explainer workflow and writes HTML artifact', async () => {
    const projectRoot = createTempDir('drs-workflow-visual-');
    const config = loadConfig(projectRoot);
    mocks.git.diff.mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+change'
    );
    mocks.runAgent.mockResolvedValue(
      createMockAgentResult(
        'visual/pr-explainer',
        '<!DOCTYPE html><html><body><h1>Visual explainer</h1></body></html>'
      )
    );

    const result = await runWorkflow(config, 'local-visual-explain', {
      inputs: { outputPath: '.drs/custom-visual.html' },
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledWith(
      config,
      'visual/pr-explainer',
      expect.objectContaining({
        prompt: expect.stringContaining('Generate a visual local-diff explainer HTML artifact.'),
      })
    );
    expect(mocks.runAgent.mock.calls[0]?.[2].prompt).toContain('src/app.ts');
    expect(readFileSync(join(projectRoot, '.drs', 'custom-visual.html'), 'utf-8')).toContain(
      '<!DOCTYPE html>'
    );
    expect(result.output).toContain('<!DOCTYPE html>');
    expect(result.nodes.visual?.writes).toBe('.drs/custom-visual.html');
  });

  it('extracts the HTML document when visual agent output includes surrounding text', async () => {
    const projectRoot = createTempDir('drs-workflow-visual-extract-');
    const config = loadConfig(projectRoot);
    mocks.git.diff.mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+change'
    );
    mocks.runAgent.mockResolvedValue(
      createMockAgentResult(
        'visual/pr-explainer',
        'Thinking before writing.\n<!DOCTYPE html><html><body><h1>Visual explainer</h1></body></html>\nDone.'
      )
    );

    const result = await runWorkflow(config, 'local-visual-explain', {
      inputs: { outputPath: '.drs/custom-visual.html' },
      workingDir: projectRoot,
    });

    const artifact = readFileSync(join(projectRoot, '.drs', 'custom-visual.html'), 'utf-8');
    expect(artifact).toBe('<!DOCTYPE html><html><body><h1>Visual explainer</h1></body></html>');
    expect(result.output).toBe(artifact);
  });

  it('fails clearly when an HTML workflow write has no doctype', async () => {
    const projectRoot = createTempDir('drs-workflow-visual-invalid-');
    const config = loadConfig(projectRoot);
    mocks.git.diff.mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+change'
    );
    mocks.runAgent.mockResolvedValue(
      createMockAgentResult('visual/pr-explainer', '<html><body>Missing doctype</body></html>')
    );

    await expect(
      runWorkflow(config, 'local-visual-explain', {
        inputs: { outputPath: '.drs/custom-visual.html' },
        workingDir: projectRoot,
      })
    ).rejects.toThrow('produced HTML output without <!DOCTYPE html>');
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

  it('loads a git range change source from explicit refs', async () => {
    const projectRoot = createTempDir('drs-workflow-git-range-');
    const config = {
      ...baseConfig,
      workflows: {
        releaseChanges: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'git-range', from: 'v3.3.1', to: 'v4.0.0-rc.1' },
              output: 'change',
            },
          },
        },
      },
    } as unknown as DRSConfig;
    mocks.git.raw.mockResolvedValue(
      'abc123\x1fAda Lovelace\x1f2026-06-16T00:00:00Z\x1fAdd workflow runtime\n'
    );

    const result = await runWorkflow(config, 'releaseChanges', {
      workingDir: projectRoot,
    });

    expect(mocks.git.diff).toHaveBeenCalledWith(['v3.3.1..v4.0.0-rc.1']);
    expect(mocks.git.raw).toHaveBeenCalledWith([
      'log',
      '--format=%H%x1f%an%x1f%aI%x1f%s',
      '--no-merges',
      'v3.3.1..v4.0.0-rc.1',
    ]);
    expect(result.artifacts.change).toMatchObject({
      name: 'Git range v3.3.1..v4.0.0-rc.1',
      files: ['src/app.ts'],
      context: {
        sourceType: 'git-range',
        fromRef: 'v3.3.1',
        toRef: 'v4.0.0-rc.1',
        range: 'v3.3.1..v4.0.0-rc.1',
        commits: [
          {
            sha: 'abc123',
            author: 'Ada Lovelace',
            date: '2026-06-16T00:00:00Z',
            subject: 'Add workflow runtime',
          },
        ],
      },
    });
  });

  it('infers git range refs from a GitHub Actions tag event', async () => {
    const previousRefType = process.env.GITHUB_REF_TYPE;
    const previousRefName = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_TYPE = 'tag';
    process.env.GITHUB_REF_NAME = 'v4.0.0-rc.1';
    const projectRoot = createTempDir('drs-workflow-github-tag-range-');
    const config = {
      ...baseConfig,
      workflows: {
        releaseChanges: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'git-range' },
              output: 'change',
            },
          },
        },
      },
    } as unknown as DRSConfig;
    mocks.git.raw.mockImplementation(async (args?: string[]) => {
      if (args?.[0] === 'tag') {
        return 'v4.0.0-rc.1\nv3.3.1\nv3.3.0\n';
      }
      return 'def456\x1fGrace Hopper\x1f2026-06-16T00:00:00Z\x1fPrepare 4.0\n';
    });

    try {
      const result = await runWorkflow(config, 'releaseChanges', {
        workingDir: projectRoot,
      });

      expect(mocks.git.raw).toHaveBeenCalledWith([
        'tag',
        '--merged',
        'v4.0.0-rc.1',
        '--sort=-v:refname',
      ]);
      expect(mocks.git.diff).toHaveBeenCalledWith(['v3.3.1..v4.0.0-rc.1']);
      expect(result.artifacts.change).toMatchObject({
        name: 'Git range v3.3.1..v4.0.0-rc.1',
        context: {
          fromRef: 'v3.3.1',
          toRef: 'v4.0.0-rc.1',
        },
      });
    } finally {
      if (previousRefType === undefined) {
        delete process.env.GITHUB_REF_TYPE;
      } else {
        process.env.GITHUB_REF_TYPE = previousRefType;
      }
      if (previousRefName === undefined) {
        delete process.env.GITHUB_REF_NAME;
      } else {
        process.env.GITHUB_REF_NAME = previousRefName;
      }
    }
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
    expect(mocks.enforceRepoBranchMatch).toHaveBeenCalledWith(
      process.cwd(),
      'octocat/hello-world',
      expect.objectContaining({ number: 7 }),
      {
        skipRepoCheck: undefined,
        skipBranchCheck: undefined,
      }
    );
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

  it('runs packaged GitHub PR review visual explainer when enabled', async () => {
    const projectRoot = createTempDir('drs-workflow-github-visual-');
    const config = loadConfig(projectRoot);
    mocks.executeReview.mockResolvedValue({
      issues: [
        {
          category: 'QUALITY',
          severity: 'HIGH',
          title: 'Example finding',
          file: 'src/github.ts',
          line: 1,
          problem: 'Example problem',
          solution: 'Example solution',
          references: [],
          agent: 'unified',
        },
      ],
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { HIGH: 1 },
        byCategory: { QUALITY: 1 },
      },
      filesReviewed: 1,
    });
    mocks.runAgent.mockResolvedValue(
      createMockAgentResult(
        'visual/pr-explainer',
        '<!DOCTYPE html><html><body><h1>PR visual</h1></body></html>'
      )
    );

    const result = await runWorkflow(config, 'github-pr-review', {
      inputs: {
        owner: 'octocat',
        repo: 'hello-world',
        pr: '7',
        visual: 'true',
        visualOutputPath: '.drs/pr-visual.html',
      },
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledWith(
      config,
      'visual/pr-explainer',
      expect.objectContaining({
        prompt: expect.stringContaining('Generate a visual PR explainer HTML artifact.'),
      })
    );
    const visualPrompt = mocks.runAgent.mock.calls[0]?.[2].prompt ?? '';
    expect(visualPrompt).toContain('DRS review result:');
    expect(visualPrompt).toContain('Example finding');
    expect(visualPrompt).toContain('"issuesFound": 1');
    expect(readFileSync(join(projectRoot, '.drs', 'pr-visual.html'), 'utf-8')).toContain(
      '<!DOCTYPE html>'
    );
    expect(mocks.executeReview).toHaveBeenCalled();
    expect(mocks.executeReview.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runAgent.mock.invocationCallOrder[0] ?? 0
    );
    expect(result.nodes.visual?.writes).toBe('.drs/pr-visual.html');
  });

  it('shows GitHub PR review context with embedded diff content', async () => {
    const config = {
      ...baseConfig,
      workflows: {
        githubContext: {
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
            context: {
              action: 'review-context',
              needs: ['change'],
              with: { source: 'change' },
              output: 'reviewContext',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'githubContext', { workingDir: process.cwd() });

    expect(result.output).toEqual(expect.stringContaining('## Diff Content'));
    expect(result.output).toEqual(expect.stringContaining('### src/github.ts'));
    expect(result.output).toEqual(expect.stringContaining('+github'));
  });

  it('filters review context to a requested file', async () => {
    mocks.gitlabAdapter.getChangedFiles.mockResolvedValue([
      {
        filename: 'src/one.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ +1 @@\n+one',
      },
      {
        filename: 'src/two.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ +1 @@\n+two',
      },
    ]);
    const config = {
      ...baseConfig,
      workflows: {
        gitlabContext: {
          nodes: {
            change: {
              action: 'change-source',
              with: {
                type: 'gitlab-mr',
                project: 'group/repo',
                mr: 8,
              },
              output: 'change',
            },
            context: {
              action: 'review-context',
              needs: ['change'],
              with: { source: 'change', file: 'src/two.ts' },
              output: 'reviewContext',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'gitlabContext', { workingDir: process.cwd() });

    expect(result.output).toEqual(expect.stringContaining('### src/two.ts'));
    expect(result.output).toEqual(expect.stringContaining('+two'));
    expect(result.output).not.toEqual(expect.stringContaining('### src/one.ts'));
  });

  it('generates and posts a GitHub PR description from workflow artifacts', async () => {
    const projectRoot = createTempDir('drs-workflow-describe-');
    const config = {
      ...baseConfig,
      workflows: {
        githubDescribe: {
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
            describe: {
              action: 'describe',
              needs: ['change'],
              with: { source: 'change', post: true },
              output: 'description',
              writes: '.drs/description.json',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'githubDescribe', {
      workingDir: projectRoot,
      debug: true,
      thinkingLevel: 'high',
    });

    expect(mocks.connectToRuntime).toHaveBeenCalledWith(
      config,
      projectRoot,
      expect.objectContaining({
        debug: true,
        thinkingLevel: 'high',
      })
    );
    expect(mocks.runDescribeIfEnabled).toHaveBeenCalledWith(
      mocks.runtimeClient,
      config,
      mocks.githubAdapter,
      'octocat/hello-world',
      expect.objectContaining({ number: 7 }),
      [{ filename: 'src/github.ts', patch: '@@ +1 @@\n+github' }],
      true,
      projectRoot,
      true
    );
    expect(mocks.runtimeClient.shutdown).toHaveBeenCalled();
    expect(result.artifacts.description).toMatchObject({ title: 'Generated description' });
    expect(JSON.parse(readFileSync(join(projectRoot, '.drs/description.json'), 'utf-8'))).toEqual(
      result.artifacts.description
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

  it('writes a GitLab code quality report from workflow review artifacts', async () => {
    const projectRoot = createTempDir('drs-workflow-code-quality-');
    mocks.executeReview.mockImplementation(async () => ({
      issues: [
        {
          category: 'QUALITY',
          severity: 'HIGH',
          title: 'Validate input',
          file: 'src/gitlab.ts',
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
        codeQuality: {
          nodes: {
            change: {
              action: 'change-source',
              with: {
                type: 'gitlab-mr',
                project: 'group/repo',
                mr: 8,
              },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            report: {
              action: 'code-quality-report',
              needs: ['review'],
              with: {
                review: 'review',
                path: 'gl-code-quality-report.json',
              },
              output: 'codeQualityReport',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'codeQuality', { workingDir: projectRoot });

    const report = JSON.parse(
      readFileSync(join(projectRoot, 'gl-code-quality-report.json'), 'utf-8')
    );
    expect(report).toEqual([
      expect.objectContaining({
        check_name: 'drs-quality',
        severity: 'critical',
        location: {
          path: 'src/gitlab.ts',
          lines: { begin: 1 },
        },
      }),
    ]);
    expect(result.artifacts.codeQualityReport).toMatchObject({
      path: 'gl-code-quality-report.json',
      issues: 1,
    });
  });

  it('loads a GitLab MR change source and reviews it', async () => {
    const config = {
      ...baseConfig,
      review: {
        ...baseConfig.review,
        skipRepoCheck: true,
        skipBranchCheck: true,
      },
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
    expect(mocks.enforceRepoBranchMatch).toHaveBeenCalledWith(
      process.cwd(),
      'group/repo',
      expect.objectContaining({ number: 8 }),
      {
        skipRepoCheck: true,
        skipBranchCheck: true,
      }
    );
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

  it('routes condition control nodes and skips inactive branch nodes', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });

    const config = {
      ...baseConfig,
      workflows: {
        conditional: {
          nodes: {
            count: { agent: 'task/count', input: '2', output: 'count' },
            choose: {
              control: 'condition',
              needs: ['count'],
              if: '{{artifacts.count}} > 0',
              then: 'positive',
              else: 'negative',
            },
            positive: { agent: 'task/positive', input: 'positive {{artifacts.count}}' },
            negative: { agent: 'task/negative', input: 'negative' },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'conditional');

    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(mocks.runAgent).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'task/positive',
      expect.objectContaining({ prompt: 'positive 2' })
    );
    expect(result.nodes.choose).toMatchObject({
      type: 'control',
      decision: 'then',
      target: 'positive',
    });
    expect(result.nodes.negative).toMatchObject({ type: 'skipped', status: 'skipped' });
  });

  it('runs same-segment dependencies required by a condition branch target', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        conditionalDependency: {
          nodes: {
            choose: {
              control: 'condition',
              if: 'true',
              then: 'target',
              else: 'other',
            },
            prerequisite: { agent: 'task/prerequisite', input: 'prepared', output: 'prerequisite' },
            target: {
              agent: 'task/target',
              needs: ['prerequisite'],
              input: 'target {{artifacts.prerequisite}}',
              output: 'target',
            },
            follower: {
              agent: 'task/follower',
              needs: ['target'],
              input: 'follower {{artifacts.target}}',
              output: 'follower',
            },
            other: { agent: 'task/other', input: 'other', output: 'other' },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'conditionalDependency', {
      workingDir: process.cwd(),
    });

    expect(result.nodes.prerequisite).toMatchObject({ type: 'agent' });
    expect(result.nodes.target).toMatchObject({ type: 'agent' });
    expect(result.nodes.follower).toMatchObject({ type: 'agent' });
    expect(result.nodes.other).toMatchObject({ status: 'skipped' });
    expect(result.artifacts.target).toBe('target prepared');
    expect(result.artifacts.follower).toBe('follower target prepared');
  });

  it('continues from an optional condition branch into a later DAG segment', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        optionalDescribe: {
          inputs: { describe: 'true' },
          nodes: {
            shouldDescribe: {
              control: 'condition',
              if: '{{inputs.describe}} == true',
              then: 'describe',
              else: 'review',
            },
            describe: { agent: 'task/describe', input: 'describe', output: 'description' },
            continueReview: {
              control: 'condition',
              needs: ['describe'],
              if: 'true',
              then: 'review',
              else: 'review',
            },
            review: { agent: 'task/review', input: 'review', output: 'review' },
          },
        },
      },
    } as unknown as DRSConfig;

    const described = await runWorkflow(config, 'optionalDescribe', {
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/describe',
      'task/review',
    ]);
    expect(described.nodes.describe).toMatchObject({ type: 'agent' });
    expect(described.nodes.continueReview).toMatchObject({ type: 'control', target: 'review' });
    expect(described.nodes.review).toMatchObject({ type: 'agent' });

    mocks.runAgent.mockClear();

    const reviewedOnly = await runWorkflow(config, 'optionalDescribe', {
      inputs: { describe: 'false' },
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual(['task/review']);
    expect(reviewedOnly.nodes.describe).toBeUndefined();
    expect(reviewedOnly.nodes.continueReview).toBeUndefined();
    expect(reviewedOnly.nodes.review).toMatchObject({ type: 'agent' });
  });

  it('matches boolean-like condition input values consistently', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        booleanInput: {
          inputs: { enabled: 'false' },
          nodes: {
            choose: {
              control: 'condition',
              if: '{{inputs.enabled}} == true',
              then: 'enabled',
              else: 'disabled',
            },
            enabled: { agent: 'task/enabled', input: 'enabled' },
            disabled: { agent: 'task/disabled', input: 'disabled' },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'booleanInput', {
      inputs: { enabled: 'yes' },
      workingDir: process.cwd(),
    });
    await runWorkflow(config, 'booleanInput', {
      inputs: { enabled: '1' },
      workingDir: process.cwd(),
    });
    await runWorkflow(config, 'booleanInput', {
      inputs: { enabled: 'no' },
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/enabled',
      'task/enabled',
      'task/disabled',
    ]);
  });

  it('loops through review and fix nodes until the condition exits', async () => {
    const reviewOutputs = ['issues', 'clean'];
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      if (agent === 'task/review') {
        return createMockAgentResult(agent, reviewOutputs.shift() ?? 'clean');
      }
      return createMockAgentResult(agent, options.prompt ?? agent);
    });

    const config = {
      ...baseConfig,
      workflows: {
        reviewFix: {
          nodes: {
            review: { agent: 'task/review', input: 'review', output: 'review' },
            shouldFix: {
              control: 'condition',
              needs: ['review'],
              if: '{{artifacts.review}} != clean',
              then: 'fix',
              else: 'done',
            },
            fix: { agent: 'task/fix', input: 'fix {{artifacts.review}}' },
            repeat: {
              control: 'loop',
              needs: ['fix'],
              condition: '{{artifacts.review}} != clean',
              target: 'review',
              exit: 'done',
              maxIterations: 3,
            },
            done: { agent: 'task/done', input: 'done {{artifacts.review}}' },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'reviewFix');

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/review',
      'task/fix',
      'task/review',
      'task/done',
    ]);
    expect(mocks.runAgent).toHaveBeenLastCalledWith(
      expect.anything(),
      'task/done',
      expect.objectContaining({ prompt: 'done clean' })
    );
    expect(result.loop.repeat).toMatchObject({
      iteration: 1,
      maxIterations: 3,
      lastDecision: 'loop',
    });
    expect(result.artifacts.review).toBe('clean');
  });

  it('uses explicit workflow output when a control end node is last', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        outputWithEnd: {
          output: 'summary',
          nodes: {
            summarize: { agent: 'task/summarizer', input: 'summary', output: 'summary' },
            done: { control: 'end', needs: ['summarize'] },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'outputWithEnd');

    expect(result.nodes.done).toMatchObject({ type: 'control', decision: 'end' });
    expect(result.output).toBe('summary');
  });

  it('runs control end nodes after non-end nodes regardless of declaration order', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        endFirst: {
          nodes: {
            done: { control: 'end' },
            start: { agent: 'task/start', input: 'start', output: 'start' },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'endFirst', { workingDir: process.cwd() });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual(['task/start']);
    expect(result.nodes.done).toMatchObject({ type: 'control', decision: 'end' });
    expect(result.artifacts.start).toBe('start');
  });

  it('stops workflow execution when a control end node runs', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        earlyEnd: {
          nodes: {
            start: { agent: 'task/start', input: 'start', output: 'start' },
            done: { control: 'end', needs: ['start'] },
            after: { agent: 'task/after', input: 'after' },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'earlyEnd', { workingDir: process.cwd() });

    expect(result.nodes.done).toMatchObject({ type: 'control', decision: 'end' });
    expect(result.nodes.after).toBeUndefined();
    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual(['task/start']);
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

  it('waits for sibling side effects in a wave before surfacing a node failure', async () => {
    const workingDir = createTempDir('drs-workflow-wave-failure-');
    let writeNodeFinished = false;
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      if (agent === 'task/fail') {
        throw new Error('agent failed');
      }
      await new Promise((resolve) => setImmediate(resolve));
      writeNodeFinished = true;
      return createMockAgentResult(agent, options.prompt ?? 'ok');
    });

    const config = {
      ...baseConfig,
      workflows: {
        waveFail: {
          nodes: {
            fail: { agent: 'task/fail', input: 'fail' },
            slow: { agent: 'task/slow', input: 'slow', writes: 'out.txt' },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(runWorkflow(config, 'waveFail', { workingDir })).rejects.toThrow('agent failed');
    expect(writeNodeFinished).toBe(true);
    expect(readFileSync(join(workingDir, 'out.txt'), 'utf-8')).toBe('slow');
  });

  it('lists workflows with packaged source by default', () => {
    const config = loadConfig(process.cwd());

    const entries = listWorkflows(config, { workingDir: process.cwd() });

    expect(entries.some((entry) => entry.source === 'packaged' && !entry.overridden)).toBe(true);
  });

  it('lists project workflows that override packaged ones', () => {
    const projectRoot = createTempDir('drs-workflow-list-');
    mkdirSync(join(projectRoot, '.drs', 'workflows'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.drs', 'workflows', 'local-review.yaml'),
      'description: Project override\nnodes:\n  step:\n    action: write\n    input: hi\n    writes: out.txt\n',
      'utf-8'
    );

    const config = loadConfig(projectRoot);
    const entries = listWorkflows(config, { workingDir: projectRoot });
    const localReview = entries.find((entry) => entry.name === 'local-review');

    expect(localReview).toMatchObject({
      source: 'project',
      overridden: true,
      description: 'Project override',
    });
  });

  it('shows workflow details including inputs, output, and node routes', () => {
    const config = {
      ...baseConfig,
      workflows: {
        inspect: {
          description: 'Inspect this workflow',
          inputs: {
            enabled: 'true',
            body: { file: 'prompt.md' },
          },
          output: 'result',
          nodes: {
            start: { action: 'write', input: 'hello', writes: 'out.txt', output: 'result' },
            gate: {
              needs: ['start'],
              control: 'condition',
              if: '${{ inputs.enabled }}',
              then: 'done',
              else: 'stop',
            },
            done: { needs: ['gate'], agent: 'task/review', input: '${{ artifacts.result }}' },
            stop: { needs: ['gate'], control: 'end' },
          },
        },
      },
    } as unknown as DRSConfig;

    const detail = showWorkflow(config, 'inspect', { workingDir: process.cwd() });

    expect(detail).toMatchObject({
      name: 'inspect',
      source: 'packaged',
      overridden: false,
      description: 'Inspect this workflow',
      output: 'result',
      inputs: {
        enabled: 'true',
        body: { file: 'prompt.md' },
      },
    });
    expect(detail.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gate',
          kind: 'control',
          needs: ['start'],
          control: 'condition',
          if: '${{ inputs.enabled }}',
          routes: { then: 'done', else: 'stop' },
        }),
      ])
    );
  });

  it('throws for unknown workflow details', () => {
    expect(() => showWorkflow(baseConfig, 'missing', { workingDir: process.cwd() })).toThrow(
      'Unknown workflow "missing".'
    );
  });
});
