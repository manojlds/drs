import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDescribeIfEnabled } from './description-executor.js';
import type { DRSConfig } from './config.js';
import type { PlatformClient, PullRequest } from './platform-client.js';
import type { FileWithDiff } from './review-core.js';
import type { RuntimeClient } from '../opencode/client.js';

vi.mock('./describe-core.js', () => ({
  buildDescribeInstructions: vi.fn(() => 'describe instructions'),
}));

vi.mock('./context-compression.js', () => ({
  compressFilesWithDiffs: vi.fn((files: FileWithDiff[]) => ({ files })),
  formatCompressionSummary: vi.fn(() => undefined),
}));

vi.mock('./describe-parser.js', () => ({
  parseDescribeOutput: vi.fn().mockResolvedValue({
    type: 'refactor',
    title: 'Pi migration',
    summary: ['Switches runtime to Pi in-process mode'],
  }),
}));

vi.mock('./description-formatter.js', () => ({
  displayDescription: vi.fn(),
  normalizeDescription: vi.fn((description: unknown) => description),
  postDescription: vi.fn().mockResolvedValue(undefined),
}));

describe('description-executor', () => {
  let runtimeClient: RuntimeClient;
  let platformClient: PlatformClient;
  let config: DRSConfig;
  let pr: PullRequest;
  let files: FileWithDiff[];
  let consoleLogSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runtimeClient = {
      createSession: vi.fn().mockResolvedValue({ id: 'session-1' }),
      streamMessages: vi.fn(async function* () {
        yield {
          id: 'message-1',
          role: 'assistant',
          content: '{"outputType":"describe_output","outputPath":".drs/describe-output.json"}',
          timestamp: new Date(),
        };
      }),
    } as unknown as RuntimeClient;

    platformClient = {} as unknown as PlatformClient;

    config = {
      review: {
        agents: ['security'],
        ignorePatterns: [],
        mode: 'multi-agent',
      },
      contextCompression: {
        enabled: true,
      },
    } as unknown as DRSConfig;

    pr = {
      number: 84,
      title: 'Pi migration',
      author: 'manojlds',
      sourceBranch: 'ralph/pi-migration',
      targetBranch: 'pi-migration-base',
      headSha: 'abc123',
      platformData: {},
    };

    files = [
      {
        filename: 'src/lib/review-core.ts',
        patch: '+ new line',
      },
    ];
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('suppresses terminal description output when posting is enabled', async () => {
    const { displayDescription, postDescription } = await import('./description-formatter.js');

    await runDescribeIfEnabled(
      runtimeClient,
      config,
      platformClient,
      'manojlds/drs',
      pr,
      files,
      true,
      process.cwd(),
      false
    );

    expect(displayDescription).not.toHaveBeenCalled();
    expect(postDescription).toHaveBeenCalledWith(
      platformClient,
      'manojlds/drs',
      84,
      expect.objectContaining({ title: 'Pi migration' }),
      'PR'
    );
  });

  it('prints description to terminal when posting is disabled', async () => {
    const { displayDescription, postDescription } = await import('./description-formatter.js');

    await runDescribeIfEnabled(
      runtimeClient,
      config,
      platformClient,
      'manojlds/drs',
      pr,
      files,
      false,
      process.cwd(),
      false
    );

    expect(displayDescription).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Pi migration' }),
      'PR'
    );
    expect(postDescription).not.toHaveBeenCalled();
  });
});
