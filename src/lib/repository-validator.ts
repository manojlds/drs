/**
 * Repository validation utilities for PR/MR reviews
 *
 * This module handles repository and branch validation to ensure
 * that reviews are run from the correct repository and branch.
 */

import simpleGit from 'simple-git';
import type { PullRequest } from './platform-client.js';

export interface RepoInfo {
  host?: string;
  repoPath?: string;
  remoteUrl?: string;
}

export interface BaseBranchResolution {
  baseBranch?: string;
  resolvedBaseBranch?: string;
  source?: string;
}

/**
 * Normalize a repository path by removing leading slashes and .git suffix
 */
export function normalizeRepoPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/**
 * Parse a git remote URL to extract host and repository path
 */
export function parseRemoteUrl(remoteUrl: string): RepoInfo | null {
  if (!remoteUrl) return null;

  const trimmed = remoteUrl.trim();

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return { host: sshMatch[1], repoPath: sshMatch[2], remoteUrl: trimmed };
  }

  // HTTP/HTTPS format
  if (
    trimmed.startsWith('ssh://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  ) {
    try {
      const url = new URL(trimmed);
      return {
        host: url.hostname,
        repoPath: url.pathname.replace(/^\/+/, ''),
        remoteUrl: trimmed,
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Extract expected repository info from PR/MR platform data
 */
export function getExpectedRepoInfo(
  pr: { platformData?: unknown },
  projectId: string
): RepoInfo | null {
  const data = pr?.platformData as
    | {
        base?: {
          repo?: {
            full_name?: string;
            html_url?: string;
            clone_url?: string;
            ssh_url?: string;
          };
        };
        project?: { path_with_namespace?: string; web_url?: string };
        web_url?: string;
      }
    | undefined;

  // GitHub format
  if (data?.base?.repo?.full_name) {
    const hostUrl = data.base.repo.html_url ?? data.base.repo.clone_url ?? data.base.repo.ssh_url;
    const hostInfo = hostUrl ? parseRemoteUrl(hostUrl) : null;
    return {
      host: hostInfo?.host ?? 'github.com',
      repoPath: data.base.repo.full_name,
    };
  }

  // GitLab numeric project ID with slash format
  if (typeof projectId === 'string' && projectId.includes('/')) {
    return { repoPath: projectId };
  }

  // GitLab web_url format
  if (typeof data?.web_url === 'string') {
    const info = parseRemoteUrl(data.web_url);
    if (info?.repoPath) {
      const pathWithoutSuffix = info.repoPath.replace(/\/-\/.*$/, '');
      return { host: info.host, repoPath: pathWithoutSuffix };
    }
  }

  return null;
}

/**
 * Normalize a base branch name by adding origin/ prefix if needed
 */
export function normalizeBaseBranch(baseBranch?: string): string | undefined {
  if (!baseBranch) return undefined;
  return baseBranch.startsWith('origin/') ? baseBranch : `origin/${baseBranch}`;
}

/**
 * Resolve the base branch from CLI, environment variables, or PR/MR data
 */
export function resolveBaseBranch(
  cliBaseBranch?: string,
  targetBranch?: string
): BaseBranchResolution {
  // CLI argument takes highest priority
  if (cliBaseBranch) {
    const resolved = normalizeBaseBranch(cliBaseBranch);
    return {
      baseBranch: cliBaseBranch,
      resolvedBaseBranch: resolved,
      source: 'cli',
    };
  }

  // DRS-specific environment variable
  if (process.env.DRS_BASE_BRANCH) {
    const resolved = normalizeBaseBranch(process.env.DRS_BASE_BRANCH);
    return {
      baseBranch: process.env.DRS_BASE_BRANCH,
      resolvedBaseBranch: resolved,
      source: 'env:DRS_BASE_BRANCH',
    };
  }

  // GitHub Actions environment variable
  if (process.env.GITHUB_BASE_REF) {
    const resolved = normalizeBaseBranch(process.env.GITHUB_BASE_REF);
    return {
      baseBranch: process.env.GITHUB_BASE_REF,
      resolvedBaseBranch: resolved,
      source: 'env:GITHUB_BASE_REF',
    };
  }

  // GitLab CI environment variable
  if (process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) {
    const resolved = normalizeBaseBranch(process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME);
    return {
      baseBranch: process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
      resolvedBaseBranch: resolved,
      source: 'env:CI_MERGE_REQUEST_TARGET_BRANCH_NAME',
    };
  }

  // Fall back to PR/MR target branch
  if (targetBranch) {
    const resolved = normalizeBaseBranch(targetBranch);
    return {
      baseBranch: targetBranch,
      resolvedBaseBranch: resolved,
      source: 'pr:targetBranch',
    };
  }

  return {};
}

/**
 * Generate a canonical git diff command for documentation purposes
 */
export function getCanonicalDiffCommand(
  pr: PullRequest,
  baseBranchResolution: BaseBranchResolution
): string {
  // GitHub Actions environment
  const githubBase = process.env.GITHUB_BASE_REF;
  const githubHead = process.env.GITHUB_HEAD_REF;
  if (githubBase && githubHead) {
    return `git diff origin/${githubBase} origin/${githubHead} -- <file>`;
  }

  // GitLab CI environment
  const gitlabBase = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  const gitlabHead = process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  if (gitlabBase && gitlabHead) {
    return `git diff origin/${gitlabBase} origin/${gitlabHead} -- <file>`;
  }

  // PR/MR data
  if (pr.targetBranch && pr.sourceBranch) {
    return `git diff origin/${pr.targetBranch} origin/${pr.sourceBranch} -- <file>`;
  }

  // Resolved base branch
  if (baseBranchResolution.resolvedBaseBranch) {
    return `git diff ${baseBranchResolution.resolvedBaseBranch}...HEAD -- <file>`;
  }

  return 'git diff -- <file>';
}

/**
 * Enforce that the current working directory matches the PR/MR repository and branch
 *
 * This prevents accidentally reviewing the wrong repository or branch.
 *
 * @param skipRepoCheck - If true, skip repository validation (default: false)
 * @param skipBranchCheck - If true, skip branch validation (default: false)
 * @throws Error if repository or branch doesn't match
 */
export async function enforceRepoBranchMatch(
  workingDir: string,
  projectId: string,
  pr: PullRequest,
  options?: { skipRepoCheck?: boolean; skipBranchCheck?: boolean }
): Promise<void> {
  const git = simpleGit({ baseDir: workingDir });

  // Check if this is a git repository
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not a git repository. Run review from the PR/MR repository checkout.');
  }

  // Get current branch and commit
  const branchSummary = await git.branch();
  const currentBranch = branchSummary.current;
  const headSha = (await git.revparse(['HEAD'])).trim();

  // Get remote URL
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  const remoteUrl = origin?.refs?.fetch ?? origin?.refs?.push;
  if (!remoteUrl) {
    throw new Error('No git remotes found. Cannot validate repository match for PR/MR.');
  }

  // Parse local repository info
  const localRepo = parseRemoteUrl(remoteUrl);
  if (!localRepo?.repoPath) {
    throw new Error(`Unable to parse git remote URL: ${remoteUrl}`);
  }

  // Get expected repository info from PR/MR
  const expectedRepo = getExpectedRepoInfo(pr, projectId);
  if (!expectedRepo?.repoPath) {
    throw new Error('Unable to determine expected repository from PR/MR data.');
  }

  // Validate repository match (unless skipRepoCheck is enabled)
  if (!options?.skipRepoCheck) {
    const localRepoPath = normalizeRepoPath(localRepo.repoPath);
    const expectedRepoPath = normalizeRepoPath(expectedRepo.repoPath);
    const hostMismatch =
      expectedRepo.host &&
      localRepo.host &&
      expectedRepo.host.toLowerCase() !== localRepo.host.toLowerCase();
    const repoMismatch = localRepoPath !== expectedRepoPath;

    if (hostMismatch || repoMismatch) {
      throw new Error(
        `Repository mismatch for PR/MR review.\n` +
          `Local repo: ${localRepo.host ? `${localRepo.host}/` : ''}${localRepoPath}\n` +
          `Expected: ${expectedRepo.host ? `${expectedRepo.host}/` : ''}${expectedRepoPath}\n` +
          `Run the review from the PR/MR repository checkout.`
      );
    }
  }

  // Validate branch match (unless skipBranchCheck is enabled)
  if (!options?.skipBranchCheck) {
    const expectedBranch = pr.sourceBranch;
    const branchMatches = currentBranch === expectedBranch;
    const shaMatches = pr.headSha ? headSha === pr.headSha : false;

    if (!branchMatches && !shaMatches) {
      throw new Error(
        `Branch mismatch for PR/MR review.\n` +
          `Local branch: ${currentBranch ?? '(unknown)'}\n` +
          `Expected branch: ${expectedBranch}\n` +
          `Check out the PR/MR source branch before running the review.`
      );
    }
  }
}
