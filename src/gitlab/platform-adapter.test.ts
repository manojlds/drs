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

  it('finds an open merge request by source and target branches', async () => {
    const client = {
      listOpenMergeRequests: vi.fn().mockResolvedValue([
        {
          iid: 77,
          web_url: 'https://gitlab.com/group/repo/-/merge_requests/77',
          source_branch: 'drs-fix/mr-8',
          target_branch: 'feature',
        },
      ]),
    };

    const adapter = new GitLabPlatformAdapter(client as any);

    await expect(
      adapter.findChangeRequest('group/repo', 'drs-fix/mr-8', 'feature')
    ).resolves.toEqual({
      number: 77,
      url: 'https://gitlab.com/group/repo/-/merge_requests/77',
      sourceBranch: 'drs-fix/mr-8',
      targetBranch: 'feature',
    });
    expect(client.listOpenMergeRequests).toHaveBeenCalledWith('group/repo', {
      sourceBranch: 'drs-fix/mr-8',
      targetBranch: 'feature',
    });
  });
});
