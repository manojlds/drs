import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postErrorComment, removeErrorComment } from './error-comment-poster.js';
import { ERROR_COMMENT_ID } from './comment-manager.js';
import type { PlatformClient } from './platform-client.js';

// Mock chalk to avoid color output in tests
vi.mock('chalk', () => ({
  default: {
    gray: (s: string) => s,
    yellow: (s: string) => s,
    green: (s: string) => s,
  },
}));

describe('error-comment-poster', () => {
  // Mock platform client
  const createMockPlatformClient = (overrides?: Partial<PlatformClient>): PlatformClient => ({
    getPullRequest: vi.fn(),
    getChangedFiles: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
    getInlineComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn().mockResolvedValue(undefined),
    updateComment: vi.fn().mockResolvedValue(undefined),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    createInlineComment: vi.fn(),
    createBulkInlineComments: vi.fn(),
    addLabels: vi.fn(),
    hasLabel: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('postErrorComment', () => {
    it('should create new error comment when none exists', async () => {
      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue([]),
      });

      await postErrorComment(mockClient, 'owner/repo', 123);

      expect(mockClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockClient.createComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        expect.stringContaining(`<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`)
      );
      expect(mockClient.updateComment).not.toHaveBeenCalled();
    });

    it('should update existing error comment when one exists', async () => {
      const existingErrorComment = {
        id: 42,
        body: `Old error\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`,
      };

      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue([existingErrorComment]),
      });

      await postErrorComment(mockClient, 'owner/repo', 123);

      expect(mockClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockClient.updateComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        42,
        expect.stringContaining('DRS Review Failed')
      );
      expect(mockClient.createComment).not.toHaveBeenCalled();
    });

    it('should not update unrelated comments', async () => {
      const otherComments = [
        { id: 1, body: 'Regular comment' },
        { id: 2, body: '<!-- drs-comment-id: drs-review-summary -->' },
      ];

      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue(otherComments),
      });

      await postErrorComment(mockClient, 'owner/repo', 123);

      expect(mockClient.createComment).toHaveBeenCalled();
      expect(mockClient.updateComment).not.toHaveBeenCalled();
    });

    it('should include error marker and check logs message in posted comment', async () => {
      const mockClient = createMockPlatformClient();

      await postErrorComment(mockClient, 'project-id', 456);

      const calledBody = (mockClient.createComment as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(calledBody).toContain(`<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`);
      expect(calledBody).toContain('DRS Review Failed');
      expect(calledBody).toContain('check the CI/CD logs');
    });
  });

  describe('removeErrorComment', () => {
    it('should delete existing error comment', async () => {
      const existingErrorComment = {
        id: 99,
        body: `Error!\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`,
      };

      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue([existingErrorComment]),
      });

      await removeErrorComment(mockClient, 'owner/repo', 123);

      expect(mockClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockClient.deleteComment).toHaveBeenCalledWith('owner/repo', 123, 99);
    });

    it('should not delete anything when no error comment exists', async () => {
      const otherComments = [
        { id: 1, body: 'Regular comment' },
        { id: 2, body: '<!-- drs-comment-id: drs-review-summary -->' },
      ];

      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue(otherComments),
      });

      await removeErrorComment(mockClient, 'owner/repo', 123);

      expect(mockClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockClient.deleteComment).not.toHaveBeenCalled();
    });

    it('should handle empty comments array', async () => {
      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue([]),
      });

      await removeErrorComment(mockClient, 'owner/repo', 123);

      expect(mockClient.deleteComment).not.toHaveBeenCalled();
    });

    it('should handle delete failure gracefully', async () => {
      const existingErrorComment = {
        id: 99,
        body: `Error!\n<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`,
      };

      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockResolvedValue([existingErrorComment]),
        deleteComment: vi.fn().mockRejectedValue(new Error('Delete failed')),
      });

      // Should not throw
      await expect(removeErrorComment(mockClient, 'owner/repo', 123)).resolves.not.toThrow();
    });

    it('should handle getComments failure gracefully', async () => {
      const mockClient = createMockPlatformClient({
        getComments: vi.fn().mockRejectedValue(new Error('Network error')),
      });

      // Should not throw
      await expect(removeErrorComment(mockClient, 'owner/repo', 123)).resolves.not.toThrow();
    });
  });
});
