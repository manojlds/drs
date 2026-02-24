import { describe, it, expect } from 'vitest';
import {
  GitHubPositionValidator,
  GitLabPositionValidator,
  validatePositionOrThrow,
} from './position-validator.js';
import type { InlineCommentPosition } from './platform-client.js';

// ── GitHubPositionValidator ──────────────────────────────────────

describe('GitHubPositionValidator', () => {
  const validator = new GitHubPositionValidator();

  it('accepts position with commitSha', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      commitSha: 'abc123',
    };
    expect(validator.validate(position)).toEqual({ isValid: true });
  });

  it('rejects position without commitSha', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
    };
    const result = validator.validate(position);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('commitSha');
  });

  it('accepts when commitSha is present even without GitLab fields', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 5,
      commitSha: 'def456',
      // no baseSha, headSha, startSha
    };
    expect(validator.validate(position).isValid).toBe(true);
  });
});

// ── GitLabPositionValidator ──────────────────────────────────────

describe('GitLabPositionValidator', () => {
  const validator = new GitLabPositionValidator();

  it('accepts position with all required SHA fields', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      baseSha: 'base123',
      headSha: 'head456',
      startSha: 'start789',
    };
    expect(validator.validate(position)).toEqual({ isValid: true });
  });

  it('rejects position missing baseSha', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      headSha: 'head456',
      startSha: 'start789',
    };
    const result = validator.validate(position);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('baseSha');
  });

  it('rejects position missing headSha', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      baseSha: 'base123',
      startSha: 'start789',
    };
    const result = validator.validate(position);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('headSha');
  });

  it('rejects position missing startSha', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      baseSha: 'base123',
      headSha: 'head456',
    };
    const result = validator.validate(position);
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('startSha');
  });

  it('rejects position with no SHA fields at all', () => {
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
    };
    const result = validator.validate(position);
    expect(result.isValid).toBe(false);
  });
});

// ── validatePositionOrThrow ──────────────────────────────────────

describe('validatePositionOrThrow', () => {
  it('does not throw for valid GitHub position', () => {
    const validator = new GitHubPositionValidator();
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      commitSha: 'abc123',
    };
    expect(() => validatePositionOrThrow(position, validator)).not.toThrow();
  });

  it('throws with error message for invalid GitHub position', () => {
    const validator = new GitHubPositionValidator();
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
    };
    expect(() => validatePositionOrThrow(position, validator)).toThrow('GitHub requires commitSha');
  });

  it('does not throw for valid GitLab position', () => {
    const validator = new GitLabPositionValidator();
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      baseSha: 'base',
      headSha: 'head',
      startSha: 'start',
    };
    expect(() => validatePositionOrThrow(position, validator)).not.toThrow();
  });

  it('throws with error message for invalid GitLab position', () => {
    const validator = new GitLabPositionValidator();
    const position: InlineCommentPosition = {
      path: 'src/app.ts',
      line: 10,
      baseSha: 'base',
    };
    expect(() => validatePositionOrThrow(position, validator)).toThrow(
      'GitLab requires baseSha, headSha, and startSha'
    );
  });
});
