import { describe, it, expect, vi } from 'vitest';
import { GitHubPlatformAdapter } from './platform-adapter.js';

describe('GitHubPlatformAdapter', () => {
  it('maps pull request creator identity with a GitHub no-reply fallback', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        title: 'Improve review flow',
        body: null,
        user: { id: 42, login: 'octocat', email: null },
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main' },
      }),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await expect(adapter.getPullRequest('octocat/hello', 7)).resolves.toMatchObject({
      author: 'octocat',
      authorEmail: '42+octocat@users.noreply.github.com',
    });
  });

  it('preserves a public pull request creator email', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({
        number: 7,
        title: 'Improve review flow',
        body: null,
        user: { id: 42, login: 'octocat', email: 'octocat@example.com' },
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main' },
      }),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await expect(adapter.getPullRequest('octocat/hello', 7)).resolves.toMatchObject({
      author: 'octocat',
      authorEmail: 'octocat@example.com',
    });
  });

  it('throws for invalid project IDs', async () => {
    const client = {
      getPullRequest: vi.fn(),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await expect(adapter.getPullRequest('invalid', 1)).rejects.toThrow(
      'Invalid GitHub project ID format'
    );
  });

  it('creates a bulk review with inline comments', async () => {
    const client = {
      createPRReview: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await adapter.createBulkInlineComments('octocat/hello', 7, [
      {
        body: 'Issue 1',
        position: {
          path: 'src/index.ts',
          line: 12,
          commitSha: 'abc123',
        },
      },
      {
        body: 'Issue 2',
        position: {
          path: 'src/app.ts',
          line: 8,
          commitSha: 'abc123',
        },
      },
    ]);

    expect(client.createPRReview).toHaveBeenCalledWith(
      'octocat',
      'hello',
      7,
      'abc123',
      'Found 2 critical/high priority issue(s) that need attention.',
      'COMMENT',
      [
        { path: 'src/index.ts', line: 12, body: 'Issue 1' },
        { path: 'src/app.ts', line: 8, body: 'Issue 2' },
      ]
    );
  });

  it('falls back to deleting review comments for inline comments', async () => {
    const client = {
      deleteComment: vi.fn().mockRejectedValue({ status: 404 }),
      deletePRReviewComment: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await adapter.deleteComment('octocat/hello', 7, 123);

    expect(client.deleteComment).toHaveBeenCalledWith('octocat', 'hello', 123);
    expect(client.deletePRReviewComment).toHaveBeenCalledWith('octocat', 'hello', 123);
  });

  it('retries transient GitHub comment list failures', async () => {
    const client = {
      listPRComments: vi
        .fn()
        .mockRejectedValueOnce({
          status: 503,
          message: 'upstream connect error: remote connection failure',
        })
        .mockResolvedValueOnce([{ id: 123, body: 'Existing comment' }]),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await expect(adapter.getComments('octocat/hello', 7)).resolves.toEqual([
      { id: 123, body: 'Existing comment' },
    ]);
    expect(client.listPRComments).toHaveBeenCalledTimes(2);
    expect(client.listPRComments).toHaveBeenCalledWith('octocat', 'hello', 7);
  });

  it('finds an open pull request by source and target branches', async () => {
    const client = {
      listOpenPullRequests: vi.fn().mockResolvedValue({
        data: [
          {
            number: 42,
            html_url: 'https://github.com/octocat/hello/pull/42',
            head: { ref: 'drs-fix/pr-7' },
            base: { ref: 'feature' },
          },
        ],
      }),
    };

    const adapter = new GitHubPlatformAdapter(client as any);

    await expect(
      adapter.findChangeRequest('octocat/hello', 'drs-fix/pr-7', 'feature')
    ).resolves.toEqual({
      number: 42,
      url: 'https://github.com/octocat/hello/pull/42',
      sourceBranch: 'drs-fix/pr-7',
      targetBranch: 'feature',
    });
    expect(client.listOpenPullRequests).toHaveBeenCalledWith('octocat', 'hello', {
      head: 'octocat:drs-fix/pr-7',
      base: 'feature',
    });
  });
});
