import { describe, expect, it } from 'vitest';
import {
  createWikiSiteGraphHtml,
  encodeWikiSiteConceptId,
  extractWikiSiteConceptLinks,
} from './wiki-site-graph.js';

describe('wiki site concept graph', () => {
  it('extracts unique relative concept links outside code', () => {
    const links = extractWikiSiteConceptLinks(
      [
        '[Architecture](../architecture.md#cli)',
        '[Architecture again](../architecture.md)',
        '[External](https://example.com/page.md)',
        '![Image](../testing.md)',
        '`[Inline code](../testing.md)`',
        '```md',
        '[Fenced code](../testing.md)',
        '```',
      ].join('\n'),
      'guides/quickstart',
      new Set(['architecture', 'testing', 'guides/quickstart'])
    );

    expect(links).toEqual(['architecture']);
  });

  it('renders graph data without interpolating concept markup as HTML', () => {
    const html = createWikiSiteGraphHtml(
      [
        {
          id: 'architecture',
          title: '<img src=x onerror=alert(1)>',
          type: 'Architecture',
          description: '</script><script>alert(1)</script>',
          links: [],
        },
      ],
      { base: '/docs/', siteTitle: 'Knowledge <Map>' }
    );

    expect(html).toContain('href="/docs/"');
    expect(html).toContain('Knowledge &lt;Map&gt;');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('Content-Security-Policy');
  });

  it('renders reciprocal concept links as one graph edge', () => {
    const html = createWikiSiteGraphHtml(
      [
        {
          id: 'testing',
          title: 'Testing',
          type: 'Guide',
          description: '',
          links: ['architecture'],
        },
        {
          id: 'architecture',
          title: 'Architecture',
          type: 'Guide',
          description: '',
          links: ['testing'],
        },
      ],
      { base: '/', siteTitle: 'Knowledge Map' }
    );

    expect(html).toContain('"edges":[{"source":"architecture","target":"testing"}]');
  });

  it('encodes each concept path segment for public URLs', () => {
    expect(encodeWikiSiteConceptId('guides/a #?')).toBe('guides/a%20%23%3F');
  });
});
