import { describe, expect, it } from 'vitest';
import { parseReviewIssues, parseReviewIssuesWithDiagnostics } from './issue-parser.js';

describe('review issue parser diagnostics', () => {
  it('retains legacy behavior and reports malformed output', () => {
    expect(parseReviewIssues('not json')).toEqual([]);
    const result = parseReviewIssuesWithDiagnostics('not json');
    expect(result.diagnostics).toMatchObject({
      rawResponsePresent: true,
      validJson: false,
      validReviewSchema: false,
      validCount: 0,
    });
    expect(result.diagnostics.errors.length).toBeGreaterThan(0);
  });

  it('counts invalid emitted issues', () => {
    const result = parseReviewIssuesWithDiagnostics('```json\n{"issues":[{}]}\n```');
    expect(result.diagnostics).toMatchObject({
      validJson: true,
      validReviewSchema: true,
      emittedCount: 1,
      validCount: 0,
      invalidCount: 1,
    });
  });
});
