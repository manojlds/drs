import { Gitlab } from '@gitbeaker/node';

export interface GitLabConfig {
  url: string;
  token: string;
}

export interface MRChange {
  oldPath: string;
  newPath: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  diff: string;
}

export class GitLabClient {
  private client: InstanceType<typeof Gitlab>;

  constructor(config: GitLabConfig) {
    this.client = new Gitlab({
      host: config.url,
      token: config.token,
    });
  }

  /**
   * Get merge request details
   */
  async getMergeRequest(projectId: string, mrIid: number) {
    return await this.client.MergeRequests.show(projectId, mrIid);
  }

  /**
   * Get merge request changes (diffs)
   */
  async getMRChanges(projectId: string, mrIid: number): Promise<MRChange[]> {
    const mr = (await this.client.MergeRequests.changes(projectId, mrIid)) as {
      changes?: Array<{
        old_path: string;
        new_path: string;
        new_file: boolean;
        renamed_file: boolean;
        deleted_file: boolean;
        diff: string;
      }>;
    };
    if (!mr.changes) return [];

    return mr.changes.map((change) => ({
      oldPath: change.old_path,
      newPath: change.new_path,
      newFile: change.new_file,
      renamedFile: change.renamed_file,
      deletedFile: change.deleted_file,
      diff: change.diff,
    }));
  }

  /**
   * Get all notes (comments) on an MR
   */
  async getMRNotes(projectId: string, mrIid: number) {
    return await this.client.MergeRequestNotes.all(projectId, mrIid);
  }

  /**
   * Get all discussion threads on an MR
   */
  async getMRDiscussions(projectId: string, mrIid: number) {
    return await this.client.MergeRequestDiscussions.all(projectId, mrIid);
  }

  /**
   * Post a comment to the MR
   */
  async createMRComment(projectId: string, mrIid: number, body: string) {
    return await this.client.MergeRequestNotes.create(projectId, mrIid, body);
  }

  /**
   * Update an existing note (comment) on an MR
   */
  async updateMRNote(projectId: string, mrIid: number, noteId: number, body: string) {
    return await this.client.MergeRequestNotes.edit(projectId, mrIid, noteId, body);
  }

  /**
   * Create a discussion thread on a specific line
   */
  async createMRDiscussionThread(
    projectId: string,
    mrIid: number,
    body: string,
    position: {
      baseSha: string;
      headSha: string;
      startSha: string;
      newPath: string;
      newLine: number;
    }
  ) {
    return await this.client.MergeRequestDiscussions.create(projectId, mrIid, body, {
      position: {
        position_type: 'text',
        ...position,
      },
    });
  }

  /**
   * Add a label to the MR
   */
  async addLabel(projectId: string, mrIid: number, labels: string[]) {
    const mr = await this.getMergeRequest(projectId, mrIid);
    const currentLabels = Array.isArray(mr.labels) ? mr.labels : [];
    const newLabels = [...new Set([...currentLabels, ...labels])];

    return await this.client.MergeRequests.edit(projectId, mrIid, {
      labels: newLabels.join(','),
    });
  }

  /**
   * Check if MR has a specific label
   */
  async hasLabel(projectId: string, mrIid: number, label: string): Promise<boolean> {
    const mr = await this.getMergeRequest(projectId, mrIid);
    const labels = Array.isArray(mr.labels) ? mr.labels : [];
    return labels.includes(label);
  }

  /**
   * Get project details
   */
  async getProject(projectId: string) {
    return await this.client.Projects.show(projectId);
  }
}

/**
 * Create a GitLab client from environment variables
 */
export function createGitLabClient(): GitLabClient {
  const url = process.env.GITLAB_URL || 'https://gitlab.com';
  const token = process.env.GITLAB_TOKEN;

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable is required');
  }

  return new GitLabClient({ url, token });
}
