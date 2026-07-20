import { describe, expect, it } from 'vitest';
import {
  isSafeWikiSiteRemoteUrl,
  neutralizeWikiSiteMarkdown,
  normalizeWikiSiteBase,
  readWikiSiteOkfVersion,
  sanitizeWikiSiteFrontmatter,
} from './wiki-site-safety.js';

describe('wiki site publishing safety', () => {
  it('neutralizes VitePress file reads and executable SFC blocks', () => {
    const source = [
      '<!-- @include: ../secret.txt -->',
      '<<< ../secret.txt',
      '<script setup>alert(1)</script>',
      '<style>body { display: none }</style>',
      '<template><img src=x></template>',
    ].join('\n');

    const safe = neutralizeWikiSiteMarkdown(source);

    expect(safe).not.toMatch(/<!--\s*@include:/);
    expect(safe).not.toMatch(/^\s{0,3}<</m);
    expect(safe).not.toMatch(/<(?:\/?)(?:script|style|template)(?=[\s>])/i);
    expect(safe).toContain('&lt;!-- @include:');
    expect(safe).toContain('&lt;&lt;&lt; ../secret.txt');
  });

  it('passes only inert OKF metadata to VitePress', () => {
    expect(
      sanitizeWikiSiteFrontmatter({
        type: 'Workflow',
        title: 'Review',
        tags: ['review', 3],
        resource: 'javascript:alert(1)',
        head: [['script', {}, 'alert(1)']],
        layout: 'home',
      })
    ).toEqual({
      type: 'Workflow',
      title: 'Review',
      tags: ['review', '3'],
      resource: 'javascript:alert(1)',
    });
  });

  it('passes sanitized drs_sources through to the theme', () => {
    expect(
      sanitizeWikiSiteFrontmatter({
        type: 'Guide',
        drs_sources: [
          { path: 'src/app.ts', symbols: ['value', 42] },
          { path: '' },
          'junk',
          { path: 'src/wiki.ts', symbols: 'not-a-list' },
        ],
      })
    ).toEqual({
      type: 'Guide',
      drs_sources: [{ path: 'src/app.ts', symbols: ['value', '42'] }, { path: 'src/wiki.ts' }],
    });
    expect(sanitizeWikiSiteFrontmatter({ drs_sources: 'junk' })).toEqual({});
  });

  it('allows only HTTP resources and images', () => {
    expect(isSafeWikiSiteRemoteUrl('https://example.com/concept')).toBe(true);
    expect(isSafeWikiSiteRemoteUrl('http://example.com/image.png')).toBe(true);
    expect(isSafeWikiSiteRemoteUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeWikiSiteRemoteUrl('data:image/svg+xml,<svg/>')).toBe(false);
    expect(isSafeWikiSiteRemoteUrl('../secret.txt')).toBe(false);
  });

  it('requires an absolute directory base', () => {
    expect(normalizeWikiSiteBase('/drs/')).toBe('/drs/');
    expect(() => normalizeWikiSiteBase('drs/')).toThrow(/start and end with a slash/);
    expect(() => normalizeWikiSiteBase('/drs')).toThrow(/start and end with a slash/);
  });

  it('reads equivalent YAML forms of the OKF version', () => {
    expect(readWikiSiteOkfVersion("---\nokf_version: '0.1'\n---\n")).toBe('0.1');
    expect(readWikiSiteOkfVersion('---\nokf_version: 0.1\n---\n')).toBeUndefined();
    expect(readWikiSiteOkfVersion('not frontmatter')).toBeUndefined();
  });
});
