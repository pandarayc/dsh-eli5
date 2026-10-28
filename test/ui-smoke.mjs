/**
 * End-to-end check of the dsh-eli5 client half against a live DSH web host.
 *
 * Drives Windows headless Chrome over CDP (127.0.0.1:9222 is mirrored into WSL):
 * opens the GUI, waits for the client bundle to register, exercises the panel
 * once through the debug hook and once through a real DOM selection, and saves
 * screenshots. Console errors and page exceptions are reported at the end.
 *
 * Usage: node ui-test.mjs <page-url>
 */

const PAGE_URL = process.argv[2];
if (!PAGE_URL) {
  console.error('usage: node ui-test.mjs <page-url>');
  process.exit(2);
}

const CDP = 'http://127.0.0.1:9222';

/** Create a fresh tab and return its CDP websocket URL. */
async function newTab(url) {
  const response = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`new tab failed: ${response.status} ${await response.text()}`);
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
      if (waiter === undefined) return;
      if (payload.error) waiter.reject(new Error(`${waiter.method}: ${payload.error.message}`));
      else waiter.resolve(payload.result);
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
      pending.set(id, { resolve, reject, method });
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

  const evaluate = async (expression, awaitPromise = true) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${detail}`);
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeoutMs = 30_000, label = expression) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression).catch(() => false);
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${label}`);
  };

  const shotDir = process.env.SHOT_DIR ?? '/tmp/dshx';
  await (await import('node:fs/promises')).mkdir(shotDir, { recursive: true });
  const shot = async (name) => {
    const file = `${shotDir}/${name}`;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await (await import('node:fs/promises')).writeFile(file, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${file}`);
  };

  console.log('navigate', PAGE_URL);
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await waitFor('document.readyState === "complete"', 30_000, 'document ready');
  const hooked = await waitFor('typeof window.__dshEli5 === "object"', 30_000, '__dshEli5 hook');
  console.log('client bundle registered:', await evaluate('window.__dshEli5.version'));

  // 1) Panel through the debug hook.
  await evaluate(`window.__dshEli5.open('棘轮效应（ratchet effect）', '在讨论 AI 输出积累时提到：棘轮法适合 AI 输出的渐进积累。')`);
  await waitFor('document.querySelector("#dsh-eli5-panel:not([hidden])") !== null', 5_000, 'panel visible');
  const firstAnswer = await waitFor(
    '(() => { const el = document.querySelector("#dsh-eli5-panel .xp-answer"); return el && el.innerText.trim().length > 20 ? el.innerText : ""; })()',
    90_000,
    'first explanation',
  );
  console.log('--- answer 1 (first 120 chars) ---\n' + firstAnswer.slice(0, 120));
  await shot('shot-panel.png');

  // 1c) A running explanation can be stopped, and the panel says so.
  await evaluate(`window.__dshEli5.open('什么是幂等', '')`);
  await waitFor(
    '(() => { const b = document.querySelector("#dsh-eli5-panel .xp-stop"); return b !== null && !b.hidden; })()',
    10_000,
    'stop button',
  );
  await evaluate('document.querySelector("#dsh-eli5-panel .xp-stop").click()');
  const stopped = await waitFor(
    '(() => { const n = document.querySelector("#dsh-eli5-panel .xp-notice"); return n && !n.hidden ? n.textContent : ""; })()',
    8_000,
    'stop notice',
  );
  console.log('stop notice:', stopped);

  // 2) Follow-up through the quick action row (panel history must be included).
  // 1b) A question that needs the code: the reading trace must show up.
  await evaluate(`window.__dshEli5.open('RetryPolicy 是什么', '我们在给后台任务加重试，代码在 internal/worker/retry.go')`);
  const trace = await waitFor(
    '(() => { const box = document.querySelector("#dsh-eli5-panel .xp-trace"); return box && !box.hidden ? box.innerText.trim() : ""; })()',
    90_000,
    'reading trace',
  );
  console.log('--- trace ---\n' + trace.slice(0, 300));
  await shot('shot-trace.png');

  // A 2x crop of just the panel — the image a README wants — once the answer
  // is actually there (the trace appears while the model is still thinking).
  await waitFor(
    '(() => { const el = document.querySelector("#dsh-eli5-panel .xp-answer"); return el && el.innerText.trim().length > 80 && !document.querySelector("#dsh-eli5-panel .xp-send").disabled; })()',
    90_000,
    'trace answer',
  );
  await evaluate('(() => { const b = document.querySelector("#dsh-eli5-panel .xp-body"); if (b) b.scrollTop = 0; })()');
  await sleep(400);
  const rect = await evaluate(
    `(() => { const r = document.querySelector('#dsh-eli5-panel').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`,
  );
  const cropped = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 2 } });
  await (await import('node:fs/promises')).writeFile(`${shotDir}/shot-panel.png`, Buffer.from(cropped.data, 'base64'));
  console.log('panel crop:', `${shotDir}/shot-panel.png`);

  const actions = await evaluate('document.querySelectorAll("#dsh-eli5-panel .xp-actions button").length');
  console.log('quick actions:', actions);
  if (actions > 0) {
    await evaluate('document.querySelector("#dsh-eli5-panel .xp-actions button").click()');
    const grown = await waitFor(
      '(() => { const el = document.querySelector("#dsh-eli5-panel .xp-answer"); return el && el.innerText.length > 200 && !document.querySelector("#dsh-eli5-panel .xp-send").disabled; })()',
      90_000,
      'follow-up answer',
    );
    console.log('follow-up rendered:', grown);
    await shot('shot-followup.png');
  }

  // 3) Real selection → chip → click → panel.
  await evaluate('window.__dshEli5.close()');
  await sleep(200);
  const selected = await evaluate(`(() => {
    // The fresh GUI only shows a welcome screen, so the chip test needs a
    // paragraph of readable text. It is appended outside the panel, exactly
    // where an assistant message would sit.
    let host = document.getElementById('xp-test-text');
    if (!host) {
      host = document.createElement('p');
      host.id = 'xp-test-text';
      host.textContent = '棘轮效应指的是只能单向推进、不能倒退的累积机制，常见于消费习惯与增量迭代。';
      host.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:280px;font-size:13px;z-index:1;';
      document.body.append(host);
    }
    const node = host.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 22);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));
    return selection.toString();
  })()`);
  console.log('selected text:', JSON.stringify(selected));
  if (selected !== '') {
    const chipShown = await waitFor(
      '(() => { const chip = document.getElementById("dsh-eli5-chip"); return chip && getComputedStyle(chip).display !== "none"; })()',
      5_000,
      'chip visible',
    );
    console.log('chip visible:', chipShown);
    await shot('shot-chip.png');
    await evaluate('document.getElementById("dsh-eli5-chip").click()');
    const quote = await waitFor(
      '(() => { const el = document.querySelector("#dsh-eli5-panel .xp-quote"); return el && el.textContent.trim().length > 0 ? el.textContent.trim() : ""; })()',
      5_000,
      'panel quote',
    );
    console.log('panel quote:', JSON.stringify(quote.slice(0, 40)));
    const secondAnswer = await waitFor(
      '(() => { const el = document.querySelector("#dsh-eli5-panel .xp-answer"); return el && el.innerText.trim().length > 20 ? el.innerText : ""; })()',
      90_000,
      'selection explanation',
    );
    console.log('--- answer 2 (first 120 chars) ---\n' + secondAnswer.slice(0, 120));
    await shot('shot-selection.png');
  }

  // 4) Report anything the page complained about.
  const problems = [];
  for (const event of cdp.events) {
    if (event.method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`);
    }
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
      problems.push(`log: ${event.params.entry.text}`);
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      problems.push(`console: ${event.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
    }
  }
  const relevant = problems.filter((line) => !/favicon|401|Unauthorized|Failed to load resource/i.test(line));
  console.log(`--- page problems: ${relevant.length} ---`);
  for (const line of relevant.slice(0, 10)) console.log(line);
  cdp.close();
  process.exit(relevant.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
