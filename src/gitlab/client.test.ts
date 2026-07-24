import { describe, expect, it, vi } from 'vitest';
import { GitLabClient, resolveGitLabCommitEmailDomain } from './client.js';

describe('resolveGitLabCommitEmailDomain', () => {
  it('derives the GitLab.com private commit email domain', () => {
    expect(resolveGitLabCommitEmailDomain('https://gitlab.com')).toBe('users.noreply.gitlab.com');
  });

  it('derives a self-managed private commit email domain', () => {
    expect(resolveGitLabCommitEmailDomain('https://gitlab.example.com')).toBe(
      'users.noreply.gitlab.example.com'
    );
  });

  it('uses a configured private commit email domain', () => {
    expect(
      resolveGitLabCommitEmailDomain('https://gitlab.example.com', ' commits.example.com ')
    ).toBe('commits.example.com');
  });
});

describe('GitLabClient changes snapshots', () => {
  it('retains API overflow and per-file completeness signals', async () => {
    const changes = vi.fn().mockResolvedValue({
      overflow: true,
      changes: [
        {
          old_path: 'src/old.ts',
          new_path: 'src/new.ts',
          new_file: false,
          renamed_file: true,
          deleted_file: false,
          diff: '@@ +1 @@\n+new',
          collapsed: true,
          too_large: true,
        },
      ],
    });
    const client = new GitLabClient({ url: 'https://gitlab.example.com', token: 'token' });
    const api = { MergeRequests: { changes } };
    (client as unknown as { client: typeof api }).client = api;

    await expect(client.getMRChangesSnapshot('group/repo', 8)).resolves.toEqual({
      overflow: true,
      changes: [
        {
          oldPath: 'src/old.ts',
          newPath: 'src/new.ts',
          newFile: false,
          renamedFile: true,
          deletedFile: false,
          diff: '@@ +1 @@\n+new',
          collapsed: true,
          tooLarge: true,
        },
      ],
    });
  });
});
