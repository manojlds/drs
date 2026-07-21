import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    readonly pulls = { listFiles: mocks.listFiles };
    readonly paginate = mocks.paginate;
  },
}));

import { GitHubClient } from './client.js';

describe('GitHubClient API pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads every pull request file through Octokit pagination', async () => {
    mocks.paginate.mockResolvedValue([
      {
        filename: 'src/first.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1 +1 @@',
      },
      {
        filename: 'src/last.ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        changes: 2,
        patch: '@@ -0,0 +1,2 @@',
      },
    ]);
    const client = new GitHubClient({ token: 'test-token' });

    const files = await client.getPRFiles('owner', 'repo', 7);

    expect(mocks.paginate).toHaveBeenCalledWith(mocks.listFiles, {
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
      per_page: 100,
    });
    expect(files).toHaveLength(2);
    expect(files[1]).toMatchObject({ filename: 'src/last.ts', status: 'added' });
  });
});
