/**
 * End-to-end check that a Mermaid answer is actually drawn in the panel.
 *
 * Drives Windows headless Chrome over CDP (127.0.0.1:9222 is mirrored into
 * WSL), asks the panel a question that should produce a flowchart, waits for the
 * SVG to replace the source block, and screenshots the result.
 *
 * Usage: node diagram-smoke.mjs <page-url> [shot-dir]
 */

const PAGE_URL = process.argv[2];
const SHOT_DIR = process.argv[3] ?? '/tmp/dshx';
if (!PAGE_URL) {
  console.error('usage: node diagram-smoke.mjs <page-url> [shot-dir]');
  process.exit(2);
}

const CDP = 'http://127.0.0.1:9222';

/** Create a fresh tab and return its CDP websocket URL. */
async function newTab(url) {
  const response = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`new tab failed: ${response.status}`);
  return response.json();
}

/** Minimal CDP client over the built-in WebSocket. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  socket.addEventListener('message', (message) => {
    const payload = JSON.parse(message.data);
    if (payload.id !== undefined) {
      const waiter = pending.get(payload.id);
      pending.delete(payload.id);
      if (waiter !== undefined) {
        if (payload.error) waiter.reject(new Error(payload.error.message));
        else waiter.resolve(payload.result);
      }
      return;
    }
    events.push(payload);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, close: () => socket.close() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tab = await newTab('about:blank');
  const cdp = connect(tab.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression).catch(() => false);
      if (value) return value;
      await sleep(400);
    }
    throw new Error(`timeout waiting for ${label}`);
  };

  await cdp.send('Page.navigate', { url: PAGE_URL });
  await waitFor('document.readyState === "complete"', 30_000, 'document ready');
  await waitFor('typeof window.__dshEli5 === "object"', 30_000, '__dshEli5');

  // The renderer is served by the host; prove the module loads in this origin.
  const moduleProbe = await evaluate(
    `(async () => { const m = await import('/eli5/mermaid-lite.js'); return typeof m.renderMermaid; })()`,
  );
  console.log('renderer import:', moduleProbe);

  // A model asked to explain does not always choose to draw; ask for the
  // diagram explicitly and retry a couple of times before calling it a failure.
  const question = process.env.DIAGRAM_QUESTION ?? '用一个流程图说明重试的退避过程';
  const context = process.env.DIAGRAM_CONTEXT ?? '我们在看 internal/worker/retry.go 里 RetryPolicy 的退避';
  let diagram = '';
  for (let attempt = 1; attempt <= 3 && diagram === ''; attempt += 1) {
    if (attempt > 1) {
      await evaluate('window.__dshEli5.close()');
      await sleep(500);
    }
    await evaluate(`window.__dshEli5.open(${JSON.stringify(question)}, ${JSON.stringify(context)})`);
    diagram = await waitFor(
      `(() => {
         const svg = document.querySelector('#dsh-eli5-panel .xp-diagram svg');
         if (svg === null) return '';
         return String(svg.querySelectorAll('path').length) + ' paths / ' + String(svg.querySelectorAll('text').length) + ' labels';
       })()`,
      120_000,
      'diagram svg',
    ).catch(() => '');
    console.log(`attempt ${attempt}: ${diagram === '' ? 'no diagram' : diagram}`);
  }
  if (diagram === '') throw new Error('the model did not produce a diagram in three attempts');
  console.log('diagram rendered:', diagram);

  await evaluate(
    `(() => { const el = document.querySelector('#dsh-eli5-panel .xp-diagram'); if (el) el.scrollIntoView({ block: 'center' }); })()`,
  );
  await sleep(400);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await (await import('node:fs/promises')).mkdir(SHOT_DIR, { recursive: true });
  await (await import('node:fs/promises')).writeFile(`${SHOT_DIR}/shot-diagram.png`, Buffer.from(data, 'base64'));
  console.log('screenshot:', `${SHOT_DIR}/shot-diagram.png`);

  // A cropped, 2x capture of just the panel — the image a README wants.
  const rect = await evaluate(
    `(() => { const r = document.querySelector('#dsh-eli5-panel').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`,
  );
  const cropped = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...rect, scale: 2 },
  });
  await (await import('node:fs/promises')).writeFile(`${SHOT_DIR}/shot-panel.png`, Buffer.from(cropped.data, 'base64'));
  console.log('panel crop:', `${SHOT_DIR}/shot-panel.png`);

  const problems = [];
  for (const event of cdp.events) {
    if (event.method === 'Runtime.exceptionThrown') problems.push(String(event.params.exceptionDetails.text));
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') problems.push(event.params.entry.text);
  }
  const relevant = problems.filter((line) => !/favicon|manifest\.webmanifest|401|Unauthorized|Failed to load resource/i.test(line));
  console.log(`page problems: ${relevant.length}`);
  for (const line of relevant.slice(0, 8)) console.log(line);
  cdp.close();
  process.exit(relevant.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
