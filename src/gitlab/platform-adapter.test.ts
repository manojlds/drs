import { describe, it, expect, vi } from 'vitest';
import { GitLabPlatformAdapter } from './platform-adapter.js';

describe('GitLabPlatformAdapter', () => {
  it('falls back to general comment when inline comment fails', async () => {
    const client = {
      createMRDiscussionThread: vi.fn().mockRejectedValue(new Error('boom')),
      createMRComment: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new GitLabPlatformAdapter(client as any);

    await adapter.createInlineComment('project', 42, 'body', {
      path: 'src/index.ts',
      line: 10,
      baseSha: 'base',
      headSha: 'head',
      startSha: 'start',
    });

    expect(client.createMRDiscussionThread).toHaveBeenCalledTimes(1);
    expect(client.createMRComment).toHaveBeenCalledWith('project', 42, 'body');
  });
});
