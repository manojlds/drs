/**
 * Tests for repository-validator.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalizeRepoPath,
  parseRemoteUrl,
  getExpectedRepoInfo,
  normalizeBaseBranch,
  resolveBaseBranch,
  getCanonicalDiffCommand,
  enforceRepoBranchMatch,
  type BaseBranchResolution,
} from './repository-validator.js';
import type { PullRequest } from './platform-client.js';

describe('repository-validator', () => {
  describe('normalizeRepoPath', () => {
    it('should remove leading slashes', () => {
      expect(normalizeRepoPath('/owner/repo')).toBe('owner/repo');
      expect(normalizeRepoPath('///owner/repo')).toBe('owner/repo');
    });

    it('should remove .git suffix', () => {
      expect(normalizeRepoPath('owner/repo.git')).toBe('owner/repo');
      expect(normalizeRepoPath('owner/repo.GIT')).toBe('owner/repo');
    });

    it('should convert to lowercase', () => {
      expect(normalizeRepoPath('Owner/Repo')).toBe('owner/repo');
      expect(normalizeRepoPath('OWNER/REPO')).toBe('owner/repo');
    });

    it('should handle combined transformations', () => {
      expect(normalizeRepoPath('/Owner/Repo.git')).toBe('owner/repo');
    });
  });

  describe('parseRemoteUrl', () => {
    it('should parse SSH format', () => {
      const result = parseRemoteUrl('git@github.com:owner/repo.git');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo.git',
        remoteUrl: 'git@github.com:owner/repo.git',
      });
    });

    it('should parse HTTPS format', () => {
      const result = parseRemoteUrl('https://github.com/owner/repo.git');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo.git',
        remoteUrl: 'https://github.com/owner/repo.git',
      });
    });

    it('should parse HTTP format', () => {
      const result = parseRemoteUrl('http://gitlab.com/owner/repo.git');
      expect(result).toEqual({
        host: 'gitlab.com',
        repoPath: 'owner/repo.git',
        remoteUrl: 'http://gitlab.com/owner/repo.git',
      });
    });

    it('should parse ssh:// format', () => {
      const result = parseRemoteUrl('ssh://git@github.com/owner/repo.git');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo.git',
        remoteUrl: 'ssh://git@github.com/owner/repo.git',
      });
    });

    it('should return null for empty string', () => {
      expect(parseRemoteUrl('')).toBeNull();
    });

    it('should return null for invalid URL', () => {
      expect(parseRemoteUrl('not-a-url')).toBeNull();
    });

    it('should handle URLs with trailing slashes', () => {
      const result = parseRemoteUrl('https://github.com/owner/repo.git/');
      expect(result?.repoPath).toBe('owner/repo.git/');
    });
  });

  describe('getExpectedRepoInfo', () => {
    it('should extract GitHub repository info from full_name', () => {
      const pr = {
        platformData: {
          base: {
            repo: {
              full_name: 'owner/repo',
              html_url: 'https://github.com/owner/repo',
            },
          },
        },
      };

      const result = getExpectedRepoInfo(pr, 'ignored');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo',
      });
    });

    it('should use clone_url if html_url is missing', () => {
      const pr = {
        platformData: {
          base: {
            repo: {
              full_name: 'owner/repo',
              clone_url: 'https://github.com/owner/repo.git',
            },
          },
        },
      };

      const result = getExpectedRepoInfo(pr, 'ignored');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo',
      });
    });

    it('should use ssh_url if html_url and clone_url are missing', () => {
      const pr = {
        platformData: {
          base: {
            repo: {
              full_name: 'owner/repo',
              ssh_url: 'git@github.com:owner/repo.git',
            },
          },
        },
      };

      const result = getExpectedRepoInfo(pr, 'ignored');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo',
      });
    });

    it('should use default github.com if no URL is provided', () => {
      const pr = {
        platformData: {
          base: {
            repo: {
              full_name: 'owner/repo',
            },
          },
        },
      };

      const result = getExpectedRepoInfo(pr, 'ignored');
      expect(result).toEqual({
        host: 'github.com',
        repoPath: 'owner/repo',
      });
    });

    it('should handle GitLab project ID with slash format', () => {
      const pr = {};
      const result = getExpectedRepoInfo(pr, 'owner/repo');
      expect(result).toEqual({
        repoPath: 'owner/repo',
      });
    });

    it('should parse GitLab web_url', () => {
      const pr = {
        platformData: {
          web_url: 'https://gitlab.com/owner/repo/-/merge_requests/123',
        },
      };

      const result = getExpectedRepoInfo(pr, '12345');
      expect(result).toEqual({
        host: 'gitlab.com',
        repoPath: 'owner/repo',
      });
    });

    it('should return null for empty platform data', () => {
      const pr = {};
      const result = getExpectedRepoInfo(pr, '12345');
      expect(result).toBeNull();
    });
  });

  describe('normalizeBaseBranch', () => {
    it('should add origin/ prefix if not present', () => {
      expect(normalizeBaseBranch('main')).toBe('origin/main');
      expect(normalizeBaseBranch('develop')).toBe('origin/develop');
    });

    it('should not duplicate origin/ prefix', () => {
      expect(normalizeBaseBranch('origin/main')).toBe('origin/main');
      expect(normalizeBaseBranch('origin/develop')).toBe('origin/develop');
    });

    it('should return undefined for undefined input', () => {
      expect(normalizeBaseBranch(undefined)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(normalizeBaseBranch('')).toBeUndefined();
    });
  });

  describe('resolveBaseBranch', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should prioritize CLI argument', () => {
      process.env.DRS_BASE_BRANCH = 'env-branch';
      const result = resolveBaseBranch('cli-branch', 'pr-branch');

      expect(result).toEqual({
        baseBranch: 'cli-branch',
        resolvedBaseBranch: 'origin/cli-branch',
        source: 'cli',
      });
    });

    it('should use DRS_BASE_BRANCH env var if CLI not provided', () => {
      process.env.DRS_BASE_BRANCH = 'env-branch';
      const result = resolveBaseBranch(undefined, 'pr-branch');

      expect(result).toEqual({
        baseBranch: 'env-branch',
        resolvedBaseBranch: 'origin/env-branch',
        source: 'env:DRS_BASE_BRANCH',
      });
    });

    it('should use GITHUB_BASE_REF env var', () => {
      process.env.GITHUB_BASE_REF = 'github-branch';
      const result = resolveBaseBranch(undefined, 'pr-branch');

      expect(result).toEqual({
        baseBranch: 'github-branch',
        resolvedBaseBranch: 'origin/github-branch',
        source: 'env:GITHUB_BASE_REF',
      });
    });

    it('should use CI_MERGE_REQUEST_TARGET_BRANCH_NAME env var', () => {
      process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME = 'gitlab-branch';
      const result = resolveBaseBranch(undefined, 'pr-branch');

      expect(result).toEqual({
        baseBranch: 'gitlab-branch',
        resolvedBaseBranch: 'origin/gitlab-branch',
        source: 'env:CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
      });
    });

    it('should fall back to PR target branch', () => {
      const result = resolveBaseBranch(undefined, 'pr-branch');

      expect(result).toEqual({
        baseBranch: 'pr-branch',
        resolvedBaseBranch: 'origin/pr-branch',
        source: 'pr:targetBranch',
      });
    });

    it('should return empty object if no sources available', () => {
      const result = resolveBaseBranch(undefined, undefined);
      expect(result).toEqual({});
    });

    it('should respect environment variable precedence', () => {
      process.env.DRS_BASE_BRANCH = 'drs-branch';
      process.env.GITHUB_BASE_REF = 'github-branch';
      process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME = 'gitlab-branch';

      const result = resolveBaseBranch(undefined, 'pr-branch');

      expect(result.source).toBe('env:DRS_BASE_BRANCH');
    });
  });

  describe('getCanonicalDiffCommand', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should use GitHub Actions environment variables', () => {
      process.env.GITHUB_BASE_REF = 'main';
      process.env.GITHUB_HEAD_REF = 'feature';

      const pr: PullRequest = {
        number: 123,
        title: 'Test PR',
        author: 'test-user',
        sourceBranch: 'feature',
        targetBranch: 'main',
        headSha: 'abc123',
      };

      const result = getCanonicalDiffCommand(pr, {});
      expect(result).toBe('git diff origin/main origin/feature -- <file>');
    });

    it('should use GitLab CI environment variables', () => {
      process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME = 'main';
      process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = 'feature';

      const pr: PullRequest = {
        number: 123,
        title: 'Test MR',
        author: 'test-user',
        sourceBranch: 'feature',
        targetBranch: 'main',
        headSha: 'abc123',
      };

      const result = getCanonicalDiffCommand(pr, {});
      expect(result).toBe('git diff origin/main origin/feature -- <file>');
    });

    it('should use PR/MR branch data if no env vars', () => {
      const pr: PullRequest = {
        number: 123,
        title: 'Test PR',
        author: 'test-user',
        sourceBranch: 'feature',
        targetBranch: 'main',
        headSha: 'abc123',
      };

      const result = getCanonicalDiffCommand(pr, {});
      expect(result).toBe('git diff origin/main origin/feature -- <file>');
    });

    it('should use resolved base branch', () => {
      const pr: PullRequest = {
        number: 123,
        title: 'Test PR',
        author: 'test-user',
        sourceBranch: '',
        targetBranch: '',
        headSha: 'abc123',
      };

      const baseBranchResolution: BaseBranchResolution = {
        baseBranch: 'develop',
        resolvedBaseBranch: 'origin/develop',
        source: 'cli',
      };

      const result = getCanonicalDiffCommand(pr, baseBranchResolution);
      expect(result).toBe('git diff origin/develop...HEAD -- <file>');
    });

    it('should return generic diff command as fallback', () => {
      const pr: PullRequest = {
        number: 123,
        title: 'Test PR',
        author: 'test-user',
        sourceBranch: '',
        targetBranch: '',
        headSha: 'abc123',
      };

      const result = getCanonicalDiffCommand(pr, {});
      expect(result).toBe('git diff -- <file>');
    });
  });

  describe('enforceRepoBranchMatch', () => {
    it('should be defined and exported', () => {
      expect(enforceRepoBranchMatch).toBeDefined();
      expect(typeof enforceRepoBranchMatch).toBe('function');
    });

    // Note: Full integration tests for enforceRepoBranchMatch require complex
    // mocking of simple-git operations and are better tested as integration tests
    // with actual git repositories or comprehensive mocks in CLI tests.
  });
});
