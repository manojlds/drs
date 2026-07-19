import MarkdownIt from 'markdown-it';
import { posix } from 'path';

export interface WikiSiteGraphConcept {
  description: string;
  id: string;
  links: string[];
  title: string;
  type: string;
}

export interface WikiSiteGraphOptions {
  base: string;
  siteTitle: string;
}

export interface WikiConceptGraphEdge {
  source: string;
  target: string;
}

export interface WikiConceptGraphMetrics {
  directedEdgeCount: number;
  nodeCount: number;
  orphanConceptCount: number;
  weaklyConnectedConceptCount: number;
}

export interface WikiConceptGraphAnalysis {
  edges: WikiConceptGraphEdge[];
  metrics: WikiConceptGraphMetrics;
  orphanIds: string[];
  weaklyConnectedIds: string[];
}

interface GraphNode extends WikiSiteGraphConcept {
  color: string;
  href: string;
}

const TYPE_COLORS = [
  '#8ea2ff',
  '#f28b6d',
  '#63c7b2',
  '#d4a85b',
  '#b68cff',
  '#70b6e8',
  '#df7da8',
  '#93bd68',
];
const markdownParser = new MarkdownIt({ html: false });

export function extractWikiSiteConceptLinks(
  content: string,
  currentId: string,
  conceptIds: ReadonlySet<string>
): string[] {
  const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '');
  const links = new Set<string>();
  for (const token of markdownParser.parse(body, {})) {
    for (const child of token.children ?? []) {
      if (child.type !== 'link_open') continue;
      const rawTarget = child.attrGet('href');
      if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(rawTarget)) {
        continue;
      }
      let target = rawTarget.split(/[?#]/, 1)[0] ?? '';
      try {
        target = decodeURIComponent(target);
      } catch {
        continue;
      }
      if (!target.endsWith('.md')) continue;
      const sourceDirectory = posix.dirname(`${currentId}.md`);
      const normalized = posix.normalize(
        target.startsWith('/') ? target.slice(1) : posix.join(sourceDirectory, target)
      );
      if (normalized.startsWith('../')) continue;
      const targetId = normalized.replace(/\.md$/, '');
      if (targetId !== currentId && conceptIds.has(targetId)) links.add(targetId);
    }
  }
  return [...links].sort(compareStrings);
}

/** Analyze semantic concept links as directed edges and deterministic quality metrics. */
export function analyzeWikiConceptGraph(
  concepts: ReadonlyArray<Pick<WikiSiteGraphConcept, 'id' | 'links'>>
): WikiConceptGraphAnalysis {
  const nodeIds = new Set(concepts.map((concept) => concept.id));
  const edgeKeys = new Set<string>();
  const edges: WikiConceptGraphEdge[] = [];
  for (const concept of concepts) {
    for (const target of concept.links) {
      if (target === concept.id || !nodeIds.has(target)) continue;
      const key = `${concept.id}\0${target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: concept.id, target });
    }
  }
  edges.sort(
    (left, right) =>
      compareStrings(left.source, right.source) || compareStrings(left.target, right.target)
  );

  const neighbors = new Map([...nodeIds].map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }
  const orphanIds = [...nodeIds].filter((id) => neighbors.get(id)?.size === 0).sort(compareStrings);
  const weaklyConnectedIds = [...nodeIds]
    .filter((id) => neighbors.get(id)?.size === 1)
    .sort(compareStrings);

  return {
    edges,
    metrics: {
      directedEdgeCount: edges.length,
      nodeCount: nodeIds.size,
      orphanConceptCount: orphanIds.length,
      weaklyConnectedConceptCount: weaklyConnectedIds.length,
    },
    orphanIds,
    weaklyConnectedIds,
  };
}

export function createWikiSiteGraphHtml(
  concepts: WikiSiteGraphConcept[],
  options: WikiSiteGraphOptions
): string {
  const types = [...new Set(concepts.map((concept) => concept.type))].sort(compareStrings);
  const colors = new Map(
    types.map((type, index) => [type, TYPE_COLORS[index % TYPE_COLORS.length]])
  );
  const nodes: GraphNode[] = concepts.map((concept) => ({
    ...concept,
    color: colors.get(concept.type) ?? TYPE_COLORS[0],
    href: `${options.base}${encodeWikiSiteConceptId(concept.id)}.html`,
  }));
  const analysis = analyzeWikiConceptGraph(nodes);
  const edges = analysis.edges;
  const graphJson = JSON.stringify({ nodes, edges, types, metrics: analysis.metrics })
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const fallbackLinks = nodes
    .map(
      (node) =>
        `<li><a href="${escapeHtml(node.href)}">${escapeHtml(node.title)}</a> <span>${escapeHtml(node.type)}</span></li>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Concept graph | ${escapeHtml(options.siteTitle)}</title>
  <style>
    :root { color-scheme: dark; --ink: #edf0ff; --muted: #aeb8d2; --panel: #171e30; --line: #35405c; --brand: #91a3ff; --accent: #f28b6d; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: #0d1321; font: 15px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    a { color: inherit; }
    .topbar { display: flex; gap: 1rem; align-items: center; min-height: 64px; padding: .75rem 1.25rem; border-bottom: 1px solid var(--line); background: rgba(13, 19, 33, .94); }
    .brand { margin-right: auto; font-weight: 800; text-decoration: none; letter-spacing: -.02em; }
    .topbar a:not(.brand) { color: var(--muted); font-size: .86rem; font-weight: 700; text-decoration: none; }
    .layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); min-height: calc(100vh - 64px); }
    .panel { z-index: 2; padding: 1.25rem; border-right: 1px solid var(--line); background: var(--panel); }
    .eyebrow { margin: 0 0 .35rem; color: var(--accent); font: 700 .7rem/1.2 ui-monospace, monospace; letter-spacing: .13em; }
    h1 { margin: 0; font-size: 1.85rem; line-height: 1.05; letter-spacing: -.04em; }
    .intro { margin: .8rem 0 1.1rem; color: var(--muted); font-size: .88rem; }
    label { display: block; margin: 1rem 0 .35rem; color: var(--muted); font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    input { width: 100%; padding: .65rem .7rem; border: 1px solid var(--line); border-radius: 3px; color: var(--ink); background: #0e1525; font: inherit; }
    input:focus { outline: 2px solid var(--brand); outline-offset: 1px; }
    .filters { display: flex; flex-wrap: wrap; gap: .4rem; }
    .filter { padding: .3rem .5rem; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: transparent; cursor: pointer; font: 700 .72rem/1.2 ui-monospace, monospace; }
    .filter[aria-pressed="true"] { border-color: var(--filter-color); color: #0d1321; background: var(--filter-color); }
    .stats { margin: 1rem 0; padding: .7rem 0; border-block: 1px solid var(--line); color: var(--muted); font: .75rem/1.5 ui-monospace, monospace; }
    .detail { min-height: 10rem; }
    .detail h2 { margin: 0 0 .35rem; font-size: 1.05rem; }
    .detail p { margin: .35rem 0; color: var(--muted); font-size: .82rem; }
    .detail .type { display: inline-block; padding: .15rem .4rem; border: 1px solid currentcolor; border-radius: 999px; font: 700 .68rem ui-monospace, monospace; }
    .detail a { display: inline-block; margin-top: .6rem; color: var(--brand); font-weight: 800; text-decoration: none; }
    .neighbor-group h3 { margin: .8rem 0 0; color: var(--muted); font: 800 .68rem/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .neighbors { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .55rem; }
    .neighbors button { padding: .2rem .4rem; border: 1px solid var(--line); color: var(--muted); background: transparent; cursor: pointer; font-size: .7rem; }
    .stage { position: relative; min-width: 0; overflow: hidden; background: radial-gradient(circle at 50% 45%, #182441 0, #0d1321 58%); }
    svg { display: block; width: 100%; height: calc(100vh - 64px); min-height: 620px; touch-action: none; }
    .edge { stroke: #44506e; stroke-width: 1.1; opacity: .6; }
    .edge.active { stroke: var(--brand); stroke-width: 2; opacity: 1; }
    .node { cursor: grab; }
    .node:active { cursor: grabbing; }
    .node circle { stroke: #0d1321; stroke-width: 3; transition: r .15s, opacity .15s; }
    .node text { fill: var(--ink); font-size: 11px; font-weight: 750; paint-order: stroke; stroke: #0d1321; stroke-width: 4px; stroke-linejoin: round; }
    .node.dim { opacity: .18; }
    .node.selected circle { r: 13; stroke: #fff; }
    .hint { position: absolute; right: 1rem; bottom: 1rem; color: var(--muted); font: .7rem ui-monospace, monospace; }
    noscript { display: block; padding: 2rem; }
    noscript span { color: var(--muted); }
    @media (max-width: 760px) {
      .topbar { min-height: 56px; padding: .65rem 1rem; }
      .topbar a:not(.brand) { display: none; }
      .layout { grid-template-columns: 1fr; }
      .panel { border-right: 0; border-bottom: 1px solid var(--line); }
      .intro { max-width: 42rem; }
      .detail { min-height: 0; }
      .stage { overflow-x: auto; }
      svg { width: 760px; max-width: none; height: 532px; min-height: 532px; touch-action: pan-x pan-y; }
      .hint { display: none; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="${escapeHtml(options.base)}">${escapeHtml(options.siteTitle)}</a>
    <a href="${escapeHtml(options.base)}">Concepts</a>
    <a href="${escapeHtml(`${options.base}okf/index.md`)}">Raw OKF</a>
  </header>
  <main class="layout">
    <aside class="panel">
      <p class="eyebrow">OKF RELATIONSHIP VIEW</p>
      <h1>Concept graph</h1>
      <p class="intro">Follow the internal links that connect architecture, workflows, integrations, and operations.</p>
      <label for="search">Find a concept</label>
      <input id="search" type="search" placeholder="Search titles and descriptions" autocomplete="off">
      <label>Concept types</label>
      <div id="filters" class="filters"></div>
      <div id="stats" class="stats" aria-live="polite"></div>
      <section id="detail" class="detail" aria-live="polite"><p>Select a node to inspect its direct relationships.</p></section>
    </aside>
    <section class="stage" aria-label="Interactive concept relationship graph">
      <svg id="graph" viewBox="0 0 1000 700" role="img" aria-labelledby="graph-title graph-description">
        <title id="graph-title">${escapeHtml(options.siteTitle)} concept relationship graph</title>
        <desc id="graph-description">Concept nodes connected by directed internal Markdown links. Arrowheads point from the linking concept to its target. Select a node for incoming and outgoing details.</desc>
        <defs><marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"></path></marker></defs>
        <g id="edges"></g>
        <g id="nodes"></g>
      </svg>
      <p class="hint">Drag to rearrange / Space to inspect / Enter to open</p>
    </section>
  </main>
  <noscript><h1>Concepts</h1><ul>${fallbackLinks}</ul></noscript>
  <script id="graph-data" type="application/json">${graphJson}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById('graph-data').textContent);
      const svg = document.getElementById('graph');
      const stage = svg.parentElement;
      const edgesLayer = document.getElementById('edges');
      const nodesLayer = document.getElementById('nodes');
      const search = document.getElementById('search');
      const filters = document.getElementById('filters');
      const stats = document.getElementById('stats');
      const detail = document.getElementById('detail');
      const nodeById = new Map(data.nodes.map((node, index) => {
        const angle = (index / Math.max(data.nodes.length, 1)) * Math.PI * 2;
        return [node.id, Object.assign(node, { x: 500 + Math.cos(angle) * 230, y: 350 + Math.sin(angle) * 230, vx: 0, vy: 0 })];
      }));
      const activeTypes = new Set(data.types);
      const edgeElements = [];
      const nodeElements = new Map();
      const outgoingById = new Map(data.nodes.map((node) => [node.id, new Set()]));
      const incomingById = new Map(data.nodes.map((node) => [node.id, new Set()]));
      for (const edge of data.edges) {
        outgoingById.get(edge.source).add(edge.target);
        incomingById.get(edge.target).add(edge.source);
      }
      let selectedId = '';
      let dragged = null;
      let ticks = 0;
      const simulationTickLimit = Math.max(40, Math.min(320, Math.ceil(32000 / Math.max(data.nodes.length, 1))));
      const repulsionStride = Math.max(1, Math.ceil(data.nodes.length / 180));

      function svgElement(name, attributes) {
        const element = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
        return element;
      }

      for (const edge of data.edges) {
        const line = svgElement('line', { class: 'edge', 'marker-end': 'url(#arrowhead)' });
        edgesLayer.append(line);
        edgeElements.push({ edge, line });
      }

      for (const [index, node] of data.nodes.entries()) {
        const outgoingCount = outgoingById.get(node.id).size;
        const incomingCount = incomingById.get(node.id).size;
        const group = svgElement('g', { class: 'node', tabindex: '0', role: 'link', 'aria-label': node.title + ', ' + node.type + ', ' + outgoingCount + ' outgoing links, ' + incomingCount + ' incoming links' });
        const circle = svgElement('circle', { r: 10, fill: node.color });
        const text = svgElement('text', { x: 15, y: index % 2 ? 17 : -10 });
        text.textContent = node.title;
        group.append(circle, text);
        group.addEventListener('click', () => selectNode(node.id));
        group.addEventListener('dblclick', () => { location.href = node.href; });
        group.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') location.href = node.href;
          if (event.key === ' ') { event.preventDefault(); selectNode(node.id); }
        });
        group.addEventListener('pointerdown', (event) => {
          dragged = node;
          group.setPointerCapture(event.pointerId);
        });
        group.addEventListener('pointermove', (event) => {
          if (dragged !== node) return;
          const point = svg.createSVGPoint();
          point.x = event.clientX;
          point.y = event.clientY;
          const transformed = point.matrixTransform(svg.getScreenCTM().inverse());
          node.x = transformed.x;
          node.y = transformed.y;
          node.vx = 0;
          node.vy = 0;
          render();
        });
        group.addEventListener('pointerup', () => { dragged = null; });
        nodesLayer.append(group);
        nodeElements.set(node.id, group);
      }

      for (const type of data.types) {
        const sample = data.nodes.find((node) => node.type === type);
        const button = document.createElement('button');
        button.className = 'filter';
        button.type = 'button';
        button.textContent = type;
        button.setAttribute('aria-pressed', 'true');
        button.style.setProperty('--filter-color', sample ? sample.color : '#91a3ff');
        button.addEventListener('click', () => {
          if (activeTypes.has(type)) activeTypes.delete(type); else activeTypes.add(type);
          button.setAttribute('aria-pressed', String(activeTypes.has(type)));
          applyFilters();
        });
        filters.append(button);
      }

      function visible(node) {
        const query = search.value.trim().toLowerCase();
        return activeTypes.has(node.type) && (!query || (node.title + ' ' + node.description + ' ' + node.type).toLowerCase().includes(query));
      }

      function applyFilters() {
        let visibleNodes = 0;
        for (const node of data.nodes) {
          const show = visible(node);
          nodeElements.get(node.id).classList.toggle('dim', !show);
          if (show) visibleNodes += 1;
        }
        const visibleEdges = data.edges.filter((edge) => visible(nodeById.get(edge.source)) && visible(nodeById.get(edge.target))).length;
        stats.textContent = visibleNodes + ' matching concepts / ' + visibleEdges + ' matching directed links / ' + data.metrics.orphanConceptCount + ' true orphans / ' + data.metrics.weaklyConnectedConceptCount + ' weak overall';
      }

      function selectNode(id) {
        selectedId = id;
        const node = nodeById.get(id);
        for (const [nodeId, element] of nodeElements) element.classList.toggle('selected', nodeId === id);
        for (const item of edgeElements) item.line.classList.toggle('active', item.edge.source === id || item.edge.target === id);
        detail.replaceChildren();
        const title = document.createElement('h2');
        title.textContent = node.title;
        const type = document.createElement('span');
        type.className = 'type';
        type.style.color = node.color;
        type.textContent = node.type;
        const description = document.createElement('p');
        description.textContent = node.description;
        const open = document.createElement('a');
        open.href = node.href;
        open.textContent = 'Open concept ->';
        detail.append(title, type, description, open);
        appendNeighborGroup('Links to', outgoingById.get(id));
        appendNeighborGroup('Linked from', incomingById.get(id));

        function appendNeighborGroup(label, neighborIds) {
          if (!neighborIds.size) return;
          const group = document.createElement('section');
          group.className = 'neighbor-group';
          const heading = document.createElement('h3');
          heading.textContent = label;
          const related = document.createElement('div');
          related.className = 'neighbors';
          const sortedIds = [...neighborIds].sort((left, right) => nodeById.get(left).title.localeCompare(nodeById.get(right).title));
          for (const relatedId of sortedIds) {
            const neighbor = nodeById.get(relatedId);
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = neighbor.title;
            button.addEventListener('click', () => selectNode(relatedId));
            related.append(button);
          }
          group.append(heading, related);
          detail.append(group);
        }
      }

      function simulate() {
        if (ticks < simulationTickLimit && !dragged) {
          for (let i = 0; i < data.nodes.length; i += 1) {
            const left = data.nodes[i];
            for (let j = i + 1; j < data.nodes.length; j += repulsionStride) {
              const right = data.nodes[j];
              const dx = right.x - left.x || .1;
              const dy = right.y - left.y || .1;
              const distance = Math.max(Math.hypot(dx, dy), 20);
              const distanceSquared = Math.max(dx * dx + dy * dy, 400);
              const force = 2200 / distanceSquared;
              const forceX = (dx / distance) * force;
              const forceY = (dy / distance) * force;
              left.vx -= forceX;
              left.vy -= forceY;
              right.vx += forceX;
              right.vy += forceY;
            }
          }
          for (const edge of data.edges) {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const distance = Math.max(Math.hypot(dx, dy), 1);
            const force = (distance - 210) * .0015;
            const forceX = (dx / distance) * force;
            const forceY = (dy / distance) * force;
            source.vx += forceX;
            source.vy += forceY;
            target.vx -= forceX;
            target.vy -= forceY;
          }
          for (const node of data.nodes) {
            node.vx += (500 - node.x) * .0008;
            node.vy += (350 - node.y) * .0008;
            node.vx *= .89;
            node.vy *= .89;
            node.x = Math.max(45, Math.min(940, node.x + node.vx));
            node.y = Math.max(35, Math.min(665, node.y + node.vy));
          }
          ticks += 1;
        }
        render();
        requestAnimationFrame(simulate);
      }

      function render() {
        for (const item of edgeElements) {
          const source = nodeById.get(item.edge.source);
          const target = nodeById.get(item.edge.target);
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const distance = Math.max(Math.hypot(dx, dy), 1);
          const unitX = dx / distance;
          const unitY = dy / distance;
          item.line.setAttribute('x1', source.x + unitX * 12);
          item.line.setAttribute('y1', source.y + unitY * 12);
          item.line.setAttribute('x2', target.x - unitX * 16);
          item.line.setAttribute('y2', target.y - unitY * 16);
        }
        for (const node of data.nodes) {
          const element = nodeElements.get(node.id);
          const label = element.querySelector('text');
          const alignLeft = node.x > 800;
          label.setAttribute('x', alignLeft ? '-15' : '15');
          label.setAttribute('text-anchor', alignLeft ? 'end' : 'start');
          element.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
        }
      }

      search.addEventListener('input', applyFilters);
      applyFilters();
      if (data.nodes[0]) selectNode(data.nodes[0].id);
      if (matchMedia('(max-width: 760px)').matches) {
        requestAnimationFrame(() => { stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2; });
      }
      simulate();
    })();
  </script>
</body>
</html>
`;
}

export function encodeWikiSiteConceptId(id: string): string {
  return id
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
