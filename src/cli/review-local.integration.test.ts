import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { reviewLocal } from './review-local.js';

const mocks = vi.hoisted(() => ({
  git: {
    checkIsRepo: vi.fn(),
    diff: vi.fn(),
  },
  createRuntimeClientInstance: vi.fn(),
  createSession: vi.fn(),
  streamMessages: vi.fn(),
  closeSession: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: vi.fn(() => mocks.git),
}));

vi.mock('../runtime/client.js', () => ({
  createRuntimeClientInstance: mocks.createRuntimeClientInstance,
}));

const simulatedDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@',
  ' export function run(input: string) {',
  '+  const query = "SELECT * FROM users WHERE id = " + input;',
  '   return input;',
  ' }',
  'diff --git a/src/app.test.ts b/src/app.test.ts',
  'index 3333333..4444444 100644',
  '--- a/src/app.test.ts',
  '+++ b/src/app.test.ts',
  '@@ -1,2 +1,3 @@',
  ' test("run", () => {',
  '+  expect(true).toBe(true);',
  ' });',
].join('\n');

const simulatedCliDiff = [
  'diff --git a/src/cli/index.ts b/src/cli/index.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/cli/index.ts',
  '+++ b/src/cli/index.ts',
  '@@ -60,6 +60,7 @@ program',
  "   .command('review-local')",
  "   .description('Review local changes before pushing')",
  "+  .option('--skip-repo-check', 'Skip git repository validation for advanced usage')",
  "   .option('--staged', 'Review staged changes only')",
  "   .option('--output <path>', 'Write review results to JSON file')",
  "   .option('--json', 'Output raw JSON to stdout')",
].join('\n');

const integrationConfig = {
  pi: {},
  gitlab: { url: '', token: '' },
  github: { token: '' },
  review: {
    agents: ['security'],
    default: {
      model: 'anthropic/claude-sonnet-4-5-20250929',
      skills: [],
    },
    ignorePatterns: ['*.test.ts'],
    mode: 'multi-agent',
    describe: {
      enabled: false,
      postDescription: false,
    },
  },
  describe: {
    includeProjectContext: false,
  },
  contextCompression: {
    enabled: false,
  },
} as unknown as DRSConfig;

describe('review-local integration (simulated diffs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mocks.git.checkIsRepo.mockResolvedValue(true);
    mocks.git.diff.mockResolvedValue(simulatedDiff);

    mocks.createSession.mockResolvedValue({
      id: 'session-1',
      agent: 'review/security',
      createdAt: new Date('2026-02-22T00:00:00Z'),
    });

    const reviewPayload = {
      timestamp: '2026-02-22T00:00:00Z',
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: {
          CRITICAL: 0,
          HIGH: 0,
          MEDIUM: 0,
          LOW: 1,
        },
        byCategory: {
          SECURITY: 1,
          QUALITY: 0,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 0,
        },
      },
      issues: [
        {
          category: 'SECURITY',
          severity: 'LOW',
          title: 'Avoid SQL string concatenation',
          file: 'src/app.ts',
          line: 2,
          problem: 'Query strings are built using concatenated user input.',
          solution: 'Use parameterized queries to avoid injection risks.',
          references: [],
          agent: 'security',
        },
      ],
    };

    mocks.streamMessages.mockImplementation(async function* () {
      yield {
        id: 'assistant-1',
        role: 'assistant',
        content: JSON.stringify(reviewPayload),
        timestamp: new Date('2026-02-22T00:00:01Z'),
      };
    });

    mocks.closeSession.mockResolvedValue(undefined);
    mocks.shutdown.mockResolvedValue(undefined);

    mocks.createRuntimeClientInstance.mockResolvedValue({
      createSession: mocks.createSession,
      streamMessages: mocks.streamMessages,
      closeSession: mocks.closeSession,
      shutdown: mocks.shutdown,
      getMinContextWindow: vi.fn(() => undefined),
    });
  });

  it('runs review-local end-to-end using parsed git diff input and filtered files', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    await reviewLocal(integrationConfig, { staged: false, jsonOutput: false, debug: false });

    expect(mocks.git.diff).toHaveBeenCalledWith();
    expect(mocks.createRuntimeClientInstance).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'review/security',
      })
    );

    const prompt = (mocks.createSession.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('src/app.ts');
    expect(prompt).not.toContain('src/app.test.ts');
    expect(prompt).toContain('+  const query = "SELECT * FROM users WHERE id = " + input;');

    expect(mocks.streamMessages).toHaveBeenCalledWith('session-1');
    expect(mocks.closeSession).toHaveBeenCalledWith('session-1');
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it('logs configured skill usage when reviewing CLI flag changes', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    mocks.git.diff.mockResolvedValue(simulatedCliDiff);

    const reviewPayload = {
      timestamp: '2026-02-22T00:00:00Z',
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: {
          CRITICAL: 0,
          HIGH: 0,
          MEDIUM: 1,
          LOW: 0,
        },
        byCategory: {
          SECURITY: 0,
          QUALITY: 1,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 0,
        },
      },
      issues: [
        {
          category: 'QUALITY',
          severity: 'MEDIUM',
          title: 'Missing integration test for new review-local CLI flag',
          file: 'src/cli/index.ts',
          line: 63,
          problem: 'A new CLI flag was introduced without integration-level coverage.',
          solution:
            'Add an integration test that verifies the new flag is parsed and propagated to command execution.',
          references: [],
          agent: 'quality',
        },
      ],
    };

    mocks.streamMessages.mockImplementation(async function* () {
      yield {
        id: 'tool-1',
        role: 'tool',
        toolName: 'skill',
        content: JSON.stringify({ name: 'cli-testing', usage: 'applied' }),
        timestamp: new Date('2026-02-22T00:00:00Z'),
      };

      yield {
        id: 'assistant-2',
        role: 'assistant',
        content: JSON.stringify(reviewPayload),
        timestamp: new Date('2026-02-22T00:00:01Z'),
      };
    });

    const configWithCliSkill = {
      ...integrationConfig,
      review: {
        ...integrationConfig.review,
        agents: ['quality'],
        default: {
          ...integrationConfig.review.default,
          skills: ['cli-testing'],
        },
      },
    } as unknown as DRSConfig;

    await reviewLocal(configWithCliSkill, { staged: false, jsonOutput: false, debug: false });

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'review/quality',
      })
    );

    const prompt = (mocks.createSession.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('src/cli/index.ts');
    expect(prompt).toContain("+  .option('--skip-repo-check'");

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Loaded skill: cli-testing'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it('custom agent override prompt flows through to session message', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    // Dynamically mock buildReviewPrompt to simulate agent override
    const contextLoader = await import('../lib/context-loader.js');
    const buildPromptSpy = vi
      .spyOn(contextLoader, 'buildReviewPrompt')
      .mockImplementation(
        (_agentName: string, _basePrompt: string, reviewLabel: string, changedFiles: string[]) => {
          return (
            `# Custom Rails Security Agent\n\n` +
            `Focus on mass assignment and CSRF.\n\n` +
            `Review the following files from ${reviewLabel}:\n` +
            changedFiles.map((f) => `- ${f}`).join('\n')
          );
        }
      );

    const reviewPayload = {
      timestamp: '2026-02-22T00:00:00Z',
      summary: {
        filesReviewed: 1,
        issuesFound: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        byCategory: {
          SECURITY: 0,
          QUALITY: 0,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 0,
        },
      },
      issues: [],
    };

    mocks.streamMessages.mockImplementation(async function* () {
      yield {
        id: 'assistant-1',
        role: 'assistant',
        content: JSON.stringify(reviewPayload),
        timestamp: new Date('2026-02-22T00:00:01Z'),
      };
    });

    await reviewLocal(integrationConfig, { staged: false, jsonOutput: false, debug: false });

    expect(buildPromptSpy).toHaveBeenCalledWith(
      'security',
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      expect.anything(),
      undefined
    );

    const prompt = (mocks.createSession.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('Custom Rails Security Agent');
    expect(prompt).toContain('mass assignment and CSRF');
    expect(prompt).toContain('src/app.ts');

    buildPromptSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('new custom agent runs when configured in review.agents', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    // Mock agent-loader to include a brand new custom agent
    const agentLoader = await import('../runtime/agent-loader.js');
    const loadAgentsSpy = vi.spyOn(agentLoader, 'loadReviewAgents').mockReturnValue([
      {
        name: 'review/api-reviewer',
        path: '/project/.drs/agents/api-reviewer/agent.md',
        description: 'API contract reviewer',
        prompt: 'Review REST API contracts and OpenAPI compliance.',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      },
    ]);

    const reviewPayload = {
      timestamp: '2026-02-22T00:00:00Z',
      summary: {
        filesReviewed: 1,
        issuesFound: 1,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
        byCategory: {
          SECURITY: 0,
          QUALITY: 0,
          STYLE: 0,
          PERFORMANCE: 0,
          DOCUMENTATION: 1,
        },
      },
      issues: [
        {
          category: 'DOCUMENTATION',
          severity: 'MEDIUM',
          title: 'Missing API endpoint docs',
          file: 'src/app.ts',
          line: 2,
          problem: 'New endpoint lacks OpenAPI annotations.',
          solution: 'Add @swagger JSDoc annotations.',
          references: [],
          agent: 'api-reviewer',
        },
      ],
    };

    mocks.streamMessages.mockImplementation(async function* () {
      yield {
        id: 'assistant-1',
        role: 'assistant',
        content: JSON.stringify(reviewPayload),
        timestamp: new Date('2026-02-22T00:00:01Z'),
      };
    });

    const configWithNewAgent = {
      ...integrationConfig,
      review: {
        ...integrationConfig.review,
        agents: ['api-reviewer'],
      },
    } as unknown as DRSConfig;

    await reviewLocal(configWithNewAgent, { staged: false, jsonOutput: false, debug: false });

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'review/api-reviewer',
      })
    );

    const prompt = (mocks.createSession.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('src/app.ts');

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    loadAgentsSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
