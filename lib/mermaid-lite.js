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

/** Punctuation that must not be left alone on a new line (`?` after a word). */
const GLUE = /^[?？!！。，,、：:；;）)\]】」』…%]$/;

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
    // Closing punctuation rides with the word before it, even at the margin.
    if (used + width > WRAP_AT && line !== '' && !GLUE.test(token)) {
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
 * DFS back edges. They are kept out of the layering pass so a cycle still lays
 * out as a flow instead of collapsing into one row.
 */
function backEdges(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  edges.forEach((edge, index) => {
    const list = outgoing.get(edge.from);
    if (list !== undefined && outgoing.has(edge.to)) list.push(index);
  });
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const index of outgoing.get(id) ?? []) {
      const target = edges[index].to;
      const mark = state.get(target) ?? 0;
      if (mark === 1) back.add(index);
      else if (mark === 0) visit(target);
    }
    state.set(id, 2);
  };
  for (const node of nodes) if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  return back;
}

/**
 * Assign each node a row index: longest path from a source, over the acyclic
 * part of the graph.
 *
 * @param nodes - parsed nodes.
 * @param edges - parsed edges.
 * @param back - indexes of edges excluded from the flow.
 * @returns map of id → row index.
 */
function layerNodes(nodes, edges, back) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge, index) => {
    if (back.has(index) || !outgoing.has(edge.from) || !outgoing.has(edge.to)) return;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  });
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    for (const next of outgoing.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  return layer;
}

/** Measure one node's box from its wrapped label and shape. */
function measureNode(node) {
  node.lines = wrapLabel(node.label);
  const textWidth = Math.max(...node.lines.map(lineWidth));
  if (node.shape === 'diamond') {
    // Text only fits in the middle band of a diamond, so it needs twice the width.
    node.width = Math.max(100, Math.round(textWidth * 2 + 26));
    node.height = Math.max(56, node.lines.length * 17 + 32);
  } else {
    node.width = Math.max(64, Math.round(textWidth + 26));
    node.height = Math.max(36, 14 + node.lines.length * 17);
  }
}

/** Count edge crossings between every pair of adjacent rows. */
function countCrossings(layers, edges, layerOf, position) {
  let total = 0;
  for (let index = 0; index + 1 < layers.length; index += 1) {
    const pairs = [];
    for (const edge of edges) {
      if ((layerOf.get(edge.from) ?? 0) !== index) continue;
      if ((layerOf.get(edge.to) ?? 0) !== index + 1) continue;
      const from = position.get(edge.from);
      const to = position.get(edge.to);
      if (from !== undefined && to !== undefined) pairs.push([from, to]);
    }
    for (let left = 0; left < pairs.length; left += 1) {
      for (let right = left + 1; right < pairs.length; right += 1) {
        const dFrom = pairs[left][0] - pairs[right][0];
        const dTo = pairs[left][1] - pairs[right][1];
        if (dFrom * dTo < 0) total += 1;
      }
    }
  }
  return total;
}

/**
 * Reduce edge crossings with a few barycenter sweeps.
 *
 * Small graphs do not need anything cleverer than this: one or two sweeps
 * already put sibling branches in reading order, and the pass is skipped
 * entirely when the initial order has no crossings.
 */
function orderLayers(layers, edges, layerOf) {
  const position = new Map();
  const sync = () => {
    layers.forEach((row) => row.forEach((node, index) => position.set(node.id, index)));
  };
  sync();
  const predecessors = new Map();
  const successors = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const edge of edges) {
    if ((layerOf.get(edge.to) ?? 0) !== (layerOf.get(edge.from) ?? 0) + 1) continue;
    push(predecessors, edge.to, edge.from);
    push(successors, edge.from, edge.to);
  }
  const barycenter = (node, neighbours) => {
    const linked = neighbours.get(node.id) ?? [];
    if (linked.length === 0) return position.get(node.id) ?? 0;
    let sum = 0;
    for (const id of linked) sum += position.get(id) ?? 0;
    return sum / linked.length;
  };
  const snapshot = () => layers.map((row) => row.slice());
  const restore = (saved) => {
    saved.forEach((row, index) => {
      layers[index] = row.slice();
    });
    sync();
  };

  let best = snapshot();
  let bestScore = countCrossings(layers, edges, layerOf, position);
  for (let sweep = 0; sweep < 4 && bestScore > 0; sweep += 1) {
    const down = sweep % 2 === 0;
    const order = [...layers.keys()];
    if (down) order.shift();
    else order.pop();
    if (!down) order.reverse();
    for (const index of order) {
      const neighbours = down ? predecessors : successors;
      layers[index].sort((left, right) => barycenter(left, neighbours) - barycenter(right, neighbours));
      sync();
    }
    const score = countCrossings(layers, edges, layerOf, position);
    if (score < bestScore) {
      bestScore = score;
      best = snapshot();
    } else {
      restore(best);
    }
  }
  restore(best);
}

/** Cubic Bézier value at `t`. */
function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Point on a cubic curve at `t`. */
function curvePoint(curve, t) {
  return {
    x: cubicAt(curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x, t),
    y: cubicAt(curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y, t),
  };
}

/** Path data for a cubic curve. */
function curvePath(curve) {
  const { p0, p1, p2, p3 } = curve;
  return `M ${Math.round(p0.x)} ${Math.round(p0.y)} C ${Math.round(p1.x)} ${Math.round(p1.y)} ${Math.round(p2.x)} ${Math.round(p2.y)} ${Math.round(p3.x)} ${Math.round(p3.y)}`;
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

/** Border point of `node` facing `other`, following the reading direction. */
function anchorOf(node, other, vertical) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const ox = other.x + other.width / 2;
  const oy = other.y + other.height / 2;
  if (vertical) return { x: cx, y: oy > cy ? node.y + node.height : node.y };
  return { x: ox > cx ? node.x + node.width : node.x, y: cy };
}

/**
 * Lay out and render a parsed flowchart as standalone SVG markup.
 *
 * The layout is a three-step pipeline: rows from longest-path layering (with
 * back edges removed so cycles still flow), in-row order from barycenter
 * sweeps, then coordinates with a fixed gap large enough for edge labels. Edges
 * are cubic curves between facing borders; an edge that points backwards is
 * routed around the outside so it does not cut through the nodes it loops over.
 *
 * @param parsed - result of {@link parseFlowchart}.
 * @returns SVG string.
 */
export function renderSvg(parsed) {
  const { direction, nodes, edges } = parsed;
  const vertical = direction === 'TD' || direction === 'BT';
  const reversed = direction === 'BT' || direction === 'RL';

  for (const node of nodes) measureNode(node);

  const back = backEdges(nodes, edges);
  const layerOf = layerNodes(nodes, edges, back);
  const lastLayer = Math.max(0, ...nodes.map((node) => layerOf.get(node.id) ?? 0));
  const layers = Array.from({ length: lastLayer + 1 }, () => []);
  for (const node of nodes) layers[layerOf.get(node.id) ?? 0].push(node);
  orderLayers(layers, edges, layerOf);

  // `BT` / `RL` draw the same layering from the other end.
  const rowOf = new Map();
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    rowOf.set(node.id, reversed ? lastLayer - layer : layer);
  }
  const rows = Array.from({ length: lastLayer + 1 }, (_, row) => layers[reversed ? lastLayer - row : row]);

  const padding = 18;
  const crossGap = 30;
  const mainGap = edges.some((edge) => edge.label !== '') ? 74 : 52;

  if (vertical) {
    const rowHeights = rows.map((row) => Math.max(0, ...row.map((node) => node.height)));
    const rowWidths = rows.map((row) => row.reduce((sum, node) => sum + node.width, 0) + crossGap * (row.length - 1));
    const widest = Math.max(...rowWidths);
    let y = padding;
    rows.forEach((row, index) => {
      let x = padding + (widest - rowWidths[index]) / 2;
      for (const node of row) {
        node.x = Math.round(x);
        node.y = Math.round(y + (rowHeights[index] - node.height) / 2);
        x += node.width + crossGap;
      }
      y += rowHeights[index] + mainGap;
    });
  } else {
    const columnWidths = rows.map((row) => Math.max(0, ...row.map((node) => node.width)));
    const columnHeights = rows.map(
      (row) => row.reduce((sum, node) => sum + node.height, 0) + crossGap * (row.length - 1),
    );
    const tallest = Math.max(...columnHeights);
    let x = padding;
    rows.forEach((row, index) => {
      let y = padding + (tallest - columnHeights[index]) / 2;
      for (const node of row) {
        node.x = Math.round(x + (columnWidths[index] - node.width) / 2);
        node.y = Math.round(y);
        y += node.height + crossGap;
      }
      x += columnWidths[index] + mainGap;
    });
  }

  // An edge that skips a row cannot run through the node in between, so it is
  // routed around the outside: right of the rows when reading top-down, above
  // them when reading left-to-right.
  const longEdges = new Set();
  edges.forEach((edge, index) => {
    if (back.has(index) || edge.from === edge.to) return;
    if ((layerOf.get(edge.to) ?? 0) - (layerOf.get(edge.from) ?? 0) >= 2) longEdges.add(index);
  });
  const detour = longEdges.size > 0 && !vertical ? 48 : 0;
  if (detour > 0) for (const node of nodes) node.y += detour;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parallelTotals = new Map();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    parallelTotals.set(key, (parallelTotals.get(key) ?? 0) + 1);
  }
  const parallelSeen = new Map();

  const lines = [];
  const labels = [];
  let maxX = Math.max(...nodes.map((node) => node.x + node.width)) + padding;
  let maxY = Math.max(...nodes.map((node) => node.y + node.height)) + padding;

  edges.forEach((edge, index) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (from === undefined || to === undefined) return;
    const key = `${edge.from}->${edge.to}`;
    const slot = parallelSeen.get(key) ?? 0;
    parallelSeen.set(key, slot + 1);
    const offset = (slot - ((parallelTotals.get(key) ?? 1) - 1) / 2) * 14;
    const isBack = back.has(index) || (layerOf.get(edge.to) ?? 0) <= (layerOf.get(edge.from) ?? 0);
    let curve;

    if (from === to) {
      const reach = 32 + slot * 16;
      if (vertical) {
        const x = from.x + from.width;
        const cy = from.y + from.height / 2;
        curve = {
          p0: { x, y: cy - 9 },
          p1: { x: x + reach, y: cy - 26 },
          p2: { x: x + reach, y: cy + 26 },
          p3: { x, y: cy + 9 },
        };
        maxX = Math.max(maxX, x + reach + 8);
      } else {
        const y = from.y + from.height;
        const cx = from.x + from.width / 2;
        curve = {
          p0: { x: cx - 9, y },
          p1: { x: cx - 26, y: y + reach },
          p2: { x: cx + 26, y: y + reach },
          p3: { x: cx + 9, y },
        };
        maxY = Math.max(maxY, y + reach + 8);
      }
    } else if (longEdges.has(index)) {
      const reach = 24 + slot * 14;
      if (vertical) {
        const start = { x: from.x + from.width, y: from.y + from.height / 2 };
        const end = { x: to.x + to.width, y: to.y + to.height / 2 };
        const bulge = Math.max(start.x, end.x) + reach;
        curve = { p0: start, p1: { x: bulge, y: start.y }, p2: { x: bulge, y: end.y }, p3: end };
        maxX = Math.max(maxX, bulge + 8);
      } else {
        const start = { x: from.x + from.width / 2, y: from.y };
        const end = { x: to.x + to.width / 2, y: to.y };
        const bulge = Math.min(start.y, end.y) - reach;
        curve = { p0: start, p1: { x: start.x, y: bulge }, p2: { x: end.x, y: bulge }, p3: end };
        maxY = Math.max(maxY, Math.max(start.y, end.y));
      }
    } else if (isBack) {
      if (vertical) {
        const start = { x: from.x + from.width, y: from.y + from.height / 2 };
        const end = { x: to.x + to.width, y: to.y + to.height / 2 };
        const bulge = Math.max(start.x, end.x) + 34 + Math.abs(offset);
        curve = {
          p0: start,
          p1: { x: bulge, y: start.y },
          p2: { x: bulge, y: end.y },
          p3: end,
        };
        maxX = Math.max(maxX, bulge + 10);
      } else {
        const start = { x: from.x + from.width / 2, y: from.y + from.height };
        const end = { x: to.x + to.width / 2, y: to.y + to.height };
        const bulge = Math.max(start.y, end.y) + 34 + Math.abs(offset);
        curve = {
          p0: start,
          p1: { x: start.x, y: bulge },
          p2: { x: end.x, y: bulge },
          p3: end,
        };
        maxY = Math.max(maxY, bulge + 10);
      }
    } else {
      const start = anchorOf(from, to, vertical);
      const end = anchorOf(to, from, vertical);
      if (vertical) {
        const dy = end.y - start.y;
        curve = {
          p0: start,
          p1: { x: start.x + offset, y: start.y + dy * 0.45 },
          p2: { x: end.x + offset, y: end.y - dy * 0.45 },
          p3: end,
        };
      } else {
        const dx = end.x - start.x;
        curve = {
          p0: start,
          p1: { x: start.x + dx * 0.45, y: start.y + offset },
          p2: { x: end.x - dx * 0.45, y: end.y + offset },
          p3: end,
        };
      }
    }

    const dashed = isBack && from !== to ? ' stroke-dasharray="5 4"' : '';
    lines.push(
      `<path d="${curvePath(curve)}" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.4"${dashed} marker-end="url(#xp-arrow)"/>`,
    );

    if (edge.label !== '') {
      const text = edge.label.length > 16 ? `${edge.label.slice(0, 16)}…` : edge.label;
      const labelWidth = Math.round(lineWidth(text)) + 8;
      const fits = (point) =>
        !nodes.some(
          (node) =>
            node !== from &&
            node !== to &&
            Math.abs(point.x - (node.x + node.width / 2)) < node.width / 2 + labelWidth / 2 &&
            Math.abs(point.y - (node.y + node.height / 2)) < node.height / 2 + 9,
        );
      let point = curvePoint(curve, 0.5);
      for (const t of [0.5, 0.42, 0.58, 0.34, 0.66]) {
        const candidate = curvePoint(curve, t);
        if (fits(candidate)) {
          point = candidate;
          break;
        }
      }
      labels.push(
        `<rect class="xp-edge-label-bg" x="${Math.round(point.x - labelWidth / 2)}" y="${Math.round(point.y - 9)}" width="${labelWidth}" height="18" rx="4"/>`,
        `<text x="${Math.round(point.x)}" y="${Math.round(point.y + 4)}" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.75">${escapeXml(text)}</text>`,
      );
    }
  });

  const width = Math.ceil(maxX);
  const height = Math.ceil(maxY);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    '<defs><marker id="xp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>',
    ...lines,
    ...labels,
  ];

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
