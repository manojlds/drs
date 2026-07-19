import { describe, expect, it } from 'vitest';
import {
  analyzeWikiConceptGraph,
  createWikiSiteGraphHtml,
  encodeWikiSiteConceptId,
  extractWikiSiteConceptLinks,
} from './wiki-site-graph.js';

describe('wiki site concept graph', () => {
  it('extracts unique relative concept links outside code', () => {
    const links = extractWikiSiteConceptLinks(
      [
        '---',
        'description: "[Frontmatter](../testing.md)"',
        '---',
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

  it('ignores links in variable-length fences and inline code spans', () => {
    const conceptIds = new Set(['a', 'b']);
    const links = extractWikiSiteConceptLinks(
      [
        '   ````md',
        '[Fenced](b.md)',
        '   ````',
        '``[Inline](b.md)``',
        '`[Multiline',
        'inline](b.md)`',
        '',
        '    [Indented code](b.md)',
        '> ```md',
        '> [Blockquoted fence](b.md)',
        '> ```',
        '- ~~~md',
        '  [List fence](b.md)',
        '  ~~~',
        '~~~md',
        '[Unclosed fence](b.md)',
      ].join('\n'),
      'a',
      conceptIds
    );
    const invalidFenceLinks = extractWikiSiteConceptLinks(
      ['```la`ng', '[Real relationship](b.md)'].join('\n'),
      'a',
      conceptIds
    );

    expect(links).toEqual([]);
    expect(invalidFenceLinks).toEqual(['b']);
  });

  it('keeps links that Markdown tokenization recognizes outside code', () => {
    const conceptIds = new Set(['a', 'b']);
    const examples = [
      ['Paragraph', '    [Indented continuation](b.md)'].join('\n'),
      ['> ```md', '> unclosed quoted fence', '', '[After blockquote](b.md)'].join('\n'),
      '\\`[Between escaped backticks](b.md)\\`',
    ];

    expect(
      examples.map((content) => extractWikiSiteConceptLinks(content, 'a', conceptIds))
    ).toEqual([['b'], ['b'], ['b']]);
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

  it('preserves reciprocal concept links as distinct directed edges', () => {
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

    expect(html).toContain(
      '"edges":[{"source":"architecture","target":"testing"},{"source":"testing","target":"architecture"}]'
    );
    expect(html).toContain(
      '"metrics":{"directedEdgeCount":2,"nodeCount":2,"orphanConceptCount":0,"weaklyConnectedConceptCount":2}'
    );
    expect(html).toContain('marker-end');
    expect(html).toContain("appendNeighborGroup('Links to', outgoingById.get(id))");
    expect(html).toContain("appendNeighborGroup('Linked from', incomingById.get(id))");
    expect(html).toContain('true orphans');
    expect(html).toContain('Arrowheads point from the linking concept to its target.');
  });

  it('collapses same-direction duplicates and reports graph quality metrics', () => {
    const analysis = analyzeWikiConceptGraph([
      { id: 'a', links: ['b', 'b'] },
      { id: 'b', links: [] },
      { id: 'orphan', links: [] },
    ]);

    expect(analysis).toEqual({
      edges: [{ source: 'a', target: 'b' }],
      metrics: {
        directedEdgeCount: 1,
        nodeCount: 3,
        orphanConceptCount: 1,
        weaklyConnectedConceptCount: 2,
      },
      orphanIds: ['orphan'],
      weaklyConnectedIds: ['a', 'b'],
    });
  });

  it('encodes each concept path segment for public URLs', () => {
    expect(encodeWikiSiteConceptId('guides/a #?')).toBe('guides/a%20%23%3F');
  });
});
