import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DRSConfig } from '../lib/config.js';
import { runAgent } from './run-agent.js';

const mocks = vi.hoisted(() => {
  const runtimeClient = {
    createSession: vi.fn(async () => ({
      id: 'session-123',
      agent: 'task/docs-updater',
      createdAt: new Date(),
    })),
    streamMessages: vi.fn(async function* () {
      yield {
        id: 'msg-1',
        role: 'assistant',
        content: 'Updated docs summary',
        timestamp: new Date(),
        provider: 'provider',
        model: 'default-model',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: 0.001,
        },
      };
    }),
    closeSession: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };

  return {
    runtimeClient,
    createRuntimeClientInstance: vi.fn(async () => runtimeClient),
    getAgent: vi.fn(() => ({
      id: 'task/docs-updater',
      namespace: 'task',
      name: 'docs-updater',
      path: '/tmp/docs-updater.md',
      description: 'Docs updater',
    })),
  };
});

vi.mock('../runtime/client.js', () => ({
  createRuntimeClientInstance: mocks.createRuntimeClientInstance,
}));

vi.mock('../runtime/agent-loader.js', () => ({
  getAgent: mocks.getAgent,
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

describe('run-agent', () => {
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.getAgent.mockReturnValue({
      id: 'task/docs-updater',
      namespace: 'task',
      name: 'docs-updater',
      path: '/tmp/docs-updater.md',
      description: 'Docs updater',
    });
    mocks.createRuntimeClientInstance.mockResolvedValue(mocks.runtimeClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a non-review agent by fully qualified id', async () => {
    const result = await runAgent(baseConfig, 'task/docs-updater', {
      prompt: 'Summarize docs changes',
      workingDir: process.cwd(),
    });

    expect(mocks.getAgent).toHaveBeenCalledWith(process.cwd(), 'task/docs-updater', baseConfig);
    expect(mocks.createRuntimeClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        config: baseConfig,
        directory: process.cwd(),
        modelOverrides: undefined,
      })
    );
    expect(mocks.runtimeClient.createSession).toHaveBeenCalledWith({
      agent: 'task/docs-updater',
      message: 'Summarize docs changes',
    });
    expect(result.response).toBe('Updated docs summary');
    expect(result.usage.success).toBe(true);
    expect(mocks.runtimeClient.closeSession).toHaveBeenCalledWith('session-123');
    expect(mocks.runtimeClient.shutdown).toHaveBeenCalled();
  });

  it('passes per-run model override to runtime client', async () => {
    await runAgent(baseConfig, 'task/docs-updater', {
      prompt: 'Use a specific model',
      model: 'provider/special-model',
      workingDir: process.cwd(),
    });

    expect(mocks.createRuntimeClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverrides: {
          'task/docs-updater': 'provider/special-model',
        },
      })
    );
  });

  it('reads prompt from a file and writes JSON output', async () => {
    const projectRoot = createTempDir('drs-run-agent-');
    writeFileSync(join(projectRoot, 'prompt.md'), 'Prompt from file');

    const result = await runAgent(baseConfig, 'task/docs-updater', {
      file: 'prompt.md',
      outputPath: 'agent-output.json',
      jsonOutput: true,
      workingDir: projectRoot,
    });

    expect(mocks.runtimeClient.createSession).toHaveBeenCalledWith({
      agent: 'task/docs-updater',
      message: 'Prompt from file',
    });
    expect(result.response).toBe('Updated docs summary');
  });

  it('runs using prompt and output settings from agent config only', async () => {
    const projectRoot = createTempDir('drs-run-agent-config-');
    const config = {
      ...baseConfig,
      agents: {
        default: { model: 'provider/default-model', skills: [] },
        overrides: {
          'task/docs-updater': {
            thinkingLevel: 'high',
            run: {
              prompt: 'Configured prompt',
              output: 'agent-output.json',
              json: true,
            },
          },
        },
      },
    } as unknown as DRSConfig;

    const result = await runAgent(config, 'task/docs-updater', {
      workingDir: projectRoot,
    });

    expect(mocks.createRuntimeClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingLevel: 'high',
      })
    );
    expect(mocks.runtimeClient.createSession).toHaveBeenCalledWith({
      agent: 'task/docs-updater',
      message: 'Configured prompt',
    });

    const output = JSON.parse(readFileSync(join(projectRoot, 'agent-output.json'), 'utf-8'));
    expect(output.agent).toBe('task/docs-updater');
    expect(output.response).toBe(result.response);
  });

  it('lets CLI prompt override configured prompt', async () => {
    const config = {
      ...baseConfig,
      agents: {
        default: { model: 'provider/default-model', skills: [] },
        overrides: {
          'task/docs-updater': {
            run: {
              prompt: 'Configured prompt',
            },
          },
        },
      },
    } as unknown as DRSConfig;

    await runAgent(config, 'task/docs-updater', {
      prompt: 'CLI prompt',
      workingDir: process.cwd(),
    });

    expect(mocks.runtimeClient.createSession).toHaveBeenCalledWith({
      agent: 'task/docs-updater',
      message: 'CLI prompt',
    });
  });

  it('rejects unknown agents before starting runtime', async () => {
    mocks.getAgent.mockReturnValueOnce(null as any);

    await expect(
      runAgent(baseConfig, 'task/missing', {
        prompt: 'Hello',
        workingDir: process.cwd(),
      })
    ).rejects.toThrow('Unknown agent "task/missing"');

    expect(mocks.createRuntimeClientInstance).not.toHaveBeenCalled();
  });

  it('rejects empty prompts', async () => {
    await expect(
      runAgent(baseConfig, 'task/docs-updater', {
        prompt: '   ',
        workingDir: process.cwd(),
      })
    ).rejects.toThrow('Agent prompt cannot be empty');
  });
});
