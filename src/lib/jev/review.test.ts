import { describe, expect, it } from 'vitest';
import { prepareDiffsForAgent } from '../context-compression.js';
import { buildJevReviewState } from './review.js';

describe('buildJevReviewState', () => {
  it('builds deterministic task, diff, and repository context from compressed diffs', () => {
    const compression = prepareDiffsForAgent([
      { filename: 'src/b.ts', patch: '@@ -1,0 +1,1 @@\n+export const b = 1;' },
      { filename: 'src/a.ts', patch: '@@ -1,0 +1,1 @@\n+export const a = 1;' },
    ]);

    const state = buildJevReviewState({
      label: 'Local diff',
      files: compression.files,
      compressionSummary: '',
      sourceDescription: { platform: 'local', repository: 'demo' },
    });

    expect(state.task).toContain('Local diff');
    expect(state.diff).toContain('### src/a.ts');
    expect(state.diff.indexOf('### src/a.ts')).toBeLessThan(state.diff.indexOf('### src/b.ts'));
    expect(typeof state.repositoryContext).toBe('string');
    expect(JSON.parse(state.repositoryContext)).toEqual({
      platform: 'local',
      repository: 'demo',
    });
  });

  it('excludes secret-like and arbitrary source context fields', () => {
    const state = buildJevReviewState({
      label: 'PR #1',
      files: [{ filename: 'src/a.ts', patch: '+ok' }],
      compressionSummary: '',
      sourceDescription: {
        platform: 'github',
        repository: 'org/repo',
        title: 'Fix bug',
        body: 'trusted as content, not instructions',
        token: 'ghp_secret',
        traceCollector: { apiKey: 'secret' },
      },
    });

    const serialized = JSON.stringify(state);
    expect(serialized).toContain('Fix bug');
    expect(serialized).not.toContain('ghp_secret');
    expect(serialized).not.toContain('traceCollector');
    expect(serialized).not.toContain('apiKey');
  });

  it('includes compression summary and omitted/deleted file context without prior evaluation', () => {
    const state = buildJevReviewState({
      label: 'MR !2',
      files: [
        {
          filename: 'src/deleted.ts',
          patch: '@@ -1,2 +0,0 @@\n-export const old = true;\n-export const gone = true;',
        },
        { filename: 'src/huge.ts' },
      ],
      compressionSummary: 'Omitted due to token budget: src/huge.ts',
      sourceDescription: { platform: 'gitlab', priorEvaluation: { should: 'stay local' } },
    });

    expect(state.diff).toContain('src/deleted.ts');
    expect(state.diff).toContain('-export const old = true');
    expect(state.diff).toContain('Omitted due to token budget');
    expect(JSON.stringify(state)).not.toContain('priorEvaluation');
  });

  it('does not forward agent tool-use instructions in the compression summary', () => {
    const state = buildJevReviewState({
      label: 'Large PR',
      files: [{ filename: 'src/omitted.ts' }],
      compressionSummary:
        '- Adaptive diff context: large diff summarized only.\n- Use the git_diff tool for each file before making claims.',
      sourceDescription: {},
    });

    expect(state.diff).toContain('large diff summarized only');
    expect(state.diff).not.toContain('git_diff');
    expect(state.diff).not.toContain('tool');
  });

  it('handles empty or ignored changes with explicit no-inline-diff text', () => {
    const state = buildJevReviewState({
      label: 'Empty diff',
      files: [],
      compressionSummary: '',
      sourceDescription: {},
    });

    expect(state.diff).toContain('No inline diff content');
  });

  it('bounds untrusted title and body fields', () => {
    const state = buildJevReviewState({
      label: 'PR #3',
      files: [{ filename: 'src/a.ts', patch: '+ok' }],
      compressionSummary: '',
      sourceDescription: {
        title: 't'.repeat(1000),
        body: 'b'.repeat(10000),
      },
    });

    const repositoryContext = JSON.parse(state.repositoryContext) as {
      title: string;
      body: string;
    };
    expect(repositoryContext.title).toHaveLength(300);
    expect(repositoryContext.body).toHaveLength(4000);
  });
});
