import { describe, it, expect, vi } from 'vitest';
import { GitHubPlatformAdapter } from './platform-adapter.js';

describe('GitHubPlatformAdapter', () => {
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
});
