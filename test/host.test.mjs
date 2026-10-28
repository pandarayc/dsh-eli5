/**
 * dsh-eli5 — host unit checks, run with `node --test`.
 *
 * These do not need a DSH process: the LLM service is exercised through a fake
 * adapter that streams fixed chunks, the workspace is a temporary directory, and
 * the routes are served by a throwaway `node:http` server on a random loopback
 * port.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULTS, normalizeConfig } from '../lib/config.js';
import { createRoutes } from '../lib/http.js';
import { SYSTEM_PROMPT, TOOLS_PROMPT, buildUserMessage, systemPrompt } from '../lib/prompt.js';
import { Eli5Service, ToolMarkupFilter, readRequest } from '../lib/service.js';
import { ToolError, WorkspaceReader, globToRegExp } from '../lib/tools.js';

const CONFIG = normalizeConfig({ provider: 'fake', model: 'fake-model' });

/** A fake LLM service: one route, one model, one scripted stream per call. */
function fakeLlm(scripts) {
  const calls = [];
  let index = 0;
  return {
    calls,
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [{ id: 'fake-model' }],
    prepareCall: async (config) => {
      calls.push(config);
      return {
        config,
        stream: async function* (options) {
          calls.push(options);
          const script = scripts[Math.min(index, scripts.length - 1)];
          index += 1;
          for (const step of script) {
            if (step === 'throw') throw new Error('adapter exploded');
            yield step;
          }
        },
      };
    },
  };
}

/** A stop finish chunk. */
const STOP = { type: 'finish', reason: { kind: 'stop' } };

/** Mount a fake context around one LLM service and an optional session. */
function fakeCtx(llm, { cwd, sessionId = 'session-test' } = {}) {
  const sessions = {
    get: (id) => (id === sessionId && cwd !== undefined ? { header: { cwd } } : undefined),
  };
  return {
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'sessions') return sessions;
      return undefined;
    },
    logger: { info() {} },
    // Mirrors the host's `ctx.timeout`: a disposer instead of a bare timer id.
    timeout: (callback, delay) => {
      const handle = setTimeout(callback, delay);
      return () => clearTimeout(handle);
    },
  };
}

/** Serve the plugin's routes on loopback and return the base URL. */
async function serve(service, config = CONFIG) {
  const server = createServer(async (req, res) => {
    const route = createRoutes(service, config).find((entry) => entry.path === req.url);
    if (route === undefined) {
      res.writeHead(404).end();
      return;
    }
    await route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Collect the events of one explanation. */
async function collect(service, request) {
  const events = [];
  for await (const event of service.explain(request, new AbortController().signal)) events.push(event);
  return events;
}

/** Join the text events. */
function textOf(events) {
  return events
    .filter((event) => event.kind === 'text')
    .map((event) => event.text)
    .join('');
}

test('config normalization clamps and defaults', () => {
  const config = normalizeConfig({
    provider: '  fancyhub  ',
    model: 'glm',
    timeoutMs: 1,
    temperature: '9',
    cacheEntries: -4,
    enableTools: 'false',
    maxToolCalls: 999,
  });
  assert.equal(config.provider, 'fancyhub');
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.temperature, 2);
  assert.equal(config.cacheEntries, 0);
  assert.equal(config.enableTools, false);
  assert.equal(config.maxToolCalls, 24);
  assert.equal(normalizeConfig(undefined).maxOutputTokens, DEFAULTS.maxOutputTokens);
  assert.equal(normalizeConfig(undefined).enableTools, true);
});

test('readRequest trims, clips and drops malformed history', () => {
  const checked = readRequest(
    {
      text: '  棘轮法  ',
      context: 'x'.repeat(10_000),
      question: ' 为什么  ',
      sessionId: ' session-1 ',
      history: [
        { role: 'user', content: ' 问题 ' },
        { role: 'system', content: '不该被接受' },
        { role: 'assistant' },
        { role: 'assistant', content: ' 回答 ' },
      ],
    },
    CONFIG,
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.value.text, '棘轮法');
  assert.equal(checked.value.question, '为什么');
  assert.equal(checked.value.sessionId, 'session-1');
  assert.equal(checked.value.history.length, 2);
  assert.equal(checked.value.context.length, CONFIG.maxContextChars);
  assert.deepEqual(readRequest({ text: '   ' }, CONFIG), { ok: false, status: 400, error: '没有选中任何文字' });
  assert.equal(readRequest({ text: 'x'.repeat(99_999) }, CONFIG).status, 413);
  assert.equal(readRequest({ text: 'x', sessionId: 42 }, CONFIG).value.sessionId, '');
});

test('the wheel action picks the task, the extra rules and the tool budget', () => {
  assert.equal(readRequest({ text: 'x' }, CONFIG).value.action, 'explain');
  assert.equal(readRequest({ text: 'x', action: 'translate' }, CONFIG).value.action, 'translate');
  assert.equal(readRequest({ text: 'x', action: 'rm -rf' }, CONFIG).value.action, 'explain');

  const translated = buildUserMessage({ action: 'translate', text: 'Idempotent' }, CONFIG);
  assert.match(translated, /【现在的任务】\n把这段翻译成中文/);
  assert.match(buildUserMessage({ action: 'summarize', text: '一长段' }, CONFIG), /总结成能带走/);

  assert.match(systemPrompt(false, 'translate'), /翻译/);
  assert.doesNotMatch(systemPrompt(true, 'translate'), /read_file/);
  assert.match(systemPrompt(true, 'critique'), /read_file/);
  assert.match(systemPrompt(false, 'explain'), /```mermaid/);
  assert.doesNotMatch(systemPrompt(false, 'translate'), /```mermaid/);
});

test('the prompt carries the selection, optional context and follow-up', () => {
  const prompt = buildUserMessage(
    {
      text: '棘轮法',
      context: '上文提到只用加法更新',
      question: '为什么重要',
      history: [
        { role: 'user', content: '更通俗' },
        { role: 'assistant', content: '它是…' },
      ],
    },
    CONFIG,
  );
  assert.match(prompt, /【选中的文字】\n棘轮法/);
  assert.match(prompt, /【读者正在看的对话/);
  assert.match(prompt, /读者：更通俗/);
  assert.match(prompt, /【现在的任务】\n为什么重要/);
  assert.match(SYSTEM_PROMPT, /讲人话/);
  assert.match(SYSTEM_PROMPT, /对话里的含义/);
  assert.match(systemPrompt(true), /read_file/);
  assert.doesNotMatch(systemPrompt(false), /read_file/);
  assert.match(TOOLS_PROMPT, /先直接讲/);
});

test('one explanation streams deltas and is cached per exact prompt', async () => {
  const llm = fakeLlm([
    [
      { type: 'text-delta', index: 0, text: '棘轮法 = ' },
      { type: 'reasoning-delta', index: 0, text: '不该出现在面板里' },
      { type: 'text-delta', index: 0, text: '只增不减。' },
      STOP,
    ],
  ]);
  const service = new Eli5Service(fakeCtx(llm), CONFIG);
  const request = { text: '棘轮法', question: '', context: '', history: [], sessionId: '' };

  const events = await collect(service, request);
  assert.equal(events[0].kind, 'meta');
  assert.equal(events[0].tools, false);
  assert.equal(textOf(events), '棘轮法 = 只增不减。');
  assert.equal(events.at(-1).kind, 'done');
  assert.equal(llm.calls.filter((call) => call.messages !== undefined).length, 1);

  const again = await collect(service, request);
  assert.equal(again[0].cached, true);
  assert.equal(textOf(again), '棘轮法 = 只增不减。');
  assert.equal(llm.calls.filter((call) => call.messages !== undefined).length, 1, 'second call must hit the cache');
});

test('a tool call is executed, traced, and answered in a second turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explain-ws-'));
  await mkdir(join(root, 'internal'), { recursive: true });
  await writeFile(
    join(root, 'internal', 'retry.go'),
    'package internal\n\n// RetryPolicy caps attempts.\ntype RetryPolicy struct{ Max int }\n',
  );

  const llm = fakeLlm([
    [
      { type: 'text-delta', index: 0, text: '我先看一下代码。' },
      { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":"internal/retry.go"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    [{ type: 'text-delta', index: 0, text: '它限制重试次数。' }, STOP],
  ]);
  const service = new Eli5Service(fakeCtx(llm, { cwd: root }), CONFIG);
  const events = await collect(service, {
    text: 'RetryPolicy',
    question: '',
    context: '',
    history: [],
    sessionId: 'session-test',
  });

  assert.equal(events[0].tools, true);
  const trace = events.find((event) => event.kind === 'trace');
  assert.equal(trace.trace.tool, 'read_file');
  assert.equal(trace.trace.target, 'internal/retry.go');
  assert.equal(trace.trace.ok, true);
  assert.equal(textOf(events), '我先看一下代码。它限制重试次数。');

  const second = llm.calls.filter((call) => call.messages !== undefined)[1];
  assert.equal(second.tools.length, 3);
  const assistant = second.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content.at(-1), {
    type: 'tool-call',
    id: 'call-1',
    name: 'read_file',
    arguments: '{"path":"internal/retry.go"}',
  });
  const tool = second.messages[2];
  assert.equal(tool.role, 'tool');
  assert.equal(tool.toolCallId, 'call-1');
  assert.equal(tool.isError, false);
  assert.match(tool.content[0].text, /RetryPolicy/);
});

test('tools stay off without a resolvable session or when disabled', async () => {
  const llm = fakeLlm([[{ type: 'text-delta', index: 0, text: 'ok' }, STOP]]);
  const noSession = new Eli5Service(fakeCtx(llm), CONFIG);
  const events = await collect(noSession, { text: 'x', question: '', context: '', history: [], sessionId: 'gone' });
  assert.equal(events[0].tools, false);
  const options = llm.calls.filter((call) => call.messages !== undefined)[0];
  assert.equal(options.tools, undefined);
});

test('the tool budget stops further calls instead of throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explain-ws-'));
  await writeFile(join(root, 'a.txt'), 'hello\n');
  const toolTurn = [
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":"a.txt"}' },
    { type: 'tool-call-delta', index: 1, id: 'call-2', name: 'read_file', argumentsDelta: '{"path":"a.txt"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  const llm = fakeLlm([toolTurn, [{ type: 'text-delta', index: 0, text: '只有一次预算。' }, STOP]]);
  const service = new Eli5Service(
    fakeCtx(llm, { cwd: root }),
    normalizeConfig({ provider: 'fake', model: 'fake-model', maxToolCalls: 1 }),
  );
  const events = await collect(service, {
    text: 'x',
    question: '',
    context: '',
    history: [],
    sessionId: 'session-test',
  });
  const traces = events.filter((event) => event.kind === 'trace');
  assert.equal(traces.length, 2);
  assert.equal(traces[0].trace.ok, true);
  assert.equal(traces[1].trace.ok, false);
  assert.equal(traces[1].trace.reason, 'budget');
  assert.equal(textOf(events), '只有一次预算。');
});

test('route streams SSE frames and reports the model header', async () => {
  const llm = fakeLlm([[{ type: 'text-delta', index: 0, text: '解释正文' }, STOP]]);
  const server = await serve(new Eli5Service(fakeCtx(llm), CONFIG));
  try {
    const response = await fetch(`${server.base}/eli5/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '棘轮法' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-eli5-model'), 'fake-model');
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const body = await response.text();
    assert.match(body, /event: meta/);
    assert.match(body, /event: text\ndata: \{"text":"解释正文"\}/);
    assert.match(body, /event: done/);
  } finally {
    server.close();
  }
});

test('route rejects bad input and adapter failures as JSON', async () => {
  const server = await serve(new Eli5Service(fakeCtx(fakeLlm([['throw']])), CONFIG));
  try {
    const empty = await fetch(`${server.base}/eli5/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).ok, false);

    const broken = await fetch(`${server.base}/eli5/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '棘轮法' }),
    });
    assert.equal(broken.status, 500);
    assert.match((await broken.json()).error, /adapter exploded/);

    const wrongMethod = await fetch(`${server.base}/eli5/ask`);
    assert.equal(wrongMethod.status, 405);
  } finally {
    server.close();
  }
});

test('finish failure and empty answers surface as errors', async () => {
  const failing = new Eli5Service(
    fakeCtx(fakeLlm([[{ type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: '配额用尽' } } }]])),
    CONFIG,
  );
  await assert.rejects(
    () => collect(failing, { text: 'a', question: '', context: '', history: [], sessionId: '' }),
    /配额用尽/,
  );

  const empty = new Eli5Service(fakeCtx(fakeLlm([[{ type: 'text-delta', index: 0, text: '  ' }, STOP]])), CONFIG);
  await assert.rejects(
    () => collect(empty, { text: 'a', question: '', context: '', history: [], sessionId: '' }),
    /空解释/,
  );
});

test('health reports the resolved route, or why there is none', async () => {
  const service = new Eli5Service(fakeCtx(fakeLlm([])), CONFIG);
  assert.deepEqual(await service.health(), {
    ok: true,
    provider: 'fake',
    model: 'fake-model',
    listed: true,
    tools: true,
  });

  const absent = new Eli5Service(fakeCtx(undefined), CONFIG);
  const health = await absent.health();
  assert.equal(health.ok, false);
  assert.match(health.error, /LLM 服务未就绪/);
});

test('the route resolves a model when only a provider is configured', async () => {
  const llm = fakeLlm([[{ type: 'text-delta', index: 0, text: 'ok' }, STOP]]);
  const service = new Eli5Service(fakeCtx(llm), normalizeConfig({ provider: 'fake' }));
  const route = await service.resolveRoute();
  assert.deepEqual(route, { provider: 'fake', model: 'fake-model' });
});

test('the workspace reader refuses escapes, secrets and missing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explain-ws-'));
  await writeFile(join(root, 'ok.txt'), 'line one\nline two\n');
  await writeFile(join(root, '.env'), 'SECRET=1\n');
  const reader = new WorkspaceReader(root, { maxBytes: 10_000, maxFileLines: 400, maxGrepResults: 10, maxGlobResults: 10 });

  const text = await reader.readFile({ path: 'ok.txt' });
  assert.match(text, /【ok\.txt:1-2】/);
  assert.match(text, /1\| line one/);

  await assert.rejects(
    () => reader.readFile({ path: '../outside.txt' }),
    (error) => error instanceof ToolError && error.code === 'OUTSIDE_WORKSPACE',
  );
  await assert.rejects(
    () => reader.readFile({ path: '/etc/passwd' }),
    (error) => error instanceof ToolError && error.code === 'OUTSIDE_WORKSPACE',
  );
  await assert.rejects(
    () => reader.readFile({ path: '.env' }),
    (error) => error instanceof ToolError && error.code === 'DENIED',
  );
  await assert.rejects(
    () => reader.readFile({ path: 'missing.txt' }),
    (error) => error instanceof ToolError && error.code === 'ENOENT',
  );
});

test('glob and grep find files inside the workspace only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explain-ws-'));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const retryPolicy = 1;\n');
  await writeFile(join(root, 'src', 'nested', 'b.ts'), '// retryPolicy lives here\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.ts'), 'retryPolicy should not be found\n');
  const reader = new WorkspaceReader(root, {
    maxBytes: 100_000,
    maxFileLines: 400,
    maxGrepResults: 10,
    maxGlobResults: 10,
  });

  const files = await reader.glob({ pattern: '**/*.ts' });
  assert.match(files, /src\/a\.ts/);
  assert.match(files, /src\/nested\/b\.ts/);
  assert.doesNotMatch(files, /node_modules/);

  const hits = await reader.grep({ pattern: 'retrypolicy' });
  assert.equal(hits.match(/retryPolicy/g).length, 2);
  assert.doesNotMatch(hits, /node_modules/);
});

test('globToRegExp keeps single stars inside a segment', () => {
  assert.equal(globToRegExp('*.ts').test('a.ts'), true);
  assert.equal(globToRegExp('*.ts').test('src/a.ts'), false);
  assert.equal(globToRegExp('**/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/**/retry*.go').test('src/x/y/retry_test.go'), true);
});

test('tool markup is stripped even when it arrives split across deltas', () => {
  const filter = new ToolMarkupFilter();
  const parts = ['结论：没找到。', '<|', 'DS', 'ML', '|>', ' invoke name="grep"', '</|', 'DSML', '|>', '（完）'];
  const shown = parts.map((part) => filter.push(part)).join('');
  assert.equal(shown, '结论：没找到。（完）');

  const wide = new ToolMarkupFilter();
  const wideShown = ['A', '<｜｜DSML｜｜>', 'invoke name="x"', '</｜｜DSML｜｜>', 'B'].map((part) => wide.push(part)).join('');
  assert.equal(wideShown, 'AB');

  const hint = new ToolMarkupFilter();
  assert.equal(hint.push('A<|DSML|>tool_calls>'), 'A');
  assert.equal(hint.push('<|DSML|>invoke name="read_file">'), '');
  assert.equal(hint.push('</|DSML|>B'), 'B');
});

test('a sentence that merely mentions the markup keeps its words', () => {
  const filter = new ToolMarkupFilter();
  assert.equal(filter.push('它会把 `<|DSML|>` 这样的标记去掉'), '它会把 `<|DSML|>` 这样的标记去掉');

  // A marker split across deltas, followed by prose: the text is not swallowed.
  const split = new ToolMarkupFilter();
  const shown = ['标记 ', '<|', 'DSM', 'L|>', '就是', '这个'].map((part) => split.push(part)).join('');
  assert.equal(shown, '标记 <|DSML|>就是这个');

  // A marker at the very end of the turn is prose too, not a half tool call.
  const tail = new ToolMarkupFilter();
  assert.equal(tail.push('例子：'), '例子：');
  assert.equal(tail.push('<|DSML|>'), '');
  assert.equal(tail.flush(), '<|DSML|>');

  const plain = new ToolMarkupFilter();
  assert.equal(plain.push('普通 < 符号与 | 竖线'), '普通 < 符号与 | 竖线');
});

test('a truncated answer is reported and never cached', async () => {
  const llm = fakeLlm([
    [
      { type: 'text-delta', index: 0, text: '这东西就是' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
  ]);
  const service = new Eli5Service(fakeCtx(llm), CONFIG);
  const request = { text: 'a', question: '', context: '', history: [], sessionId: '' };
  const events = await collect(service, request);
  assert.equal(textOf(events), '这东西就是');
  const notice = events.find((event) => event.kind === 'notice');
  assert.match(notice.text, /长度上限/);

  const again = await collect(service, request);
  assert.equal(again[0].cached, false);
});
