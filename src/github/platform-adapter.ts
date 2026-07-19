/**
 * GitHub platform adapter implementing the common PlatformClient interface
 */

import chalk from 'chalk';
import type { GitHubClient } from './client.js';
import type {
  PlatformClient,
  PullRequest,
  FileChange,
  Comment,
  InlineCommentPosition,
  ChangeRequest,
  ChangeRequestInput,
} from '../lib/platform-client.js';
import { GitHubPositionValidator, validatePositionOrThrow } from '../lib/position-validator.js';

function nonEmptyIdentityValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

/**
 * Adapter that wraps GitHubClient to implement PlatformClient interface
 */
export class GitHubPlatformAdapter implements PlatformClient {
  private readonly positionValidator = new GitHubPositionValidator();

  constructor(private client: GitHubClient) {}

  async getPullRequest(projectId: string, prNumber: number): Promise<PullRequest> {
    const [owner, repo] = this.parseProjectId(projectId);
    const pr = await this.client.getPullRequest(owner, repo, prNumber);
    const creator = pr.user as
      | { id?: number; login?: string; email?: string | null }
      | null
      | undefined;
    const login = nonEmptyIdentityValue(creator?.login);
    const author = login ?? 'Unknown';
    const publicEmail = nonEmptyIdentityValue(creator?.email);
    const authorEmail =
      publicEmail ??
      (creator?.id && login ? `${creator.id}+${login}@users.noreply.github.com` : undefined);

    return {
      number: pr.number,
      title: pr.title,
      description: pr.body ?? undefined,
      author,
      authorEmail,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      headSha: pr.head.sha,
      platformData: pr,
    };
  }

  async getChangedFiles(projectId: string, prNumber: number): Promise<FileChange[]> {
    const [owner, repo] = this.parseProjectId(projectId);
    const files = await this.client.getPRFiles(owner, repo, prNumber);

    return files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
      previousFilename: file.previousFilename,
    }));
  }

  async getComments(projectId: string, prNumber: number): Promise<Comment[]> {
    const [owner, repo] = this.parseProjectId(projectId);
    const comments = await this.withTransientRetry('list PR comments', () =>
      this.client.listPRComments(owner, repo, prNumber)
    );

    return comments.map((c) => ({
      id: c.id,
      body: c.body ?? '',
    }));
  }

  async getInlineComments(projectId: string, prNumber: number): Promise<Comment[]> {
    const [owner, repo] = this.parseProjectId(projectId);
    const comments = await this.withTransientRetry('list PR review comments', () =>
      this.client.listPRReviewComments(owner, repo, prNumber)
    );

    return comments.map((c) => ({
      id: c.id,
      body: c.body || '',
    }));
  }

  async createComment(projectId: string, prNumber: number, body: string): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    await this.withTransientRetry('create PR comment', () =>
      this.client.createPRComment(owner, repo, prNumber, body)
    );
  }

  async updateComment(
    projectId: string,
    prNumber: number,
    commentId: number | string,
    body: string
  ): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    await this.withTransientRetry('update PR comment', () =>
      this.client.updateComment(owner, repo, Number(commentId), body)
    );
  }

  async deleteComment(
    projectId: string,
    prNumber: number,
    commentId: number | string
  ): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    try {
      await this.withTransientRetry('delete PR comment', () =>
        this.client.deleteComment(owner, repo, Number(commentId))
      );
    } catch (error) {
      if (!this.isNotFoundError(error)) {
        throw error;
      }
      await this.withTransientRetry('delete PR review comment', () =>
        this.client.deletePRReviewComment(owner, repo, Number(commentId))
      );
    }
  }

  async createInlineComment(
    projectId: string,
    prNumber: number,
    body: string,
    position: InlineCommentPosition
  ): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);

    // Validate position requirements for GitHub
    validatePositionOrThrow(position, this.positionValidator);

    await this.withTransientRetry('create PR review comment', () =>
      this.client.createPRReviewComment(
        owner,
        repo,
        prNumber,
        body,
        position.commitSha!,
        position.path,
        position.line
      )
    );
  }

  async createBulkInlineComments(
    projectId: string,
    prNumber: number,
    comments: Array<{ body: string; position: InlineCommentPosition }>
  ): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);

    if (comments.length === 0) return;

    // Validate the first comment's position (all should have the same commitSha)
    const firstPosition = comments[0]?.position;
    if (firstPosition) {
      validatePositionOrThrow(firstPosition, this.positionValidator);
    }

    const commitSha = firstPosition.commitSha!;

    const reviewComments = comments.map((c) => ({
      path: c.position.path,
      line: c.position.line,
      body: c.body,
    }));

    try {
      await this.withTransientRetry('create PR review', () =>
        this.client.createPRReview(
          owner,
          repo,
          prNumber,
          commitSha,
          `Found ${comments.length} critical/high priority issue(s) that need attention.`,
          'COMMENT',
          reviewComments
        )
      );
      console.log(chalk.green(`✓ Posted ${comments.length} inline comment(s) in a single review`));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(chalk.yellow(`⚠ Could not post bulk review: ${errorMessage}`));
      console.log(chalk.gray('Falling back to individual comment posting...\n'));

      // Fallback to individual comments in parallel
      const results = await Promise.allSettled(
        comments.map(async (comment) => {
          try {
            await this.createInlineComment(projectId, prNumber, comment.body, comment.position);
            console.log(
              chalk.gray(
                `  ✓ Posted inline comment for ${comment.position.path}:${comment.position.line}`
              )
            );
          } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            console.warn(
              chalk.yellow(
                `  ⚠ Could not post inline comment for ${comment.position.path}:${comment.position.line} - ${errMessage}`
              )
            );
            throw err; // Re-throw to mark as rejected
          }
        })
      );

      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      console.log(chalk.gray(`Fallback: Posted ${successCount}/${comments.length} comment(s)`));
    }
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    await this.withTransientRetry('add PR labels', () =>
      this.client.addLabels(owner, repo, prNumber, labels)
    );
  }

  async hasLabel(projectId: string, prNumber: number, label: string): Promise<boolean> {
    const [owner, repo] = this.parseProjectId(projectId);
    return await this.client.hasLabel(owner, repo, prNumber, label);
  }

  async createChangeRequest(projectId: string, input: ChangeRequestInput): Promise<ChangeRequest> {
    const [owner, repo] = this.parseProjectId(projectId);
    const response = await this.client.createPullRequest(owner, repo, {
      head: input.sourceBranch,
      base: input.targetBranch,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });

    return {
      number: response.data.number,
      url: response.data.html_url,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
    };
  }

  async findChangeRequest(
    projectId: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ChangeRequest | undefined> {
    const [owner, repo] = this.parseProjectId(projectId);
    const response = await this.client.listOpenPullRequests(owner, repo, {
      head: `${owner}:${sourceBranch}`,
      base: targetBranch,
    });
    const pr = response.data[0];
    if (!pr) {
      return undefined;
    }

    return {
      number: pr.number,
      url: pr.html_url,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
    };
  }

  /**
   * Parse projectId in format "owner/repo"
   */
  private parseProjectId(projectId: string): [string, string] {
    const parts = projectId.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid GitHub project ID format: ${projectId}. Expected "owner/repo"`);
    }
    return [parts[0], parts[1]];
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 404
    );
  }

  private async withTransientRetry<T>(operation: string, task: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts || !this.isTransientError(error)) {
          throw error;
        }
        const delayMs = process.env.NODE_ENV === 'test' ? 0 : 500 * 2 ** (attempt - 1);
        console.warn(
          chalk.yellow(
            `⚠ GitHub ${operation} failed transiently; retrying (${attempt}/${maxAttempts})`
          )
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  private isTransientError(error: unknown): boolean {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|upstream connect error|remote connection failure/i.test(
      message
    );
  }
}
