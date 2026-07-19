import { describe, expect, it } from 'vitest';
import { resolveGitLabCommitEmailDomain } from './client.js';

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
