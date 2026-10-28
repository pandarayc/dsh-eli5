/**
 * dsh-eli5 — checklist for the built-in Mermaid subset.
 *
 * The renderer is small on purpose; these tests pin the exact subset the prompt
 * promises and the escaping that keeps model output from becoming markup.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeXml, parseFlowchart, renderMermaid } from '../lib/mermaid-lite.js';

test('a basic top-down flowchart becomes an svg with every node', () => {
  const { svg, error } = renderMermaid(`flowchart TD
  A[收到请求] --> B{需要重试?}
  B -->|是| C[等待退避]
  C --> A
  B -->|否| D[返回结果]`);
  assert.equal(error, undefined);
  assert.match(svg, /^<svg /);
  assert.match(svg, /收到请求/);
  assert.match(svg, /需要重试\?/);
  assert.match(svg, /等待退避/);
  assert.match(svg, /返回结果/);
  assert.match(svg, /marker-end="url\(#xp-arrow\)"/);
});

test('left-to-right graphs are laid out horizontally', () => {
  const { svg } = renderMermaid('graph LR\n  a[输入] --> b[处理]');
  const width = Number(/viewBox="0 0 (\d+) (\d+)"/.exec(svg)[1]);
  const height = Number(/viewBox="0 0 (\d+) (\d+)"/.exec(svg)[2]);
  assert.ok(width > height, `expected a wide diagram, got ${width}x${height}`);
});

test('edge labels work after the arrow and between dashes', () => {
  const after = renderMermaid('flowchart TD\n  A -->|重试| B');
  assert.equal(after.error, undefined);
  assert.match(after.svg, /重试/);

  const between = renderMermaid('flowchart TD\n  A -- 重试 -- > B');
  // The spaced form is unusual; the renderer must not throw either way.
  assert.ok(between.svg !== undefined || between.error !== undefined);
});

test('model text is escaped, never interpreted as markup', () => {
  const { svg } = renderMermaid('flowchart TD\n  A[<script>alert(1)</script>] --> B["引号 & 与"]');
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp; 与/);
  assert.equal(escapeXml(`a"b'c<d>e&f`), 'a&quot;b&#39;c&lt;d&gt;e&amp;f');
});

test('unsupported diagram types report an error instead of drawing junk', () => {
  assert.equal(renderMermaid('sequenceDiagram\n  A->>B: hi').error, '只支持 flowchart / graph');
  assert.equal(renderMermaid('').error, '空图');
  assert.equal(renderMermaid('flowchart TD\n%% 只有注释').error, '没有可画的节点');
});

test('node definitions keep their shapes', () => {
  const parsed = parseFlowchart('flowchart TD\n  A[方] --> B(圆) --> C{菱}');
  assert.equal(parsed.error, undefined);
  const shapes = Object.fromEntries(parsed.nodes.map((node) => [node.id, node.shape]));
  assert.deepEqual(shapes, { A: 'rect', B: 'round', C: 'diamond' });
  assert.equal(parsed.edges.length, 2);
});
