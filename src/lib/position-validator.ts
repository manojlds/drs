/**
 * Position validation utilities for platform-specific inline comment requirements
 */

import type { InlineCommentPosition } from './platform-client.js';

/**
 * Result of position validation
 */
export interface PositionValidationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Base interface for position validators
 */
export interface PositionValidator {
  validate(position: InlineCommentPosition): PositionValidationResult;
}

/**
 * GitHub position validator
 * Requires: commitSha
 */
export class GitHubPositionValidator implements PositionValidator {
  validate(position: InlineCommentPosition): PositionValidationResult {
    if (!position.commitSha) {
      return {
        isValid: false,
        error: 'GitHub requires commitSha for inline comments',
      };
    }
    return { isValid: true };
  }
}

/**
 * GitLab position validator
 * Requires: baseSha, headSha, startSha
 */
export class GitLabPositionValidator implements PositionValidator {
  validate(position: InlineCommentPosition): PositionValidationResult {
    if (!position.baseSha || !position.headSha || !position.startSha) {
      return {
        isValid: false,
        error: 'GitLab requires baseSha, headSha, and startSha for inline comments',
      };
    }
    return { isValid: true };
  }
}

/**
 * Helper to validate and throw if invalid
 */
export function validatePositionOrThrow(
  position: InlineCommentPosition,
  validator: PositionValidator
): void {
  const result = validator.validate(position);
  if (!result.isValid) {
    throw new Error(result.error);
  }
}
