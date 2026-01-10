import { Octokit } from '@octokit/rest';
import type { RestEndpointMethodTypes } from '@octokit/rest';

export interface GitHubConfig {
  token: string;
  owner?: string;
  repo?: string;
}

export interface PRChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner?: string;
  private repo?: string;

  constructor(config: GitHubConfig) {
    this.octokit = new Octokit({
      auth: config.token,
    });
    this.owner = config.owner;
    this.repo = config.repo;
  }

  /**
   * Get pull request details
   */
  async getPullRequest(owner: string, repo: string, prNumber: number) {
    const response = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return response.data;
  }

  /**
   * Get pull request files (changes)
   */
  async getPRFiles(owner: string, repo: string, prNumber: number): Promise<PRChange[]> {
    const response = await this.octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    return response.data.map(file => ({
      filename: file.filename,
      status: file.status as PRChange['status'],
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch,
      previousFilename: file.previous_filename,
    }));
  }

  /**
   * Post a review comment on the PR
   */
  async createPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<RestEndpointMethodTypes['issues']['createComment']['response']> {
    return await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }

  /**
   * Create a review comment on a specific line
   */
  async createPRReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string,
    path: string,
    line: number
  ): Promise<RestEndpointMethodTypes['pulls']['createReviewComment']['response']> {
    return await this.octokit.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      body,
      commit_id: commitId,
      path,
      line,
    });
  }

  /**
   * Create a pull request review with multiple comments
   */
  async createPRReview(
    owner: string,
    repo: string,
    prNumber: number,
    commitId: string,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    comments?: Array<{
      path: string;
      line: number;
      body: string;
    }>
  ): Promise<RestEndpointMethodTypes['pulls']['createReview']['response']> {
    return await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      body,
      event,
      comments,
    });
  }

  /**
   * Add labels to a PR
   */
  async addLabels(
    owner: string,
    repo: string,
    prNumber: number,
    labels: string[]
  ): Promise<RestEndpointMethodTypes['issues']['addLabels']['response']> {
    return await this.octokit.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels,
    });
  }

  /**
   * Check if PR has a specific label
   */
  async hasLabel(owner: string, repo: string, prNumber: number, label: string): Promise<boolean> {
    const response = await this.octokit.issues.listLabelsOnIssue({
      owner,
      repo,
      issue_number: prNumber,
    });
    return response.data.some(l => l.name === label);
  }

  /**
   * Get repository details
   */
  async getRepository(owner: string, repo: string) {
    const response = await this.octokit.repos.get({
      owner,
      repo,
    });
    return response.data;
  }

  /**
   * Get the authenticated user
   */
  async getAuthenticatedUser() {
    const response = await this.octokit.users.getAuthenticated();
    return response.data;
  }

  /**
   * List all issue comments on a PR
   */
  async listPRComments(owner: string, repo: string, prNumber: number) {
    const response = await this.octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    return response.data;
  }

  /**
   * List all review comments on a PR
   */
  async listPRReviewComments(owner: string, repo: string, prNumber: number) {
    const response = await this.octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return response.data;
  }

  /**
   * Update an existing comment
   */
  async updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<RestEndpointMethodTypes['issues']['updateComment']['response']> {
    return await this.octokit.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  }
}

/**
 * Create a GitHub client from environment variables
 */
export function createGitHubClient(): GitHubClient {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }

  return new GitHubClient({
    token,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  });
}
