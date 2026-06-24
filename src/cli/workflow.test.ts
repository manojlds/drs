import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, SUPPORTED_WORKFLOW_ACTIONS, type DRSConfig } from '../lib/config.js';
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
    hasLabel: vi.fn(),
    findChangeRequest: vi.fn(),
    createChangeRequest: vi.fn(),
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
    hasLabel: vi.fn(),
    findChangeRequest: vi.fn(),
    createChangeRequest: vi.fn(),
  };

  return {
    git: {
      checkIsRepo: vi.fn(async () => true),
      diff: vi.fn(async () => 'diff --git a/src/app.ts b/src/app.ts'),
      raw: vi.fn(async (_args?: string[]) => ''),
      branch: vi.fn(async () => ({ current: 'feature' })),
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
    executeReview: vi.fn(
      async (_config: unknown, source: { files: string[]; staged?: boolean }) => ({
        issues: [] as unknown[],
        summary: {
          filesReviewed: source.files.length,
          issuesFound: 0,
          bySeverity: {},
          byCategory: {},
        },
        filesReviewed: source.files.length,
      })
    ),
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

  function createMockReviewIssue(title: string, line = 1) {
    return {
      severity: 'HIGH',
      category: 'QUALITY',
      title,
      file: 'src/github.ts',
      line,
      problem: `${title} problem`,
      solution: `${title} solution`,
      references: [],
      agent: 'unified',
    };
  }

  function createMockReviewResult(issues: ReturnType<typeof createMockReviewIssue>[]) {
    return {
      issues,
      summary: {
        filesReviewed: 1,
        issuesFound: issues.length,
        bySeverity: { HIGH: issues.length },
        byCategory: { QUALITY: issues.length },
      },
      filesReviewed: 1,
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
    mocks.git.branch.mockResolvedValue({ current: 'feature' });
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
    mocks.githubAdapter.hasLabel.mockResolvedValue(false);
    mocks.githubAdapter.findChangeRequest.mockResolvedValue(undefined);
    mocks.githubAdapter.createChangeRequest.mockResolvedValue({
      number: 99,
      url: 'https://github.com/octocat/hello-world/pull/99',
      sourceBranch: 'drs-guidance/pr-7',
      targetBranch: 'feature',
    });
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
    mocks.gitlabAdapter.hasLabel.mockResolvedValue(false);
    mocks.gitlabAdapter.findChangeRequest.mockResolvedValue(undefined);
    mocks.gitlabAdapter.createChangeRequest.mockResolvedValue({
      number: 77,
      url: 'https://gitlab.com/group/repo/-/merge_requests/77',
      sourceBranch: 'drs-guidance/mr-8',
      targetBranch: 'feature',
    });
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

  it('resumes from a workflow checkpoint and skips successful nodes', async () => {
    const projectRoot = createTempDir('drs-workflow-resume-');
    mocks.githubAdapter.createChangeRequest.mockRejectedValueOnce(new Error('temporary failure'));
    const config = {
      ...baseConfig,
      workflows: {
        resumable: {
          nodes: {
            summarize: {
              agent: 'task/summarizer',
              input: 'Summarize before retry',
              output: 'summary',
            },
            create: {
              action: 'create-change-request',
              needs: ['summarize'],
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                sourceBranch: 'drs-fix/pr-7',
                targetBranch: 'feature',
                title: 'fix: retry safely',
              },
              output: 'changeRequest',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await expect(
      runWorkflow(config, 'resumable', {
        workingDir: projectRoot,
        resume: true,
        checkpointKey: 'retry-demo',
      })
    ).rejects.toThrow('temporary failure');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const checkpointPath = join(projectRoot, '.drs', 'checkpoints', 'retry-demo.json');
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8'))).toMatchObject({
      workflow: 'resumable',
      nodes: { summarize: { status: 'success' } },
      failure: { message: 'temporary failure' },
    });

    const result = await runWorkflow(config, 'resumable', {
      workingDir: projectRoot,
      resume: true,
      checkpointKey: 'retry-demo',
    });

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(mocks.githubAdapter.createChangeRequest).toHaveBeenCalledTimes(2);
    expect(result.artifacts.summary).toBe('task/summarizer: Summarize before retry');
    expect(result.artifacts.changeRequest).toMatchObject({ number: 99, operation: 'created' });
    expect(() => readFileSync(checkpointPath, 'utf-8')).toThrow();
  });

  it('keeps checkpoint file when checkpoint cleanup is disabled', async () => {
    const projectRoot = createTempDir('drs-workflow-resume-no-cleanup-');
    const config = {
      ...baseConfig,
      workflows: {
        resumable: {
          nodes: {
            summarize: {
              agent: 'task/summarizer',
              input: 'Summarize',
              output: 'summary',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const checkpointPath = join(projectRoot, '.drs', 'checkpoints', 'keep-demo.json');
    await runWorkflow(config, 'resumable', {
      workingDir: projectRoot,
      resume: true,
      checkpointKey: 'keep-demo',
      checkpointCleanup: false,
    });

    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8'))).not.toHaveProperty('failure');
  });

  it('rejects resume when checkpoint inputs differ from current inputs', async () => {
    const projectRoot = createTempDir('drs-workflow-resume-inputs-');
    mocks.githubAdapter.createChangeRequest.mockRejectedValueOnce(new Error('temporary failure'));
    const createConfig = (mode: string) =>
      ({
        ...baseConfig,
        workflows: {
          resumable: {
            inputs: { mode },
            nodes: {
              summarize: {
                agent: 'task/summarizer',
                input: 'Summarize {{inputs.mode}}',
                output: 'summary',
              },
              create: {
                action: 'create-change-request',
                needs: ['summarize'],
                with: {
                  platform: 'github',
                  owner: 'octocat',
                  repo: 'hello-world',
                  sourceBranch: 'drs-fix/pr-7',
                  targetBranch: 'feature',
                  title: 'fix: retry safely',
                },
                output: 'changeRequest',
              },
            },
          },
        },
      }) as unknown as DRSConfig;

    await expect(
      runWorkflow(createConfig('alpha'), 'resumable', {
        workingDir: projectRoot,
        resume: true,
        checkpointKey: 'input-demo',
      })
    ).rejects.toThrow('temporary failure');

    await expect(
      runWorkflow(createConfig('beta'), 'resumable', {
        workingDir: projectRoot,
        resume: true,
        checkpointKey: 'input-demo',
      })
    ).rejects.toThrow('was created with different inputs');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps GitLab nested project checkpoint keys distinct', async () => {
    const projectRoot = createTempDir('drs-workflow-gitlab-checkpoint-');
    const config = {
      ...baseConfig,
      workflows: {
        gitlabResume: {
          nodes: {
            summarize: {
              agent: 'task/summarizer',
              input: 'Summarize {{inputs.project}}',
              output: 'summary',
            },
            fail: {
              action: 'write',
              needs: ['summarize'],
              input: 'content',
              writes: '{{inputs.outputPath}}',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    for (const project of ['group/subgroup/project', 'group/subgroup-project']) {
      await expect(
        runWorkflow(config, 'gitlabResume', {
          workingDir: projectRoot,
          resume: true,
          inputs: { project, mr: '1', sha: 'abc', outputPath: '' },
        })
      ).rejects.toThrow('writes resolved to an empty path');
    }

    const checkpointDir = join(projectRoot, '.drs', 'checkpoints');
    expect(
      readFileSync(
        join(checkpointDir, 'gitlabResume-gitlab-group-2Fsubgroup-2Fproject-mr-1-abc.json'),
        'utf-8'
      )
    ).toContain('group/subgroup/project');
    expect(
      readFileSync(
        join(checkpointDir, 'gitlabResume-gitlab-group-2Fsubgroup-project-mr-1-abc.json'),
        'utf-8'
      )
    ).toContain('group/subgroup-project');
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

  it('uses artifact output pointers for HTML workflow writes', async () => {
    const projectRoot = createTempDir('drs-workflow-visual-pointer-');
    const config = loadConfig(projectRoot);
    mocks.git.diff.mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+change'
    );
    mkdirSync(join(projectRoot, '.drs'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.drs', 'custom-visual.html'),
      '<!DOCTYPE html><html><body><h1>Pointer visual</h1></body></html>'
    );
    mocks.runAgent.mockResolvedValue(
      createMockAgentResult(
        'visual/pr-explainer',
        '{"outputType":"artifact_output","outputPath":".drs/custom-visual.html"}'
      )
    );

    const result = await runWorkflow(config, 'local-visual-explain', {
      inputs: { outputPath: '.drs/custom-visual.html' },
      workingDir: projectRoot,
    });

    const artifact = readFileSync(join(projectRoot, '.drs', 'custom-visual.html'), 'utf-8');
    expect(artifact).toContain('Pointer visual');
    expect(result.output).toBe(artifact);
  });

  it('uses an existing valid HTML artifact when agent response is malformed', async () => {
    const projectRoot = createTempDir('drs-workflow-visual-existing-artifact-');
    const config = loadConfig(projectRoot);
    mocks.git.diff.mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+change'
    );
    mkdirSync(join(projectRoot, '.drs'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.drs', 'custom-visual.html'),
      '<!DOCTYPE html><html><body><h1>Tool-written visual</h1></body></html>'
    );
    mocks.runAgent.mockResolvedValue(
      createMockAgentResult('visual/pr-explainer', '<!DOCTYPE html><html><body>partial')
    );

    const result = await runWorkflow(config, 'local-visual-explain', {
      inputs: { outputPath: '.drs/custom-visual.html' },
      workingDir: projectRoot,
    });

    const artifact = readFileSync(join(projectRoot, '.drs', 'custom-visual.html'), 'utf-8');
    expect(artifact).toContain('Tool-written visual');
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
    ).rejects.toThrow('produced invalid HTML output');
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

  it('branches, detects a diff, pushes, and creates a change request', async () => {
    const projectRoot = createTempDir('drs-workflow-change-request-');
    const config = {
      ...baseConfig,
      workflows: {
        stack: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            branch: {
              action: 'git-branch',
              needs: ['change'],
              with: { name: 'drs-guidance/pr-7', force: true },
            },
            diff: {
              action: 'has-diff',
              needs: ['branch'],
              with: { paths: 'AGENTS.md,CLAUDE.md' },
              output: 'diff',
            },
            push: {
              action: 'git-push',
              needs: ['diff'],
              with: { branch: 'drs-guidance/pr-7' },
            },
            create: {
              action: 'create-change-request',
              needs: ['push'],
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                sourceBranch: 'drs-guidance/pr-7',
                targetBranch: '{{artifacts.change.context.pullRequest.sourceBranch}}',
                title: 'docs: update agent guidance',
              },
              output: 'changeRequest',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'stack', { workingDir: projectRoot });

    expect(mocks.git.raw).toHaveBeenCalledWith(['checkout', '-B', 'drs-guidance/pr-7']);
    expect(mocks.git.diff).toHaveBeenCalledWith(['--', 'AGENTS.md', 'CLAUDE.md']);
    expect(mocks.git.raw).toHaveBeenCalledWith([
      'push',
      '-u',
      'origin',
      'drs-guidance/pr-7:drs-guidance/pr-7',
    ]);
    expect(mocks.githubAdapter.createChangeRequest).toHaveBeenCalledWith('octocat/hello-world', {
      sourceBranch: 'drs-guidance/pr-7',
      targetBranch: 'feature',
      title: 'docs: update agent guidance',
      body: undefined,
      draft: false,
    });
    expect(result.artifacts.diff).toMatchObject({
      changed: true,
      files: ['AGENTS.md', 'CLAUDE.md'],
    });
    expect(result.artifacts.changeRequest).toMatchObject({ number: 99 });
  });

  it('reuses an existing change request for the same source and target branches', async () => {
    const projectRoot = createTempDir('drs-workflow-change-request-existing-');
    mocks.githubAdapter.findChangeRequest.mockResolvedValue({
      number: 101,
      url: 'https://github.com/octocat/hello-world/pull/101',
      sourceBranch: 'drs-fix/pr-7',
      targetBranch: 'feature',
    });
    const config = {
      ...baseConfig,
      workflows: {
        stack: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            create: {
              action: 'create-change-request',
              needs: ['change'],
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                sourceBranch: 'drs-fix/pr-7',
                targetBranch: '{{artifacts.change.context.pullRequest.sourceBranch}}',
                title: 'fix: address DRS review issues',
              },
              output: 'changeRequest',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'stack', { workingDir: projectRoot });

    expect(mocks.githubAdapter.findChangeRequest).toHaveBeenCalledWith(
      'octocat/hello-world',
      'drs-fix/pr-7',
      'feature'
    );
    expect(mocks.githubAdapter.createChangeRequest).not.toHaveBeenCalled();
    expect(result.artifacts.changeRequest).toMatchObject({ number: 101, operation: 'reused' });
  });

  it('reuses an existing change request when create fails after a previous retry side effect', async () => {
    const projectRoot = createTempDir('drs-workflow-change-request-retry-');
    mocks.githubAdapter.findChangeRequest.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      number: 102,
      url: 'https://github.com/octocat/hello-world/pull/102',
      sourceBranch: 'drs-fix/pr-7',
      targetBranch: 'feature',
    });
    mocks.githubAdapter.createChangeRequest.mockRejectedValue(new Error('already exists'));
    const config = {
      ...baseConfig,
      workflows: {
        stack: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            create: {
              action: 'create-change-request',
              needs: ['change'],
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                sourceBranch: 'drs-fix/pr-7',
                targetBranch: '{{artifacts.change.context.pullRequest.sourceBranch}}',
                title: 'fix: address DRS review issues',
              },
              output: 'changeRequest',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'stack', { workingDir: projectRoot });

    expect(mocks.githubAdapter.createChangeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.githubAdapter.findChangeRequest).toHaveBeenCalledTimes(2);
    expect(result.artifacts.changeRequest).toMatchObject({ number: 102, operation: 'reused' });
  });

  it('prevents stacking on reserved DRS source branches by default', async () => {
    const projectRoot = createTempDir('drs-workflow-stack-guard-');
    mocks.githubAdapter.getPullRequest.mockResolvedValue({
      number: 7,
      title: 'Stacked PR',
      author: 'octocat',
      sourceBranch: 'drs-fix/pr-7',
      targetBranch: 'feature',
      headSha: 'abc123',
    });
    const config = {
      ...baseConfig,
      workflows: {
        guarded: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            guard: {
              action: 'stack-guard',
              needs: ['change'],
              output: 'guard',
            },
            branch: {
              action: 'git-branch',
              needs: ['guard'],
              if: '{{artifacts.guard.allowed}} == true',
              with: { name: 'drs-fix/pr-7' },
            },
            done: { control: 'end' },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'guarded', { workingDir: projectRoot });

    expect(result.artifacts.guard).toMatchObject({ allowed: false, sourceBranch: 'drs-fix/pr-7' });
    expect(result.nodes.branch).toMatchObject({ status: 'skipped' });
    expect(mocks.git.raw).not.toHaveBeenCalledWith(['checkout', '-b', 'drs-fix/pr-7']);
  });

  it('matches review issues at or above a configured severity threshold', async () => {
    const projectRoot = createTempDir('drs-workflow-review-threshold-');
    mocks.executeReview.mockResolvedValue({
      issues: [
        { severity: 'LOW', category: 'STYLE', file: 'a.ts', line: 1, message: 'low' },
        { severity: 'HIGH', category: 'BUG', file: 'b.ts', line: 2, message: 'high' },
        { severity: 'CRITICAL', category: 'SECURITY', file: 'c.ts', line: 3, message: 'critical' },
      ],
      summary: { filesReviewed: 1, issuesFound: 3, bySeverity: {}, byCategory: {} },
      filesReviewed: 1,
    });
    const config = {
      ...baseConfig,
      workflows: {
        threshold: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            threshold: {
              action: 'review-threshold',
              needs: ['review'],
              with: { severity: 'high', minIssues: 2 },
              output: 'threshold',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'threshold', { workingDir: projectRoot });

    expect(result.artifacts.threshold).toMatchObject({ matched: true, count: 2, severity: 'HIGH' });
  });

  it('creates, saves, loads, and summarizes review artifacts', async () => {
    const projectRoot = createTempDir('drs-workflow-artifact-');
    mocks.executeReview.mockResolvedValue({
      issues: [
        {
          severity: 'HIGH',
          category: 'QUALITY',
          title: 'Missing guard',
          file: 'src/github.ts',
          line: 12,
          problem: 'A guard is missing.',
          solution: 'Add the guard.',
          agent: 'unified',
        },
      ],
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      filesReviewed: 1,
    });
    const config = {
      ...baseConfig,
      workflows: {
        artifactFlow: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            reviewArtifact: {
              action: 'create-review-artifact',
              needs: ['review'],
              with: { source: 'change', review: 'review' },
              output: 'reviewArtifact',
            },
            save: {
              action: 'save-artifact',
              needs: ['reviewArtifact'],
              with: { kind: 'review', source: 'change', artifact: 'reviewArtifact' },
              output: 'saved',
            },
            load: {
              action: 'load-artifact',
              needs: ['save'],
              with: { kind: 'review', source: 'change' },
              output: 'loaded',
            },
            status: {
              action: 'review-artifact-status',
              needs: ['load'],
              with: { artifact: 'loaded' },
              output: 'status',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'artifactFlow', { workingDir: projectRoot });

    expect(result.artifacts.reviewArtifact).toMatchObject({
      schemaVersion: 1,
      reviewedSha: 'abc123',
      baseBranch: 'main',
      headBranch: 'feature',
      findings: [
        {
          id: 'F001',
          fingerprint: 'src/github.ts:12:QUALITY:Missing guard',
          state: 'open',
          disposition: 'confirmed',
        },
      ],
    });
    expect(result.artifacts.saved).toMatchObject({
      kind: 'review',
      scope: {
        platform: 'github',
        projectId: 'octocat/hello-world',
        changeKind: 'pr',
        changeNumber: 7,
      },
    });
    expect(result.artifacts.loaded).toMatchObject({ kind: 'review' });
    expect(result.artifacts.status).toMatchObject({ totalFindings: 1, openFindings: 1 });
    const saved = result.artifacts.saved as { path: string; latestPath: string };
    expect(JSON.parse(readFileSync(saved.path, 'utf-8'))).toMatchObject({ kind: 'review' });
    expect(JSON.parse(readFileSync(saved.latestPath, 'utf-8'))).toMatchObject({ kind: 'review' });
  });

  it('mutates review artifacts and persists envelope updates', async () => {
    const projectRoot = createTempDir('drs-workflow-artifact-mutate-');
    mocks.executeReview.mockResolvedValue({
      issues: [
        {
          severity: 'HIGH',
          category: 'QUALITY',
          title: 'Missing guard',
          file: 'src/github.ts',
          line: 12,
          problem: 'A guard is missing.',
          solution: 'Add the guard.',
          agent: 'unified',
        },
      ],
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      filesReviewed: 1,
    });
    const addedIssue = {
      severity: 'MEDIUM',
      category: 'SECURITY',
      title: 'Missing validation',
      file: 'src/github.ts',
      line: 18,
      problem: 'Input is not validated.',
      solution: 'Validate the input.',
      agent: 'manual',
    };
    const config = {
      ...baseConfig,
      workflows: {
        artifactMutate: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            reviewArtifact: {
              action: 'create-review-artifact',
              needs: ['review'],
              with: { source: 'change', review: 'review' },
              output: 'reviewArtifact',
            },
            save: {
              action: 'save-artifact',
              needs: ['reviewArtifact'],
              with: { kind: 'review', source: 'change', artifact: 'reviewArtifact' },
              output: 'saved',
            },
            markAttempted: {
              action: 'review-artifact-update-findings',
              needs: ['save'],
              with: {
                artifact: 'saved',
                severity: 'HIGH',
                state: 'attempted',
                disposition: 'partial',
              },
              output: 'marked',
            },
            addFinding: {
              action: 'review-artifact-add-finding',
              needs: ['markAttempted'],
              with: { artifact: 'marked', issue: JSON.stringify(addedIssue), source: 'manual' },
              output: 'added',
            },
            status: {
              action: 'review-artifact-status',
              needs: ['addFinding'],
              with: { artifact: 'added' },
              output: 'status',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'artifactMutate', { workingDir: projectRoot });

    expect(result.artifacts.marked).toMatchObject({
      kind: 'review',
      payload: {
        findings: [{ id: 'F001', state: 'attempted', disposition: 'partial' }],
      },
    });
    expect(result.artifacts.added).toMatchObject({
      kind: 'review',
      payload: {
        findings: [
          { id: 'F001', state: 'attempted', disposition: 'partial' },
          { id: 'F002', source: 'manual', state: 'open', disposition: 'confirmed' },
        ],
        summary: { issuesFound: 2, bySeverity: { HIGH: 1, MEDIUM: 1 } },
      },
    });
    expect(result.artifacts.status).toMatchObject({
      totalFindings: 2,
      openFindings: 1,
      byState: { open: 1, attempted: 1, resolved: 0 },
      byDisposition: { confirmed: 1, partial: 1 },
    });
    const added = result.artifacts.added as { path: string };
    expect(JSON.parse(readFileSync(added.path, 'utf-8'))).toMatchObject({
      kind: 'review',
      payload: { findings: [{ id: 'F001', state: 'attempted' }, { id: 'F002' }] },
    });
  });

  it('reconciles fix verification findings and persists updated artifact state', async () => {
    const projectRoot = createTempDir('drs-workflow-verify-fix-');
    const resolvedIssue = {
      severity: 'HIGH',
      category: 'QUALITY',
      title: 'Resolved issue',
      file: 'src/app.ts',
      line: 10,
      problem: 'Original problem',
      solution: 'Original solution',
      references: [],
      agent: 'unified',
    };
    const stillOpenIssue = {
      severity: 'HIGH',
      category: 'QUALITY',
      title: 'Still open issue',
      file: 'src/app.ts',
      line: 20,
      problem: 'Still present',
      solution: 'Fix it',
      agent: 'unified',
    };
    const regressionIssue = {
      severity: 'HIGH',
      category: 'SECURITY',
      title: 'New regression',
      file: 'src/app.ts',
      line: 30,
      problem: 'Regression problem',
      solution: 'Undo regression',
      agent: 'unified',
    };
    mocks.getFilesWithDiffs.mockReturnValue([
      {
        filename: 'src/app.ts',
        patch: '@@ -8,6 +8,6 @@\n-old\n+new\n@@ -30,2 +30,2 @@\n-old\n+new',
      },
    ]);
    mocks.executeReview.mockImplementation(async (_config, source: { staged?: boolean }) => {
      const issues = source.staged ? [regressionIssue] : [resolvedIssue, stillOpenIssue];
      return {
        issues,
        verification: source.staged
          ? {
              findings: [
                { id: 'F001', disposition: 'resolved', rationale: 'fixed' },
                { id: 'F002', disposition: 'still_open', rationale: 'still present' },
              ],
            }
          : undefined,
        summary: {
          filesReviewed: 1,
          issuesFound: issues.length,
          bySeverity: { HIGH: issues.length },
          byCategory: { QUALITY: issues.length },
        },
        filesReviewed: 1,
      };
    });

    const config = {
      ...baseConfig,
      workflows: {
        verifyFix: {
          nodes: {
            change: { action: 'change-source', output: 'change' },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            artifact: {
              action: 'create-review-artifact',
              needs: ['review'],
              with: { source: 'change', review: 'review' },
              output: 'reviewArtifact',
            },
            save: {
              action: 'save-artifact',
              needs: ['artifact'],
              with: { kind: 'review', artifact: 'reviewArtifact' },
              output: 'persistedReviewArtifact',
            },
            fixChange: {
              action: 'change-source',
              needs: ['save'],
              with: { type: 'local', staged: true },
              output: 'fixChange',
            },
            reReview: {
              action: 'review',
              needs: ['fixChange'],
              with: { source: 'fixChange' },
              output: 'reReview',
            },
            verify: {
              action: 'verify-fix',
              needs: ['reReview'],
              with: {
                artifact: 'persistedReviewArtifact',
                review: 'reReview',
                fixChange: 'fixChange',
                severity: 'high',
              },
              output: 'persistedReviewArtifact',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'verifyFix', { workingDir: projectRoot });
    const verified = result.artifacts.verify as {
      shouldContinue: boolean;
      actionableOpen: number;
      payload: {
        findings: Array<{ state: string; disposition: string; issue: { title: string } }>;
      };
    };

    expect(verified.shouldContinue).toBe(true);
    expect(verified.actionableOpen).toBe(2);
    expect(verified.payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'resolved', disposition: 'resolved' }),
        expect.objectContaining({ state: 'open', disposition: 'still_open' }),
        expect.objectContaining({ state: 'open', disposition: 'regression' }),
      ])
    );
    expect(result.artifacts.persistedReviewArtifact).toMatchObject({ shouldContinue: true });
  });

  it('marks fix verification converged when re-review has no matching findings', async () => {
    const projectRoot = createTempDir('drs-workflow-verify-fix-clean-');
    const issue = createMockReviewIssue('Fixed issue');
    mocks.executeReview.mockImplementation(async (_config, source: { staged?: boolean }) =>
      source.staged
        ? {
            ...createMockReviewResult([]),
            verification: { findings: [{ id: 'F001', disposition: 'resolved' }] },
          }
        : createMockReviewResult([issue])
    );

    const config = {
      ...baseConfig,
      workflows: {
        verifyClean: {
          nodes: {
            change: { action: 'change-source', output: 'change' },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            artifact: {
              action: 'create-review-artifact',
              needs: ['review'],
              with: { source: 'change', review: 'review' },
              output: 'reviewArtifact',
            },
            save: {
              action: 'save-artifact',
              needs: ['artifact'],
              with: { kind: 'review', artifact: 'reviewArtifact' },
              output: 'persistedReviewArtifact',
            },
            fixChange: {
              action: 'change-source',
              needs: ['save'],
              with: { type: 'local', staged: true },
              output: 'fixChange',
            },
            reReview: {
              action: 'review',
              needs: ['fixChange'],
              with: { source: 'fixChange' },
              output: 'reReview',
            },
            verify: {
              action: 'verify-fix',
              needs: ['reReview'],
              with: { artifact: 'persistedReviewArtifact', review: 'reReview', severity: 'high' },
              output: 'persistedReviewArtifact',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'verifyClean', { workingDir: projectRoot });

    expect(result.artifacts.verify).toMatchObject({ shouldContinue: false, actionableOpen: 0 });
  });

  it('keeps unmatched findings open when the staged fix diff did not touch them', async () => {
    const projectRoot = createTempDir('drs-workflow-verify-fix-untouched-');
    const issue = {
      severity: 'HIGH',
      category: 'QUALITY',
      title: 'Untouched issue',
      file: 'src/app.ts',
      line: 50,
      problem: 'Original problem',
      solution: 'Original solution',
      references: [],
      agent: 'unified',
    };
    mocks.getFilesWithDiffs.mockReturnValue([
      { filename: 'src/app.ts', patch: '@@ -1,2 +1,2 @@\n-old\n+new' },
    ]);
    mocks.executeReview.mockImplementation(async (_config, source: { staged?: boolean }) =>
      source.staged ? createMockReviewResult([]) : createMockReviewResult([issue])
    );

    const config = {
      ...baseConfig,
      workflows: {
        verifyUntouched: {
          nodes: {
            change: { action: 'change-source', output: 'change' },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change' },
              output: 'review',
            },
            artifact: {
              action: 'create-review-artifact',
              needs: ['review'],
              with: { source: 'change', review: 'review' },
              output: 'reviewArtifact',
            },
            save: {
              action: 'save-artifact',
              needs: ['artifact'],
              with: { kind: 'review', artifact: 'reviewArtifact' },
              output: 'persistedReviewArtifact',
            },
            fixChange: {
              action: 'change-source',
              needs: ['save'],
              with: { type: 'local', staged: true },
              output: 'fixChange',
            },
            reReview: {
              action: 'review',
              needs: ['fixChange'],
              with: { source: 'fixChange' },
              output: 'reReview',
            },
            verify: {
              action: 'verify-fix',
              needs: ['reReview'],
              with: {
                artifact: 'persistedReviewArtifact',
                review: 'reReview',
                fixChange: 'fixChange',
                severity: 'high',
              },
              output: 'persistedReviewArtifact',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'verifyUntouched', { workingDir: projectRoot });
    const verified = result.artifacts.verify as {
      shouldContinue: boolean;
      actionableOpen: number;
      payload: { findings: Array<{ state: string; disposition: string }> };
    };

    expect(verified.shouldContinue).toBe(true);
    expect(verified.actionableOpen).toBe(1);
    expect(verified.payload.findings).toEqual([
      expect.objectContaining({ state: 'open', disposition: 'still_open' }),
    ]);
  });

  it('checks whether a workflow artifact exists', async () => {
    const projectRoot = createTempDir('drs-workflow-artifact-exists-');
    const config = {
      ...baseConfig,
      workflows: {
        artifactExists: {
          nodes: {
            save: {
              action: 'save-artifact',
              with: {
                kind: 'note',
                platform: 'local',
                projectId: 'demo',
                subject: 'run',
                payload: '{"ok":true}',
              },
              output: 'saved',
            },
            exists: {
              action: 'artifact-exists',
              needs: ['save'],
              with: {
                kind: 'note',
                platform: 'local',
                projectId: 'demo',
                subject: 'run',
              },
              output: 'exists',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'artifactExists', { workingDir: projectRoot });

    expect(result.artifacts.exists).toMatchObject({ exists: true, kind: 'note' });
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

  it('runs packaged local fix workflow with explicit verification over updated local diff', async () => {
    const projectRoot = createTempDir('drs-workflow-local-fix-loop-');
    const config = loadConfig(projectRoot);
    const issue = {
      severity: 'HIGH',
      category: 'QUALITY',
      title: 'Local issue',
      file: 'src/app.ts',
      line: 1,
      problem: 'Local problem',
      solution: 'Local solution',
      references: [],
      agent: 'unified',
    };
    mocks.executeReview.mockImplementation(
      async (_config, source: { files: string[]; context?: Record<string, unknown> }) => {
        if (source.context?.sourceType === 'fix-verification') {
          return {
            ...createMockReviewResult([]),
            verification: { findings: [{ id: 'F001', disposition: 'resolved' }] },
          };
        }
        return createMockReviewResult([issue]);
      }
    );

    await runWorkflow(config, 'local-review', {
      inputs: { staged: 'false' },
      workingDir: projectRoot,
    });

    const result = await runWorkflow(config, 'local-fix-review-issues', {
      inputs: { staged: 'false', fixSeverity: 'high', fixMaxIterations: '2' },
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledWith(
      config,
      'task/review-issue-fixer',
      expect.objectContaining({
        prompt: expect.stringContaining('saved local DRS review artifact'),
      })
    );
    expect(result.loop['fix-loop']).toMatchObject({ iteration: 1, lastDecision: 'exit' });
    expect(result.artifacts.persistedReviewArtifact).toMatchObject({
      shouldContinue: false,
      actionableOpen: 0,
      payload: {
        findings: [expect.objectContaining({ id: 'F001', disposition: 'resolved' })],
      },
    });
    const verificationSource = mocks.executeReview.mock.calls
      .map(
        (call) =>
          call[1] as {
            context?: { sourceType?: unknown; verification?: { artifact?: { reviewId?: string } } };
            filesWithDiffs?: Array<{ patch?: string }>;
          }
      )
      .find((source) => source.context?.sourceType === 'fix-verification');
    expect(verificationSource?.filesWithDiffs?.[0]?.patch).toBeDefined();
    expect(verificationSource?.context?.verification?.artifact?.reviewId).toMatch(/^rev_/);
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

  it('propagates review action failures as workflow errors', async () => {
    mocks.executeReview.mockImplementation(async () => {
      throw new Error('All review agents failed');
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

    await expect(runWorkflow(config, 'localReview')).rejects.toThrow('All review agents failed');
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
    expect(mocks.enforceRepoBranchMatch).not.toHaveBeenCalled();
    expect(mocks.executeReview).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: 'GitHub PR octocat/hello-world#7',
        files: ['src/github.ts'],
        workingDir: process.cwd(),
        context: expect.objectContaining({
          platform: 'github',
          projectId: 'octocat/hello-world',
          pullRequest: expect.objectContaining({ number: 7 }),
          changedFiles: [
            expect.objectContaining({ filename: 'src/github.ts', patch: '@@ +1 @@\n+github' }),
          ],
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

  it('runs packaged GitHub internal fix loop until re-review is clean', async () => {
    const projectRoot = createTempDir('drs-workflow-github-fix-loop-');
    const config = loadConfig(projectRoot);
    const originalIssue = createMockReviewIssue('Original issue');
    const reReviewResults = [
      {
        ...createMockReviewResult([]),
        verification: {
          findings: [
            {
              id: 'F001',
              disposition: 'still_open',
              rationale: 'The whitelist still rejects git-branch with.from.',
            },
          ],
        },
      },
      {
        ...createMockReviewResult([]),
        verification: { findings: [{ id: 'F001', disposition: 'resolved' }] },
      },
    ];
    mocks.getChangedFiles.mockReturnValue(['src/github.ts']);
    mocks.getFilesWithDiffs.mockReturnValue([
      { filename: 'src/github.ts', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
    ]);
    mocks.executeReview.mockImplementation(async (_config, source: { staged?: boolean }) =>
      source.staged
        ? (reReviewResults.shift() ?? createMockReviewResult([]))
        : createMockReviewResult([originalIssue])
    );

    const result = await runWorkflow(config, 'github-pr-review', {
      inputs: {
        owner: 'octocat',
        repo: 'hello-world',
        pr: '7',
        fix: 'true',
        fixMode: 'internal',
        fixSeverity: 'high',
        fixMaxIterations: '3',
      },
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/review-issue-fixer',
      'task/review-issue-fixer',
    ]);
    const secondFixPrompt = mocks.runAgent.mock.calls[1]?.[2]?.prompt ?? '';
    expect(secondFixPrompt).toContain('Review artifact path:');
    expect(secondFixPrompt).toContain('read_artifact');
    expect(secondFixPrompt).toContain('drs_check');
    expect(result.loop['fix-loop']).toMatchObject({
      iteration: 2,
      maxIterations: 3,
      lastDecision: 'exit',
    });
    expect(result.artifacts.fixStatus).toMatchObject({
      resolved: 1,
      stillOpen: 0,
      regression: 0,
    });
    const verificationSources = mocks.executeReview.mock.calls
      .map(
        (call) =>
          call[1] as {
            context?: {
              sourceType?: unknown;
              verification?: { artifact?: { findings?: Array<{ id?: string }> } };
            };
            filesWithDiffs?: Array<{ patch?: string }>;
          }
      )
      .filter((source) => source?.context?.sourceType === 'fix-verification');
    expect(verificationSources).toHaveLength(2);
    expect(verificationSources[0]?.filesWithDiffs?.[0]?.patch).toBeDefined();
    expect(verificationSources[0]?.context?.verification?.artifact?.findings?.[0]?.id).toBe('F001');
    expect(mocks.githubAdapter.createChangeRequest).not.toHaveBeenCalled();
    expect(mocks.githubAdapter.createComment).toHaveBeenCalledWith(
      'octocat/hello-world',
      7,
      expect.stringContaining('Resolved')
    );
    expect(mocks.git.commit).toHaveBeenCalledWith('fix: address DRS review issues for PR #7', [
      '.',
    ]);
    expect(mocks.git.raw).toHaveBeenCalledWith(['push', 'origin', 'HEAD:feature']);
  });

  it('exits packaged GitHub internal fix loop at maxIterations and reports still-open findings', async () => {
    const projectRoot = createTempDir('drs-workflow-github-fix-max-');
    const config = loadConfig(projectRoot);
    const issue = createMockReviewIssue('Persistent issue');
    mocks.executeReview.mockResolvedValue(createMockReviewResult([issue]));

    const result = await runWorkflow(config, 'github-pr-review', {
      inputs: {
        owner: 'octocat',
        repo: 'hello-world',
        pr: '7',
        fix: 'true',
        fixMode: 'internal',
        fixSeverity: 'high',
        fixMaxIterations: '2',
      },
      workingDir: projectRoot,
    });

    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    expect(result.loop['fix-loop']).toMatchObject({
      iteration: 2,
      maxIterations: 2,
      lastDecision: 'exit',
    });
    expect(result.artifacts.fixStatus).toMatchObject({
      resolved: 0,
      stillOpen: 1,
      regression: 0,
    });
    expect(mocks.githubAdapter.createChangeRequest).not.toHaveBeenCalled();
    expect(mocks.githubAdapter.createComment).toHaveBeenCalledWith(
      'octocat/hello-world',
      7,
      expect.stringContaining('Still Open')
    );
    expect(mocks.git.commit).toHaveBeenCalledWith('fix: address DRS review issues for PR #7', [
      '.',
    ]);
    expect(mocks.git.raw).toHaveBeenCalledWith(['push', 'origin', 'HEAD:feature']);
  });

  it('exits packaged GitHub internal fix loop after one diverging iteration and commits partial fix', async () => {
    const projectRoot = createTempDir('drs-workflow-github-fix-one-iter-');
    const config = loadConfig(projectRoot);
    const issue = createMockReviewIssue('One-iter divergent issue');
    mocks.executeReview.mockResolvedValue(createMockReviewResult([issue]));

    const result = await runWorkflow(config, 'github-pr-review', {
      inputs: {
        owner: 'octocat',
        repo: 'hello-world',
        pr: '7',
        fix: 'true',
        fixMode: 'internal',
        fixSeverity: 'high',
        fixMaxIterations: '1',
      },
      workingDir: projectRoot,
    });

    // The loop ran exactly one fixer iter, hit maxIterations. With the partial
    // commit gate, commit and push happen when fixFiles > 0 even if issues
    // remain open, so partial fixes are preserved.
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(result.loop['fix-loop']).toMatchObject({
      iteration: 1,
      maxIterations: 1,
      lastDecision: 'exit',
    });
    expect(mocks.githubAdapter.createChangeRequest).not.toHaveBeenCalled();
    expect(mocks.git.commit).toHaveBeenCalledWith('fix: address DRS review issues for PR #7', [
      '.',
    ]);
    expect(mocks.git.raw).toHaveBeenCalledWith(['push', 'origin', 'HEAD:feature']);
    expect(result.artifacts.fixStatus).toMatchObject({
      resolved: 0,
      stillOpen: 1,
      regression: 0,
    });
  });

  it('resumes packaged GitHub internal fix flow from checkpoint without re-running completed fixer work', async () => {
    const projectRoot = createTempDir('drs-workflow-github-fix-resume-');
    const config = loadConfig(projectRoot);
    const issue = createMockReviewIssue('Resumable issue');
    let failReReview = true;
    mocks.getChangedFiles.mockReturnValue(['src/github.ts']);
    mocks.getFilesWithDiffs.mockReturnValue([
      { filename: 'src/github.ts', patch: '@@ -1,1 +1,1 @@\n-old\n+new' },
    ]);
    mocks.executeReview.mockImplementation(async (_config, source: { staged?: boolean }) => {
      if (source.staged) {
        if (failReReview) {
          failReReview = false;
          throw new Error('temporary re-review failure');
        }
        return {
          ...createMockReviewResult([]),
          verification: { findings: [{ id: 'F001', disposition: 'resolved' }] },
        };
      }
      return createMockReviewResult([issue]);
    });

    const inputs = {
      owner: 'octocat',
      repo: 'hello-world',
      pr: '7',
      fix: 'true',
      fixMode: 'internal',
      fixSeverity: 'high',
      fixMaxIterations: '2',
    };
    const checkpointKey = 'github-fix-resume';
    const checkpointPath = join(projectRoot, '.drs', 'checkpoints', `${checkpointKey}.json`);

    await expect(
      runWorkflow(config, 'github-pr-review', {
        inputs,
        workingDir: projectRoot,
        resume: true,
        checkpointKey,
      })
    ).rejects.toThrow('temporary re-review failure');
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const checkpointText = readFileSync(checkpointPath, 'utf-8');
    expect(checkpointText).not.toContain('[circular]');
    expect(JSON.parse(checkpointText)).toMatchObject({
      workflow: 'github-pr-review',
      nodes: {
        'fix-issues': { status: 'success' },
        'verification-change': { status: 'success' },
      },
      failure: { nodeId: 're-review', message: 'temporary re-review failure' },
    });

    const result = await runWorkflow(config, 'github-pr-review', {
      inputs,
      workingDir: projectRoot,
      resume: true,
      checkpointKey,
    });

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    expect(mocks.executeReview.mock.calls.filter((call) => call[1]?.staged).length).toBe(2);
    expect(result.artifacts.fixStatus).toMatchObject({ resolved: 1, stillOpen: 0 });
    expect(() => readFileSync(checkpointPath, 'utf-8')).toThrow();
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
    expect(mocks.enforceRepoBranchMatch).not.toHaveBeenCalled();
    expect(mocks.executeReview).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        name: 'GitLab MR group/repo!8',
        files: ['src/gitlab.ts'],
        workingDir: process.cwd(),
        context: expect.objectContaining({
          platform: 'gitlab',
          projectId: 'group/repo',
          pullRequest: expect.objectContaining({ number: 8 }),
          changedFiles: [
            expect.objectContaining({ filename: 'src/gitlab.ts', patch: '@@ +1 @@\n+gitlab' }),
          ],
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

  it('runs executable nodes only when their direct if condition matches', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });

    const config = {
      ...baseConfig,
      workflows: {
        conditional: {
          nodes: {
            count: { agent: 'task/count', input: '2', output: 'count' },
            positive: {
              agent: 'task/positive',
              needs: ['count'],
              if: '{{artifacts.count}} > 0',
              input: 'positive {{artifacts.count}}',
            },
            negative: {
              agent: 'task/negative',
              needs: ['count'],
              if: '{{artifacts.count}} < 0',
              input: 'negative',
            },
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
    expect(result.nodes.negative).toMatchObject({ type: 'skipped', status: 'skipped' });
  });

  it('skips executable nodes when a dependency was skipped', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        conditionalDependency: {
          nodes: {
            prerequisite: { agent: 'task/prerequisite', input: 'prepared', output: 'prerequisite' },
            target: {
              agent: 'task/target',
              needs: ['prerequisite'],
              if: 'false',
              input: 'target {{artifacts.prerequisite}}',
              output: 'target',
            },
            follower: {
              agent: 'task/follower',
              needs: ['target'],
              input: 'follower {{artifacts.target}}',
              output: 'follower',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'conditionalDependency', {
      workingDir: process.cwd(),
    });

    expect(result.nodes.prerequisite).toMatchObject({ type: 'agent' });
    expect(result.nodes.target).toMatchObject({ status: 'skipped' });
    expect(result.nodes.follower).toMatchObject({ status: 'skipped' });
    expect(result.artifacts.target).toBeUndefined();
    expect(result.artifacts.follower).toBeUndefined();
  });

  it('logs skipped nodes as skipped instead of running', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        skipLogs: {
          inputs: { enabled: 'false' },
          nodes: {
            start: { agent: 'task/start', input: 'start', output: 'start' },
            optional: {
              agent: 'task/optional',
              needs: ['start'],
              if: '{{inputs.enabled}} == true',
              input: 'optional',
            },
            dependent: { agent: 'task/dependent', needs: ['optional'], input: 'dependent' },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'skipLogs');

    const logs = logSpy.mock.calls.map((call) => String(call[0]));
    expect(logs.some((log) => log.includes('Running node start...'))).toBe(true);
    expect(
      logs.some((log) =>
        log.includes('Skipping node optional (condition false: {{inputs.enabled}} == true)')
      )
    ).toBe(true);
    expect(
      logs.some((log) => log.includes('Skipping node dependent (dependency skipped: optional)'))
    ).toBe(true);
    expect(logs.some((log) => log.includes('Running node optional...'))).toBe(false);
    expect(logs.some((log) => log.includes('Running node dependent...'))).toBe(false);

    logSpy.mockRestore();
  });

  it('continues past optional directly conditioned nodes', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        optionalDescribe: {
          inputs: { describe: 'true' },
          nodes: {
            describe: {
              agent: 'task/describe',
              if: '{{inputs.describe}} == true',
              input: 'describe',
              output: 'description',
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
    expect(described.nodes.review).toMatchObject({ type: 'agent' });

    mocks.runAgent.mockClear();

    const reviewedOnly = await runWorkflow(config, 'optionalDescribe', {
      inputs: { describe: 'false' },
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual(['task/review']);
    expect(reviewedOnly.nodes.describe).toMatchObject({ status: 'skipped' });
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
            enabled: {
              agent: 'task/enabled',
              if: '{{inputs.enabled}} == true',
              input: 'enabled',
            },
            disabled: {
              agent: 'task/disabled',
              if: '{{inputs.enabled}} != true',
              input: 'disabled',
            },
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

  it('evaluates compound direct if conditions with precedence, quotes, and parentheses', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        compoundConditions: {
          inputs: { value: 'a && b' },
          nodes: {
            precedence: {
              agent: 'task/precedence',
              if: 'false && true || true',
              input: 'precedence',
            },
            quoted: {
              agent: 'task/quoted',
              if: '"{{inputs.value}}" == "a && b"',
              input: 'quoted',
            },
            parenthesized: {
              agent: 'task/parenthesized',
              if: '(false && true) || true',
              input: 'parenthesized',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'compoundConditions');

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/precedence',
      'task/quoted',
      'task/parenthesized',
    ]);
    expect(result.nodes.precedence).toMatchObject({ type: 'agent' });
    expect(result.nodes.quoted).toMatchObject({ type: 'agent' });
    expect(result.nodes.parenthesized).toMatchObject({ type: 'agent' });
  });

  it('skips executable nodes when a direct if condition is false', async () => {
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      return createMockAgentResult(agent, options.prompt ?? agent);
    });
    const config = {
      ...baseConfig,
      workflows: {
        optionalDescribe: {
          inputs: { describe: 'false' },
          nodes: {
            describe: {
              agent: 'task/describe',
              if: '{{inputs.describe}} == true',
              input: 'describe',
              output: 'description',
            },
            review: { agent: 'task/review', input: 'review', output: 'review' },
          },
        },
      },
    } as unknown as DRSConfig;

    const skipped = await runWorkflow(config, 'optionalDescribe', {
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual(['task/review']);
    expect(skipped.nodes.describe).toMatchObject({ type: 'skipped', status: 'skipped' });
    expect(skipped.artifacts.description).toBeUndefined();
    expect(skipped.nodes.review).toMatchObject({ type: 'agent' });

    mocks.runAgent.mockClear();

    const described = await runWorkflow(config, 'optionalDescribe', {
      inputs: { describe: 'true' },
      workingDir: process.cwd(),
    });

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/describe',
      'task/review',
    ]);
    expect(described.nodes.describe).toMatchObject({ type: 'agent' });
    expect(described.artifacts.description).toBe('describe');
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
            fix: {
              agent: 'task/fix',
              needs: ['review'],
              if: '{{artifacts.review}} != clean',
              input: 'fix {{artifacts.review}}',
            },
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
      iteration: 2,
      maxIterations: 3,
      lastDecision: 'loop',
    });
    expect(result.artifacts.review).toBe('clean');
  });

  it('counts maxIterations as total target executions including the initial pass', async () => {
    const reviewOutputs = ['issues', 'issues', 'clean'];
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
            fix: {
              agent: 'task/fix',
              needs: ['review'],
              if: '{{artifacts.review}} != clean',
              input: 'fix {{artifacts.review}}',
            },
            repeat: {
              control: 'loop',
              needs: ['fix'],
              condition: '{{artifacts.review}} != clean',
              target: 'review',
              exit: 'done',
              maxIterations: 2,
              onMaxIterations: 'exit',
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
      'task/fix',
      'task/done',
    ]);
    expect(result.loop.repeat).toMatchObject({
      iteration: 2,
      maxIterations: 2,
      lastDecision: 'exit',
    });
    expect(result.artifacts.review).toBe('issues');
  });

  it('does not rerun completed prerequisites when a loop re-enters a target node', async () => {
    const checkOutputs = ['again', 'done'];
    mocks.runAgent.mockImplementation(async (_config, agent, options) => {
      if (agent === 'task/check') {
        return createMockAgentResult(agent, checkOutputs.shift() ?? 'done');
      }
      return createMockAgentResult(agent, options.prompt ?? agent);
    });

    const config = {
      ...baseConfig,
      workflows: {
        loopTargetDependency: {
          nodes: {
            setup: { agent: 'task/setup', input: 'prepared', output: 'setup' },
            fix: {
              agent: 'task/fix',
              needs: ['setup'],
              input: 'fix {{artifacts.setup}}',
              output: 'fix',
            },
            check: {
              agent: 'task/check',
              needs: ['fix'],
              input: 'check {{artifacts.fix}}',
              output: 'check',
            },
            repeat: {
              control: 'loop',
              needs: ['check'],
              condition: '{{artifacts.check}} != done',
              target: 'fix',
              exit: 'done',
              maxIterations: 2,
            },
            done: { agent: 'task/done', input: 'done {{artifacts.check}}' },
          },
        },
      },
    } as unknown as DRSConfig;

    await runWorkflow(config, 'loopTargetDependency');

    expect(mocks.runAgent.mock.calls.map((call) => call[1])).toEqual([
      'task/setup',
      'task/fix',
      'task/check',
      'task/fix',
      'task/check',
      'task/done',
    ]);
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
            done: {
              needs: ['start'],
              agent: 'task/review',
              if: '${{ inputs.enabled }}',
              input: '${{ artifacts.result }}',
            },
            stop: { control: 'end' },
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
          id: 'done',
          kind: 'agent',
          needs: ['start'],
          agent: 'task/review',
          if: '${{ inputs.enabled }}',
        }),
      ])
    );
  });

  it('throws for unknown workflow details', () => {
    expect(() => showWorkflow(baseConfig, 'missing', { workingDir: process.cwd() })).toThrow(
      'Unknown workflow "missing".'
    );
  });

  it('posts a fix-status comment comparing original findings against re-review', async () => {
    const projectRoot = createTempDir('drs-workflow-fix-status-');
    mocks.executeReview.mockImplementation(
      async (_config, source: { files: string[]; staged?: boolean }) => {
        if (source.staged) {
          return {
            issues: [
              {
                severity: 'HIGH',
                category: 'QUALITY',
                title: 'New regression in fixed file',
                file: 'src/cli/workflow.ts',
                line: 570,
                problem: 'New issue introduced by the fix',
                solution: 'Avoid introducing regressions',
                agent: 'unified',
              },
            ],
            verification: {
              findings: [{ id: 'F001', disposition: 'resolved', rationale: 'fixed' }],
            },
            summary: {
              filesReviewed: 1,
              issuesFound: 1,
              bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
              byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
            },
            filesReviewed: 1,
          };
        }
        return {
          issues: [
            {
              severity: 'HIGH',
              category: 'QUALITY',
              title: 'Truncation corrupts state',
              file: 'src/cli/workflow.ts',
              line: 566,
              problem: 'Truncation',
              solution: 'Use file size guard',
              agent: 'unified',
            },
          ],
          summary: {
            filesReviewed: 1,
            issuesFound: 1,
            bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
            byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
          },
          filesReviewed: 1,
        };
      }
    );
    mocks.git.diff.mockResolvedValue('diff --git a/src/cli/workflow.ts b/src/cli/workflow.ts');
    mocks.getFilesWithDiffs.mockReturnValue([
      {
        filename: 'src/cli/workflow.ts',
        patch:
          '@@ -100 +100 @@\n-old unrelated\n+new unrelated\n@@ -560,12 +560,13 @@\n context\n-old\n+new\n+regression',
      },
    ]);
    mocks.githubAdapter.getComments.mockResolvedValue([]);
    mocks.githubAdapter.createComment.mockResolvedValue(undefined);

    const config = {
      ...baseConfig,
      workflows: {
        fixStatus: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change', artifact: 'persistedReviewArtifact' },
              output: 'review',
            },
            'fix-change': {
              action: 'change-source',
              with: { type: 'local', staged: true },
              output: 'fixChange',
            },
            're-review': {
              action: 'review',
              needs: ['fix-change'],
              with: { source: 'fixChange' },
              output: 'reReview',
            },
            'post-status': {
              action: 'post-fix-status',
              needs: ['verify'],
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                pr: '7',
                source: 'change',
                reviewArtifact: 'persistedReviewArtifact',
                fixReview: 'reReview',
                fixChange: 'fixChange',
                severity: 'high',
                marker: 'drs-fix-status',
              },
              output: 'fixStatus',
            },
            verify: {
              action: 'verify-fix',
              needs: ['re-review', 'review', 'fix-change'],
              with: {
                artifact: 'persistedReviewArtifact',
                review: 'reReview',
                fixChange: 'fixChange',
                severity: 'high',
              },
              output: 'persistedReviewArtifact',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'fixStatus', { workingDir: projectRoot });

    expect(mocks.githubAdapter.createComment).toHaveBeenCalledTimes(1);
    const commentBody = mocks.githubAdapter.createComment.mock.calls[0]?.[2] as string;
    expect(commentBody).toContain('drs-fix-status');
    expect(commentBody).toContain('Fix Status');
    expect(commentBody).toContain('Truncation corrupts state');
    expect(commentBody).toContain('Resolved');
    expect(commentBody).toContain('New regression in fixed file');
    expect(commentBody).toContain('Regression');
    expect(commentBody).toContain('@@ -560,12 +560,13 @@');
    expect(commentBody).not.toContain('@@ -100 +100 @@');
    expect(result.artifacts.fixStatus).toMatchObject({
      resolved: 1,
      regression: 1,
      stillOpen: 0,
    });
  });

  it('posts fix-status with attempted disposition when no re-review is provided', async () => {
    const projectRoot = createTempDir('drs-workflow-fix-status-attempted-');
    mocks.executeReview.mockResolvedValue({
      issues: [
        {
          severity: 'HIGH',
          category: 'QUALITY',
          title: 'Shared activeNodeId race',
          file: 'src/cli/workflow.ts',
          line: 3478,
          problem: 'Race condition',
          solution: 'Propagate with rejection',
          agent: 'unified',
        },
      ],
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
        byCategory: { SECURITY: 0, QUALITY: 1, STYLE: 0, PERFORMANCE: 0, DOCUMENTATION: 0 },
      },
      filesReviewed: 1,
    });
    mocks.git.diff.mockResolvedValue('diff --git a/src/cli/workflow.ts b/src/cli/workflow.ts');
    mocks.getFilesWithDiffs.mockReturnValue([
      { filename: 'src/cli/workflow.ts', patch: '@@ -3478 +3478 @@\n-old\n+new' },
    ]);
    mocks.githubAdapter.getComments.mockResolvedValue([]);
    mocks.githubAdapter.createComment.mockResolvedValue(undefined);

    const config = {
      ...baseConfig,
      workflows: {
        fixStatusAttempted: {
          nodes: {
            change: {
              action: 'change-source',
              with: { type: 'github-pr', owner: 'octocat', repo: 'hello-world', pr: 7 },
              output: 'change',
            },
            review: {
              action: 'review',
              needs: ['change'],
              with: { source: 'change', artifact: 'persistedReviewArtifact' },
              output: 'review',
            },
            'fix-change': {
              action: 'change-source',
              with: { type: 'local', staged: true },
              output: 'fixChange',
            },
            'post-status': {
              action: 'post-fix-status',
              needs: ['review'],
              with: {
                platform: 'github',
                owner: 'octocat',
                repo: 'hello-world',
                pr: '7',
                source: 'change',
                reviewArtifact: 'persistedReviewArtifact',
                fixChange: 'fixChange',
                stackedPrUrl: 'https://github.com/octocat/hello-world/pull/99',
                marker: 'drs-fix-status',
              },
              output: 'fixStatus',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runWorkflow(config, 'fixStatusAttempted', { workingDir: projectRoot });

    const commentBody = mocks.githubAdapter.createComment.mock.calls[0]?.[2] as string;
    expect(commentBody).toContain('Attempted');
    expect(commentBody).toContain('Shared activeNodeId race');
    expect(commentBody).toContain('https://github.com/octocat/hello-world/pull/99');
    expect(result.artifacts.fixStatus).toMatchObject({
      attempted: 1,
      resolved: 0,
    });
  });
});

describe('dispatch ↔ validator drift', () => {
  // Pins the contract that every action dispatched by runActionWorkflowNode
  // is also listed in SUPPORTED_WORKFLOW_ACTIONS, so an action added to the
  // runtime switch without mirroring the tuple fails CI instead of bypassing
  // load-time validation. Direction is loose (dispatch-facing): the tuple may
  // legitimately lead (deprecation paths, staged rollouts); only the reverse
  // drift — dispatch references unknown action — is enforced.
  it('every action literal in runActionWorkflowNode is in SUPPORTED_WORKFLOW_ACTIONS', () => {
    const dispatchUrl = new URL('../cli/workflow.ts', import.meta.url);
    const dispatchSrc = readFileSync(dispatchUrl, 'utf-8');
    const used = new Set([...dispatchSrc.matchAll(/node\.action === '([^']+)'/g)].map((m) => m[1]));
    expect(
      used.size,
      'dispatch file has zero node.action === "X" literals — drift test cannot proceed'
    ).toBeGreaterThan(0);
    for (const action of used) {
      expect(
        SUPPORTED_WORKFLOW_ACTIONS as readonly string[],
        `dispatch references '${action}' but SUPPORTED_WORKFLOW_ACTIONS does not list it`
      ).toContain(action);
    }
  });
});
