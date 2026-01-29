import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postErrorComment, removeErrorComment, sanitizeErrorMessage } from './error-comment-poster.js';
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
  describe('sanitizeErrorMessage', () => {
    it('should pass through simple error messages unchanged', () => {
      const message = 'Connection failed';
      expect(sanitizeErrorMessage(message)).toBe('Connection failed');
    });

    it('should redact API tokens with token= format', () => {
      const message = 'Error: token=abc123def456xyz789';
      expect(sanitizeErrorMessage(message)).toBe('Error: [REDACTED]');
    });

    it('should redact API keys with key= format', () => {
      const message = 'Failed with api_key=supersecretkey123';
      expect(sanitizeErrorMessage(message)).toBe('Failed with [REDACTED]');
    });

    it('should redact Bearer tokens', () => {
      const message = 'Auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      expect(sanitizeErrorMessage(message)).toBe('Auth failed: Bearer [REDACTED]');
    });

    it('should redact GitHub tokens', () => {
      const message = 'GitHub error with ghp_1234567890abcdefghij';
      expect(sanitizeErrorMessage(message)).toBe('GitHub error with [REDACTED]');
    });

    it('should redact GitLab tokens', () => {
      const message = 'GitLab error with glpat-abcdef123456789';
      expect(sanitizeErrorMessage(message)).toBe('GitLab error with [REDACTED]');
    });

    it('should mask absolute Unix file paths', () => {
      const message = 'Error in /home/developer/projects/myapp/src/index.ts';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).not.toContain('/home/developer/projects/myapp/src');
      expect(sanitized).toContain('index.ts');
    });

    it('should mask home directory paths', () => {
      const message = 'File not found: /home/johnsmith/secret/config.json';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).not.toContain('johnsmith');
      expect(sanitized).not.toContain('/home/johnsmith');
      // Path is sanitized to just the filename
      expect(sanitized).toContain('config.json');
    });

    it('should mask Windows file paths', () => {
      const message = 'Error in C:\\Users\\Developer\\Projects\\app\\src\\main.ts';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).not.toContain('Developer\\Projects\\app\\src');
    });

    it('should truncate stack traces', () => {
      const message = `Error: Something went wrong
    at Object.<anonymous> (/path/to/file.js:10:5)
    at Module._compile (internal/modules/cjs/loader.js:1085:14)
    at Object.Module._extensions..js (internal/modules/cjs/loader.js:1114:10)`;
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('Error: Something went wrong');
      expect(sanitized).toContain('[Stack trace truncated]');
      expect(sanitized).not.toContain('Module._compile');
    });

    it('should redact environment variable patterns', () => {
      const message = 'Config error: $DATABASE_URL=postgres://secret';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).toContain('[ENV_VAR]');
      expect(sanitized).not.toContain('postgres://secret');
    });

    it('should truncate very long messages', () => {
      const longMessage = 'Error: ' + 'x'.repeat(600);
      const sanitized = sanitizeErrorMessage(longMessage);
      expect(sanitized.length).toBeLessThanOrEqual(520); // 500 + '... [truncated]'
      expect(sanitized).toContain('[truncated]');
    });

    it('should handle multiple sensitive items in one message', () => {
      const message =
        'Failed at /home/user/app/src/index.ts with token=abc123def456 and Bearer xyz789abc';
      const sanitized = sanitizeErrorMessage(message);
      expect(sanitized).not.toContain('abc123def456');
      expect(sanitized).not.toContain('xyz789abc');
      expect(sanitized).not.toContain('/home/user/app/src');
    });

    it('should handle empty messages', () => {
      expect(sanitizeErrorMessage('')).toBe('');
    });

    it('should redact password patterns', () => {
      const message = 'Database connection failed: password=mysecretpassword123';
      expect(sanitizeErrorMessage(message)).toBe('Database connection failed: [REDACTED]');
    });
  });

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

      await postErrorComment(mockClient, 'owner/repo', 123, 'Test error message');

      expect(mockClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockClient.createComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        expect.stringContaining('Test error message')
      );
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

      await postErrorComment(mockClient, 'owner/repo', 123, 'New error message');

      expect(mockClient.getComments).toHaveBeenCalledWith('owner/repo', 123);
      expect(mockClient.updateComment).toHaveBeenCalledWith(
        'owner/repo',
        123,
        42,
        expect.stringContaining('New error message')
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

      await postErrorComment(mockClient, 'owner/repo', 123, 'Error');

      expect(mockClient.createComment).toHaveBeenCalled();
      expect(mockClient.updateComment).not.toHaveBeenCalled();
    });

    it('should include error marker in posted comment', async () => {
      const mockClient = createMockPlatformClient();

      await postErrorComment(mockClient, 'project-id', 456, 'Connection failed');

      const calledBody = (mockClient.createComment as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(calledBody).toContain(`<!-- drs-comment-id: ${ERROR_COMMENT_ID} -->`);
      expect(calledBody).toContain('Connection failed');
      expect(calledBody).toContain('DRS Review Failed');
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
