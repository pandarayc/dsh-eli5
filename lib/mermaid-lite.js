/**
 * dsh-eli5 — minimal Mermaid flowchart renderer.
 *
 * The panel lets the model draw a small diagram when a flow or a structure is
 * easier to see than to read. Rendering is done here rather than by pulling in
 * Mermaid itself: this plugin ships no runtime dependencies, and a 3 MB diagram
 * library for "三五个方框加箭头" is the wrong trade. What the prompt asks for —
 * `flowchart TD` / `graph LR` with rectangle, rounded and diamond nodes and
 * labelled arrows — is what this module draws.
 *
 * Anything outside that subset is ignored (classDef, style, subgraph, linkStyle)
 * and anything unparseable returns `{error}` so the caller can fall back to a
 * plain code block instead of showing a broken picture.
 *
 * The output is a string built exclusively from escaped text, so the caller can
 * assign it to `innerHTML` without giving the model an HTML injection primitive.
 *
 * @module dsh-eli5/mermaid-lite
 */

/** Hard cap on nodes; beyond this the layout stops being readable. */
const MAX_NODES = 24;

/** Hard cap on edges. */
const MAX_EDGES = 40;

/** Characters per line inside a node label. */
const WRAP_AT = 12;

/** Lines kept per label before ellipsis. */
const MAX_LINES = 3;

/** Escape text for HTML/XML content and attributes. */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Split one label into display lines without cutting Latin words apart. */
function wrapLabel(label) {
  const text = label.trim();
  if (text === '') return [''];
  // CJK breaks anywhere; `RetryPolicy` and `n=0` must stay whole.
  const tokens = text.match(/[A-Za-z0-9_.-]+|\s+|./gu) ?? [];
  const lines = [];
  let line = '';
  let used = 0;
  for (const token of tokens) {
    const space = /^\s+$/.test(token);
    if (space && line === '') continue;
    const width = /^[A-Za-z0-9_.-]+$/.test(token) ? token.length : 1;
    if (used + width > WRAP_AT && line !== '') {
      lines.push(line.trimEnd());
      line = '';
      used = 0;
      if (space) continue;
    }
    line += space ? ' ' : token;
    used += width;
  }
  if (line !== '') lines.push(line.trimEnd());
  if (lines.length <= MAX_LINES) return lines;
  const kept = lines.slice(0, MAX_LINES);
  kept[MAX_LINES - 1] = `${kept[MAX_LINES - 1].slice(0, WRAP_AT - 1)}…`;
  return kept;
}

/** Approximate rendered width of one line, CJK wide characters count double. */
function lineWidth(line) {
  let width = 0;
  for (const char of line) width += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 13 : 7.2;
  return width;
}

/** Parse `id[text]`, `id(text)`, `id{text}`, `id((text))` into a node definition. */
function parseNodeToken(token) {
  const match = /^([A-Za-z0-9_.-]+)\s*(\(\(|\[|\(|\{)(.*?)(\)\)|\]|\)|\})$/s.exec(token.trim());
  if (match === null) return undefined;
  const [, id, open, rawLabel] = match;
  const shape = open === '((' ? 'round' : open === '(' ? 'round' : open === '{' ? 'diamond' : 'rect';
  const label = rawLabel.trim().replace(/^"|"$/g, '');
  return { id, label: label === '' ? id : label, shape };
}

/** Strip quotes and pipes from an edge label. */
function cleanEdgeLabel(text) {
  return text.trim().replace(/^"|"$/g, '').replace(/^\||\|$/g, '').trim();
}

/**
 * Parse the flowchart subset.
 *
 * @param source - diagram source without the ```mermaid fence.
 * @returns `{direction, nodes, edges}` or `{error}`.
 */
export function parseFlowchart(source) {
  const lines = String(source).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return { error: '空图' };
  const header = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i.exec(lines[0]);
  if (header === null) return { error: '只支持 flowchart / graph' };
  const direction = header[1].toUpperCase() === 'TB' ? 'TD' : header[1].toUpperCase();

  const nodes = new Map();
  const order = [];
  const edges = [];
  const ensure = (id, label, shape) => {
    if (!nodes.has(id)) {
      if (nodes.size >= MAX_NODES) return undefined;
      const node = { id, label: label ?? id, shape: shape ?? 'rect' };
      nodes.set(id, node);
      order.push(id);
      return node;
    }
    const node = nodes.get(id);
    if (label !== undefined) {
      node.label = label;
      node.shape = shape ?? node.shape;
    }
    return node;
  };

  for (const line of lines.slice(1)) {
    if (/^(subgraph|end\b|style\b|classDef\b|class\b|linkStyle\b|click\b|direction\b)/i.test(line)) continue;
    if (/^%%/.test(line)) continue;

    // Normalise the "label between dashes" form into the "label after arrow"
    // form, so chains and labels share one parser.
    const normalised = line.replace(/--\s+([^-|]+?)\s+-->/g, '-->|$1|');
    const parts = splitEdgeChain(normalised);
    if (parts.length > 1) {
      for (let index = 0; index < parts.length - 1; index += 1) {
        const left = ensure(...nodeParts(parts[index].raw));
        const right = ensure(...nodeParts(parts[index + 1].raw));
        if (left === undefined || right === undefined || edges.length >= MAX_EDGES) continue;
        edges.push({ from: left.id, to: right.id, label: cleanEdgeLabel(parts[index].label ?? '') });
      }
      continue;
    }

    const lone = nodeParts(line);
    if (lone[0] !== '') ensure(...lone);
  }

  if (nodes.size === 0) return { error: '没有可画的节点' };
  return { direction, nodes: order.map((id) => nodes.get(id)), edges };
}

/** Arrow spellings the subset understands, longest first so `-->` wins over `--`. */
const ARROW = /\s*(-->|==>|\.->|---|===|-\.-)\s*(?:\|([^|]*)\|)?\s*/g;

/**
 * Split one line into the nodes of an edge chain.
 *
 * `A[收到] -->|是| B{重试?} --> C` yields three parts, each carrying the arrow
 * label that follows it; a line without arrows yields one part.
 *
 * @param line - one source line.
 * @returns `[{raw, label}]`, left to right.
 */
export function splitEdgeChain(line) {
  const parts = [];
  let lastIndex = 0;
  ARROW.lastIndex = 0;
  let match;
  while ((match = ARROW.exec(line)) !== null) {
    if (match.index === ARROW.lastIndex) ARROW.lastIndex += 1;
    parts.push({ raw: line.slice(lastIndex, match.index).trim(), label: match[2] ?? '' });
    lastIndex = ARROW.lastIndex;
  }
  parts.push({ raw: line.slice(lastIndex).trim(), label: '' });
  return parts.filter((part, index) => part.raw !== '' || index < parts.length - 1);
}

/** Split a node reference into `[id, label, shape]` for `ensure`. */
function nodeParts(raw) {
  const text = raw.trim().replace(/^\((.*)\)$/s, '$1');
  const parsed = parseNodeToken(text);
  if (parsed === undefined) return [text, undefined, undefined];
  return [parsed.id, parsed.label, parsed.shape];
}

/**
 * Assign each node a layer (longest path from a source, cycle-safe).
 *
 * @param nodes - parsed nodes.
 * @param edges - parsed edges.
 * @returns map of id → layer index.
 */
function layerNodes(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift();
    for (const next of outgoing.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return layer;
}

/** Rounded rectangle path for a node shape. */
function shapePath(shape, x, y, width, height) {
  if (shape === 'diamond') {
    const cx = x + width / 2;
    const cy = y + height / 2;
    return `M ${cx} ${y} L ${x + width} ${cy} L ${cx} ${y + height} L ${x} ${cy} Z`;
  }
  const radius = shape === 'round' ? height / 2 : 8;
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M ${x + r} ${y}`,
    `H ${x + width - r}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `V ${y + height - r}`,
    `Q ${x + width} ${y + height} ${x + width - r} ${y + height}`,
    `H ${x + r}`,
    `Q ${x} ${y + height} ${x} ${y + height - r}`,
    `V ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/**
 * Lay out and render a parsed flowchart as standalone SVG markup.
 *
 * @param parsed - result of {@link parseFlowchart}.
 * @returns SVG string.
 */
export function renderSvg(parsed) {
  const { direction, nodes, edges } = parsed;
  const layer = layerNodes(nodes, edges);
  const byLayer = new Map();
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0;
    if (!byLayer.has(index)) byLayer.set(index, []);
    byLayer.get(index).push(node);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b).map((index) => byLayer.get(index));

  const gapMain = 52;
  const gapCross = 30;
  const padding = 16;

  // Measure every node first.
  for (const node of nodes) {
    node.lines = wrapLabel(node.label);
    node.width = Math.max(64, Math.round(Math.max(...node.lines.map(lineWidth)) + 26));
    node.height = Math.max(36, 14 + node.lines.length * 17);
  }

  const vertical = direction === 'TD' || direction === 'BT';
  const layerSize = (nodesInLayer) =>
    vertical
      ? { main: Math.max(...nodesInLayer.map((n) => n.height)), cross: nodesInLayer.reduce((sum, n) => sum + n.width, 0) + gapCross * (nodesInLayer.length - 1) }
      : { main: Math.max(...nodesInLayer.map((n) => n.width)), cross: nodesInLayer.reduce((sum, n) => sum + n.height, 0) + gapCross * (nodesInLayer.length - 1) };

  const sizes = layers.map(layerSize);
  const totalMain = sizes.reduce((sum, size) => sum + size.main, 0) + gapMain * (layers.length - 1);
  const totalCross = Math.max(...sizes.map((size) => size.cross));

  let mainCursor = padding;
  layers.forEach((nodesInLayer, index) => {
    const size = sizes[index];
    const centerMain = mainCursor + size.main / 2;
    let crossCursor = padding + (totalCross - size.cross) / 2;
    for (const node of nodesInLayer) {
      if (vertical) {
        node.y = Math.round(centerMain - node.height / 2);
        node.x = Math.round(crossCursor);
        crossCursor += node.width + gapCross;
      } else {
        node.x = Math.round(centerMain - node.width / 2);
        node.y = Math.round(crossCursor);
        crossCursor += node.height + gapCross;
      }
    }
    mainCursor += size.main + gapMain;
  });

  // `totalMain` runs along the reading direction: vertical for TD, horizontal
  // for LR. The canvas swaps accordingly.
  const width = Math.ceil((vertical ? totalCross : totalMain) + padding * 2);
  const height = Math.ceil((vertical ? totalMain : totalCross) + padding * 2);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    '<defs><marker id="xp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>',
  ];

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const start = anchorOf(from, to, vertical);
    const end = anchorOf(to, from, vertical);
    parts.push(
      `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.4" marker-end="url(#xp-arrow)"/>`,
    );
    if (edge.label !== '') {
      const mx = Math.round((start.x + end.x) / 2);
      const my = Math.round((start.y + end.y) / 2);
      const text = escapeXml(edge.label.length > 18 ? `${edge.label.slice(0, 18)}…` : edge.label);
      parts.push(
        `<rect class="xp-edge-label-bg" x="${mx - Math.round(lineWidth(text) / 2) - 4}" y="${my - 9}" width="${Math.round(lineWidth(text)) + 8}" height="18" rx="4"/>`,
        `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.75">${text}</text>`,
      );
    }
  }

  for (const node of nodes) {
    parts.push(
      `<path class="xp-node" d="${shapePath(node.shape, node.x, node.y, node.width, node.height)}" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4"/>`,
    );
    const lineHeight = 17;
    const startY = node.y + node.height / 2 - ((node.lines.length - 1) * lineHeight) / 2 + 4;
    node.lines.forEach((line, index) => {
      parts.push(
        `<text x="${Math.round(node.x + node.width / 2)}" y="${Math.round(startY + index * lineHeight)}" text-anchor="middle" font-size="12" fill="currentColor">${escapeXml(line)}</text>`,
      );
    });
  }

  parts.push('</svg>');
  return parts.join('');
}

/** Pick the border point of `node` facing `other`. */
function anchorOf(node, other, vertical) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const ox = other.x + other.width / 2;
  const oy = other.y + other.height / 2;
  if (vertical) {
    return { x: Math.round(cx), y: Math.round(oy > cy ? node.y + node.height : node.y) };
  }
  return { x: Math.round(ox > cx ? node.x + node.width : node.x), y: Math.round(cy) };
}

/**
 * Render Mermaid source to SVG markup.
 *
 * @param source - diagram source without fences.
 * @returns `{svg}` on success or `{error}` when the subset cannot draw it.
 */
export function renderMermaid(source) {
  const parsed = parseFlowchart(source);
  if (parsed.error !== undefined) return { error: parsed.error };
  try {
    return { svg: renderSvg(parsed) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
