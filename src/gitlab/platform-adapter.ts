/**
 * GitLab platform adapter implementing the common PlatformClient interface
 */

import chalk from 'chalk';
import type { GitLabClient } from './client.js';
import type {
  PlatformClient,
  PullRequest,
  FileChange,
  Comment,
  InlineCommentPosition,
} from '../lib/platform-client.js';
import { GitLabPositionValidator, validatePositionOrThrow } from '../lib/position-validator.js';

/**
 * Adapter that wraps GitLabClient to implement PlatformClient interface
 */
export class GitLabPlatformAdapter implements PlatformClient {
  private readonly positionValidator = new GitLabPositionValidator();

  constructor(private client: GitLabClient) {}

  async getPullRequest(projectId: string, prNumber: number): Promise<PullRequest> {
    const mr = await this.client.getMergeRequest(projectId, prNumber);

    return {
      number: mr.iid,
      title: mr.title,
      description: mr.description || undefined,
      author: (mr.author?.name || mr.author?.username || 'Unknown') as string,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      headSha: (mr as any).diff_refs?.head_sha || (mr as any).sha || '',
      platformData: mr,
    };
  }

  async getChangedFiles(projectId: string, prNumber: number): Promise<FileChange[]> {
    const changes = await this.client.getMRChanges(projectId, prNumber);

    return changes.map((change) => {
      let status: FileChange['status'] = 'modified';
      if (change.newFile) status = 'added';
      else if (change.deletedFile) status = 'removed';
      else if (change.renamedFile) status = 'renamed';

      return {
        filename: change.newPath,
        status,
        additions: 0, // GitLab doesn't provide this in the same way
        deletions: 0,
        patch: change.diff,
        previousFilename: change.renamedFile ? change.oldPath : undefined,
      };
    });
  }

  async getComments(projectId: string, prNumber: number): Promise<Comment[]> {
    const notes = await this.client.getMRNotes(projectId, prNumber);

    return notes.map((n) => ({
      id: n.id,
      body: n.body,
    }));
  }

  async getInlineComments(projectId: string, prNumber: number): Promise<Comment[]> {
    const discussions = await this.client.getMRDiscussions(projectId, prNumber);

    // Flatten all discussion notes
    const comments: Comment[] = [];
    for (const discussion of discussions) {
      if (discussion.notes) {
        for (const note of discussion.notes) {
          comments.push({
            id: note.id,
            body: note.body,
          });
        }
      }
    }

    return comments;
  }

  async createComment(projectId: string, prNumber: number, body: string): Promise<void> {
    await this.client.createMRComment(projectId, prNumber, body);
  }

  async updateComment(
    projectId: string,
    prNumber: number,
    commentId: number | string,
    body: string
  ): Promise<void> {
    await this.client.updateMRNote(projectId, prNumber, Number(commentId), body);
  }

  async createInlineComment(
    projectId: string,
    prNumber: number,
    body: string,
    position: InlineCommentPosition
  ): Promise<void> {
    // Validate position requirements for GitLab
    validatePositionOrThrow(position, this.positionValidator);

    try {
      await this.client.createMRDiscussionThread(projectId, prNumber, body, {
        baseSha: position.baseSha!,
        headSha: position.headSha!,
        startSha: position.startSha!,
        newPath: position.path,
        newLine: position.line,
      });
    } catch (error) {
      // If line-specific comment fails, post as general comment
      console.warn(
        chalk.yellow(`  ⚠ Could not post line comment for ${position.path}:${position.line}`)
      );
      await this.client.createMRComment(projectId, prNumber, body);
    }
  }

  async createBulkInlineComments(
    projectId: string,
    prNumber: number,
    comments: Array<{ body: string; position: InlineCommentPosition }>
  ): Promise<void> {
    if (comments.length === 0) return;

    console.log(
      chalk.gray(`\nPosting ${comments.length} new inline comment(s) as discussion threads...\n`)
    );

    // GitLab doesn't have a bulk API, post individually in parallel
    const results = await Promise.allSettled(
      comments.map(async (comment) => {
        try {
          await this.createInlineComment(projectId, prNumber, comment.body, comment.position);
          console.log(
            chalk.gray(
              `  ✓ Posted inline comment for ${comment.position.path}:${comment.position.line}`
            )
          );
        } catch (error: any) {
          console.warn(
            chalk.yellow(
              `  ⚠ Could not post inline comment for ${comment.position.path}:${comment.position.line} - ${error.message}`
            )
          );
          throw error; // Re-throw to mark as rejected
        }
      })
    );

    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    console.log(chalk.green(`✓ Posted ${successCount}/${comments.length} inline comment(s)`));
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]): Promise<void> {
    await this.client.addLabel(projectId, prNumber, labels);
  }

  async hasLabel(projectId: string, prNumber: number, label: string): Promise<boolean> {
    return await this.client.hasLabel(projectId, prNumber, label);
  }
}
