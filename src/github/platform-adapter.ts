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
} from '../lib/platform-client.js';
import { GitHubPositionValidator, validatePositionOrThrow } from '../lib/position-validator.js';

/**
 * Adapter that wraps GitHubClient to implement PlatformClient interface
 */
export class GitHubPlatformAdapter implements PlatformClient {
  private readonly positionValidator = new GitHubPositionValidator();

  constructor(private client: GitHubClient) {}

  async getPullRequest(projectId: string, prNumber: number): Promise<PullRequest> {
    const [owner, repo] = this.parseProjectId(projectId);
    const pr = await this.client.getPullRequest(owner, repo, prNumber);

    return {
      number: pr.number,
      title: pr.title,
      description: pr.body || undefined,
      author: pr.user?.login || 'Unknown',
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
    const comments = await this.client.listPRComments(owner, repo, prNumber);

    return comments.map((c) => ({
      id: c.id,
      body: c.body || '',
    }));
  }

  async getInlineComments(projectId: string, prNumber: number): Promise<Comment[]> {
    const [owner, repo] = this.parseProjectId(projectId);
    const comments = await this.client.listPRReviewComments(owner, repo, prNumber);

    return comments.map((c) => ({
      id: c.id,
      body: c.body || '',
    }));
  }

  async createComment(projectId: string, prNumber: number, body: string): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    await this.client.createPRComment(owner, repo, prNumber, body);
  }

  async updateComment(
    projectId: string,
    prNumber: number,
    commentId: number | string,
    body: string
  ): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    await this.client.updateComment(owner, repo, Number(commentId), body);
  }

  async deleteComment(
    projectId: string,
    prNumber: number,
    commentId: number | string
  ): Promise<void> {
    const [owner, repo] = this.parseProjectId(projectId);
    await this.client.deleteComment(owner, repo, Number(commentId));
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

    await this.client.createPRReviewComment(
      owner,
      repo,
      prNumber,
      body,
      position.commitSha!,
      position.path,
      position.line
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
      await this.client.createPRReview(
        owner,
        repo,
        prNumber,
        commitSha,
        `Found ${comments.length} critical/high priority issue(s) that need attention.`,
        'COMMENT',
        reviewComments
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
    await this.client.addLabels(owner, repo, prNumber, labels);
  }

  async hasLabel(projectId: string, prNumber: number, label: string): Promise<boolean> {
    const [owner, repo] = this.parseProjectId(projectId);
    return await this.client.hasLabel(owner, repo, prNumber, label);
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
}
