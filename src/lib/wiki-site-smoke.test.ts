import { describe, expect, it, vi } from 'vitest';
import { checkWikiSite, waitForWikiSite } from './wiki-site-smoke.js';

const baseUrl = 'https://example.com/docs/';

describe('wiki site smoke check', () => {
  it('checks pages, required outputs, and same-origin assets', async () => {
    const fetchMock = createFetchMock({
      [baseUrl]: html(
        '<div id="local-search"></div><script>{"provider":"local"}</script><a href="/docs/quickstart.html">Start</a><link href="/docs/assets/site.css">'
      ),
      [`${baseUrl}graph.html`]: graphHtml(),
      [`${baseUrl}llms.txt`]: llmsText(),
      [`${baseUrl}okf/index.md`]: text("---\nokf_version: '0.1'\n---"),
      [`${baseUrl}sitemap.xml`]: xml(
        '<urlset><url><loc>https://example.com/docs/</loc></url><url><loc>https://example.com/docs/quickstart.html</loc></url></urlset>'
      ),
      [`${baseUrl}quickstart.html`]: html('<a href="/docs/">Home</a>'),
      [`${baseUrl}assets/site.css`]: text('body {}', 'text/css'),
    });

    await expect(checkWikiSite(baseUrl, { fetch: fetchMock })).resolves.toEqual({
      baseUrl,
      pagesChecked: 2,
      assetsChecked: 5,
    });
  });

  it('rejects internal links that escape the configured base', async () => {
    const fetchMock = createFetchMock({
      [baseUrl]: html(
        '<div id="local-search"></div><script>{"provider":"local"}</script><a href="/admin">Escape</a>'
      ),
      [`${baseUrl}graph.html`]: graphHtml(),
      [`${baseUrl}llms.txt`]: llmsText(),
      [`${baseUrl}okf/index.md`]: text('---\nokf_version: "0.1"\n---'),
      [`${baseUrl}sitemap.xml`]: xml(`<urlset><url><loc>${baseUrl}</loc></url></urlset>`),
    });

    await expect(checkWikiSite(baseUrl, { fetch: fetchMock })).rejects.toThrow(
      /escapes configured base/
    );
  });

  it('retries until the deployment becomes available', async () => {
    const responses = validResponses();
    let rootAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url === baseUrl && rootAttempts++ === 0) return new Response('', { status: 404 });
      return responses[url]?.clone() ?? new Response('', { status: 404 });
    });

    await expect(
      waitForWikiSite(baseUrl, { fetch: fetchMock, attempts: 2, delayMs: 0 })
    ).resolves.toMatchObject({ baseUrl });
    expect(rootAttempts).toBe(2);
  });

  it('rejects malformed graph data', async () => {
    const responses = validResponses();
    responses[`${baseUrl}graph.html`] = html(
      '<script id="graph-data" type="application/json">{}</script>'
    );

    await expect(checkWikiSite(baseUrl, { fetch: createFetchMock(responses) })).rejects.toThrow(
      /invalid concept graph data/
    );
  });

  it('rejects redirects outside the configured base', async () => {
    const responses = validResponses();
    Object.defineProperty(responses[baseUrl], 'url', {
      value: 'https://example.net/docs/',
    });

    await expect(checkWikiSite(baseUrl, { fetch: createFetchMock(responses) })).rejects.toThrow(
      /escapes configured base/
    );
  });

  it('rejects browser assets with an invalid content type', async () => {
    const responses = validResponses();
    responses[baseUrl] = html(
      '<div id="local-search"></div><script>{"provider":"local"}</script><script type="module" src="/docs/assets/app.js"></script>'
    );
    const fallback = html('HTML fallback');
    Object.defineProperty(fallback, 'url', { value: `${baseUrl}index.html` });
    responses[`${baseUrl}assets/app.js`] = fallback;

    await expect(checkWikiSite(baseUrl, { fetch: createFetchMock(responses) })).rejects.toThrow(
      /unexpected content type/
    );
  });
});

function validResponses(): Record<string, Response> {
  return {
    [baseUrl]: html('<div id="local-search"></div><script>{"provider":"local"}</script>'),
    [`${baseUrl}graph.html`]: graphHtml(),
    [`${baseUrl}llms.txt`]: llmsText(),
    [`${baseUrl}okf/index.md`]: text('---\nokf_version: "0.1"\n---'),
    [`${baseUrl}sitemap.xml`]: xml(`<urlset><url><loc>${baseUrl}</loc></url></urlset>`),
    [`${baseUrl}quickstart.html`]: html('<a href="/docs/">Home</a>'),
  };
}

function graphHtml(): Response {
  return html(
    '<script id="graph-data" type="application/json">{"nodes":[{"id":"quickstart","title":"Start","type":"Guide","description":"Start here","color":"#fff","href":"/docs/quickstart.html"}],"edges":[],"types":["Guide"]}</script>'
  );
}

function llmsText(): Response {
  return text(
    `# Wiki\n\n- [Start](${baseUrl}quickstart.html)\n- [Graph](${baseUrl}graph.html)\n- [Raw](${baseUrl}okf/index.md)`
  );
}

function createFetchMock(responses: Record<string, Response>): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    const response = responses[url];
    if (!response) return new Response('', { status: 404 });
    const clone = response.clone();
    if (response.url) Object.defineProperty(clone, 'url', { value: response.url });
    return clone;
  });
}

function html(content: string): Response {
  return text(content, 'text/html');
}

function text(content: string, contentType = 'text/plain'): Response {
  return new Response(content, { status: 200, headers: { 'content-type': contentType } });
}

function xml(content: string): Response {
  return text(content, 'application/xml');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
