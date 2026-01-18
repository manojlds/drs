/**
 * Platform abstraction layer for GitHub and GitLab
 *
 * This module provides common interfaces for interacting with different
 * code review platforms (GitHub, GitLab) in a unified way.
 */

/**
 * Represents a file change in a pull/merge request
 */
export interface FileChange {
  /** Path to the file */
  filename: string;
  /** Type of change */
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
  /** Unified diff patch */
  patch?: string;
  /** Previous filename (for renamed files) */
  previousFilename?: string;
}

/**
 * Represents a pull/merge request
 */
export interface PullRequest {
  /** PR/MR number or ID */
  number: number;
  /** Title */
  title: string;
  /** Description/body */
  description?: string;
  /** Author username or name */
  author: string;
  /** Source branch */
  sourceBranch: string;
  /** Target branch */
  targetBranch: string;
  /** Head commit SHA */
  headSha: string;
  /** Additional platform-specific data */
  platformData?: unknown;
}

/**
 * Represents a comment on a PR/MR
 */
export interface Comment {
  /** Comment ID */
  id: number | string;
  /** Comment body/content */
  body: string;
}

/**
 * Position data for inline comments
 */
export interface InlineCommentPosition {
  /** File path */
  path: string;
  /** Line number in the new version */
  line: number;
  /** Commit SHA (GitHub) or diff refs (GitLab) */
  commitSha?: string;
  baseSha?: string;
  headSha?: string;
  startSha?: string;
}

/**
 * Common interface for platform clients (GitHub, GitLab, etc.)
 */
export interface PlatformClient {
  /**
   * Get pull/merge request details
   */
  getPullRequest(projectId: string, prNumber: number): Promise<PullRequest>;

  /**
   * Get list of changed files in a PR/MR
   */
  getChangedFiles(projectId: string, prNumber: number): Promise<FileChange[]>;

  /**
   * Get existing comments on the PR/MR
   */
  getComments(projectId: string, prNumber: number): Promise<Comment[]>;

  /**
   * Get existing inline/review comments
   */
  getInlineComments(projectId: string, prNumber: number): Promise<Comment[]>;

  /**
   * Create a general comment on the PR/MR
   */
  createComment(projectId: string, prNumber: number, body: string): Promise<void>;

  /**
   * Update an existing comment
   */
  updateComment(
    projectId: string,
    prNumber: number,
    commentId: number | string,
    body: string
  ): Promise<void>;

  /**
   * Create an inline comment at a specific line
   */
  createInlineComment(
    projectId: string,
    prNumber: number,
    body: string,
    position: InlineCommentPosition
  ): Promise<void>;

  /**
   * Create multiple inline comments in bulk (if supported)
   * Falls back to individual comments if not supported
   */
  createBulkInlineComments(
    projectId: string,
    prNumber: number,
    comments: Array<{ body: string; position: InlineCommentPosition }>
  ): Promise<void>;

  /**
   * Add labels to the PR/MR
   */
  addLabels(projectId: string, prNumber: number, labels: string[]): Promise<void>;

  /**
   * Check if PR/MR has a specific label
   */
  hasLabel(projectId: string, prNumber: number, label: string): Promise<boolean>;
}

/**
 * Validator for checking if a line can be commented on
 */
export interface LineValidator {
  /**
   * Check if a line number is valid for commenting
   */
  isValidLine(file: string, line: number): boolean;
}

/**
 * Factory function type for creating platform clients
 */
export type PlatformClientFactory = () => PlatformClient;
