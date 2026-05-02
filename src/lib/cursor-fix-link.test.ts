import { describe, expect, it } from 'vitest';
import {
  buildCursorFixLink,
  inferCursorWorkspaceName,
  resolveCursorFixLinkOptions,
} from './cursor-fix-link.js';
import type { DRSConfig } from './config.js';
import type { ReviewIssue } from './comment-formatter.js';

const issue: ReviewIssue = {
  category: 'QUALITY',
  severity: 'HIGH',
  title: 'Missing null check',
  file: 'src/service.ts',
  line: 42,
  problem: 'The handler dereferences a nullable value.',
  solution: 'Add a guard before reading the value.',
  agent: 'quality',
};

describe('cursor-fix-link', () => {
  it('builds a Cursor prompt deeplink for a review issue', () => {
    const link = buildCursorFixLink(issue, { enabled: true, workspace: 'drs' });

    expect(link).toBeDefined();
    const url = new URL(link!);

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('cursor.com');
    expect(url.pathname).toBe('/link/prompt');
    expect(url.searchParams.get('mode')).toBe('agent');
    expect(url.searchParams.get('workspace')).toBe('drs');
    expect(url.searchParams.get('text')).toContain('Fix this DRS review issue');
    expect(url.searchParams.get('text')).toContain('src/service.ts:42');
    expect(url.searchParams.get('text')).toContain('Missing null check');
  });

  it('does not build a link when disabled', () => {
    expect(buildCursorFixLink(issue, { enabled: false })).toBeUndefined();
    expect(buildCursorFixLink(issue)).toBeUndefined();
  });

  it('sanitizes hidden control characters from prompt text', () => {
    const link = buildCursorFixLink(
      {
        ...issue,
        title: 'Hidden\u2028separator',
        problem: 'Zero\u200bwidth',
        solution: 'Paragraph\u2029separator',
      },
      { enabled: true }
    );

    const prompt = new URL(link!).searchParams.get('text')!;
    expect(prompt).toContain('Hidden separator');
    expect(prompt).toContain('Zero width');
    expect(prompt).toContain('Paragraph separator');
    expect(prompt).not.toContain('\u2028');
    expect(prompt).not.toContain('\u2029');
    expect(prompt).not.toContain('\u200b');
  });

  it('infers workspace name from repository-like project IDs', () => {
    expect(inferCursorWorkspaceName('owner/repo', '/tmp/fallback')).toBe('repo');
    expect(inferCursorWorkspaceName('123', '/tmp/drs')).toBe('drs');
  });

  it('resolves config and CLI overrides', () => {
    const config = {
      review: {
        cursorFixLinks: {
          enabled: true,
          workspace: 'configured-workspace',
        },
      },
    } as DRSConfig;

    expect(resolveCursorFixLinkOptions(config, 'owner/repo', '/tmp/repo')).toEqual({
      enabled: true,
      workspace: 'configured-workspace',
    });
    expect(resolveCursorFixLinkOptions(config, 'owner/repo', '/tmp/repo', undefined, true)).toBe(
      undefined
    );
    expect(resolveCursorFixLinkOptions(config, 'owner/repo', '/tmp/repo', true, true)).toEqual({
      enabled: true,
      workspace: 'configured-workspace',
    });
  });
});
