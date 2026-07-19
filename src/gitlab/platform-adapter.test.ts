import { describe, it, expect, vi } from 'vitest';
import { GitLabPlatformAdapter } from './platform-adapter.js';

describe('GitLabPlatformAdapter', () => {
  it('maps merge request creator identity with a GitLab no-reply fallback', async () => {
    const client = {
      getCommitEmailDomain: vi.fn().mockReturnValue('users.noreply.gitlab.com'),
      getMergeRequest: vi.fn().mockResolvedValue({
        iid: 8,
        title: 'Improve review flow',
        author: { id: 42, name: 'Ada Lovelace', username: 'ada', public_email: '' },
        source_branch: 'feature',
        target_branch: 'main',
        sha: 'abc123',
      }),
    };

    const adapter = new GitLabPlatformAdapter(client as any);

    await expect(adapter.getPullRequest('group/repo', 8)).resolves.toMatchObject({
      author: 'Ada Lovelace',
      authorEmail: '42-ada@users.noreply.gitlab.com',
    });
  });

  it('preserves a public merge request creator email', async () => {
    const client = {
      getCommitEmailDomain: vi.fn().mockReturnValue('users.noreply.gitlab.com'),
      getMergeRequest: vi.fn().mockResolvedValue({
        iid: 8,
        title: 'Improve review flow',
        author: {
          id: 42,
          name: 'Ada Lovelace',
          username: 'ada',
          public_email: 'ada@example.com',
        },
        source_branch: 'feature',
        target_branch: 'main',
        sha: 'abc123',
      }),
    };

    const adapter = new GitLabPlatformAdapter(client as any);

    await expect(adapter.getPullRequest('group/repo', 8)).resolves.toMatchObject({
      author: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
    });
  });

  it('uses the configured self-managed GitLab no-reply domain', async () => {
    const client = {
      getCommitEmailDomain: vi.fn().mockReturnValue('users.noreply.gitlab.example.com'),
      getMergeRequest: vi.fn().mockResolvedValue({
        iid: 8,
        title: 'Improve review flow',
        author: { id: 42, name: 'Ada Lovelace', username: 'ada', public_email: '' },
        source_branch: 'feature',
        target_branch: 'main',
        sha: 'abc123',
      }),
    };

    const adapter = new GitLabPlatformAdapter(client as any);

    await expect(adapter.getPullRequest('group/repo', 8)).resolves.toMatchObject({
      authorEmail: '42-ada@users.noreply.gitlab.example.com',
    });
  });

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
