/**
 * dsh-eli5 — the auxiliary model call.
 *
 * One explanation is one independent LLM query: a fixed system instruction plus
 * a single user message, optionally followed by a few read-only workspace tool
 * calls. No session id is *written* anywhere, no agent loop, no history from the
 * conversation the reader is looking at — which is exactly why explaining a word
 * cannot grow, reorder or compact that conversation.
 *
 * The session id is read-only input: it is used for one thing, resolving the
 * conversation's working directory so the tools cannot read outside it.
 *
 * @module dsh-eli5/service
 */

import { createHash } from 'node:crypto';

import { PREFERRED, clip } from './config.js';
import { PROMPT_REVISION, buildUserMessage, systemPrompt } from './prompt.js';
import { TOOL_HANDLERS, TOOL_SCHEMAS, ToolError, WorkspaceReader } from './tools.js';

/** One turn shape accepted from the browser half. */
const ROLE = new Set(['user', 'assistant']);

/**
 * Opening and closing tags a route may print when it wants a tool it was not
 * offered. DeepSeek's own format (`<|DSML|>`) shows up as *text* when a model
 * that has been answering with tool calls suddenly gets a request without tools;
 * the panel must not show that markup to a reader.
 */
const TOOL_MARKUP_OPEN = ['<|DSML|>', '<｜｜DSML｜｜>'];
const TOOL_MARKUP_CLOSE = ['</|DSML|>', '</｜｜DSML｜｜>'];

/**
 * Words that start a real tool-call payload after an opening marker.
 *
 * The markers alone are not proof of a leaked tool call: a model explaining *this
 * very filter* writes them as part of a sentence, and stripping everything after
 * one silently truncates a correct answer (observed in the wild). So a marker only
 * opens a skipped block when the text right after it is one of these words.
 */
const TOOL_MARKUP_HINTS = ['tool_calls', 'tool_call', 'function_calls', 'function_call', 'invoke', 'parameter'];

/** Longest run of undecided text kept while waiting to classify a marker. */
const MAX_UNDECIDED = 24;

/** True when `text` ends with the start of one of `markers` (so it may grow into one). */
function endsWithMarkerPrefix(text, markers) {
  for (const marker of markers) {
    const most = Math.min(marker.length - 1, text.length);
    for (let size = most; size > 0; size -= 1) {
      if (text.endsWith(marker.slice(0, size))) return size;
    }
  }
  return 0;
}

/** Index of the first marker in `text`, or `-1`. */
function indexOfMarker(text, markers) {
  let found = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at !== -1 && (found === -1 || at < found)) found = at;
  }
  return found;
}

/**
 * Decide what the text right after an opening marker is.
 *
 * @param text - the characters seen after the marker so far.
 * @returns `'call'` (drop it), `'prose'` (keep the marker as text) or `'wait'`.
 */
function classifyPayload(text) {
  const trimmed = text.replace(/^\s+/, '');
  const word = /^[A-Za-z_]*/.exec(trimmed)[0].toLowerCase();
  if (word === '') {
    // Not a letter yet: prose. Only whitespace so far: wait for the next delta.
    if (trimmed !== '') return 'prose';
    return text.length <= MAX_UNDECIDED ? 'wait' : 'prose';
  }
  if (TOOL_MARKUP_HINTS.includes(word)) return 'call';
  if (TOOL_MARKUP_HINTS.some((hint) => hint.startsWith(word))) {
    return trimmed.length <= MAX_UNDECIDED ? 'wait' : 'prose';
  }
  return 'prose';
}

/**
 * Strip tool-call markup out of a streamed answer.
 *
 * The filter is stateful because the markers arrive split across deltas
 * (`<|`, `DS`, `ML`, `|>`); it holds back a trailing partial marker instead of
 * emitting it. Content inside a marker pair is dropped only when it actually is
 * a tool call (see {@link TOOL_MARKUP_HINTS}); a sentence that merely mentions
 * the markup keeps its words.
 */
export class ToolMarkupFilter {
  constructor() {
    this.buffer = '';
    this.skipping = false;
    /** Opening marker awaiting classification, or `null`. */
    this.marker = null;
    /** Text seen after {@link marker} so far, or `null` when no marker is open. */
    this.undecided = null;
  }

  /**
   * Feed one delta.
   * @param chunk - raw text delta from the model.
   * @returns the part that is safe to show.
   */
  push(chunk) {
    this.buffer += chunk;
    let out = '';
    for (;;) {
      if (this.skipping) {
        const end = indexOfMarker(this.buffer, TOOL_MARKUP_CLOSE);
        if (end === -1) {
          // Keep only a possible partial closing marker at the tail.
          const keep = endsWithMarkerPrefix(this.buffer, TOOL_MARKUP_CLOSE);
          this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - keep));
          return out;
        }
        const marker = TOOL_MARKUP_CLOSE.find((candidate) => this.buffer.startsWith(candidate, end)) ?? '';
        this.buffer = this.buffer.slice(end + marker.length);
        this.skipping = false;
        continue;
      }
      if (this.undecided !== null) {
        this.undecided += this.buffer;
        this.buffer = '';
        const verdict = classifyPayload(this.undecided);
        if (verdict === 'wait') return out;
        if (verdict === 'prose') out += this.marker + this.undecided;
        this.marker = null;
        this.undecided = null;
        this.skipping = verdict === 'call';
        continue;
      }
      const start = indexOfMarker(this.buffer, TOOL_MARKUP_OPEN);
      if (start === -1) {
        const keep = endsWithMarkerPrefix(this.buffer, TOOL_MARKUP_OPEN);
        const cut = this.buffer.length - keep;
        out += this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut);
        return out;
      }
      out += this.buffer.slice(0, start);
      const marker = TOOL_MARKUP_OPEN.find((candidate) => this.buffer.startsWith(candidate, start)) ?? '';
      this.buffer = this.buffer.slice(start + marker.length);
      this.marker = marker;
      this.undecided = '';
    }
  }

  /**
   * Close the turn.
   *
   * A marker the answer never classified was prose in practice (a leaked call
   * would have shown its keyword within a few characters), so it is returned as
   * text instead of vanishing. Text inside a skipped block stays dropped.
   *
   * @returns the tail the caller still owes the reader.
   */
  flush() {
    let out = '';
    if (!this.skipping && this.marker !== null && this.undecided !== null) {
      if (classifyPayload(this.undecided) !== 'call') out = this.marker + this.undecided;
    }
    this.buffer = '';
    this.skipping = false;
    this.marker = null;
    this.undecided = null;
    return out;
  }
}

/** Largest single tool result handed back to the model. */
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Least reasoning effort offered by the route, or the controls unchanged. */
function leastReasoning(controls, model) {
  const first = model?.reasoning?.efforts?.[0];
  return first === undefined ? controls : { ...controls, reasoningEffort: first.id };
}

/** Read the finish chunk's failure, or `undefined` for a usable finish. */
function finishError(finish) {
  if (finish === undefined) return new Error('模型没有返回结束标记');
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return new Error(finish.failure?.message ?? '模型调用失败');
  }
  return undefined;
}

/**
 * Validate and clamp one request body from the browser half.
 *
 * @param body - parsed JSON body.
 * @param config - normalized plugin config.
 * @returns `{ok: true, value}` or `{ok: false, status, error}`.
 */
export function readRequest(body, config) {
  const value = body !== null && typeof body === 'object' ? body : {};
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (text === '') return { ok: false, status: 400, error: '没有选中任何文字' };
  if (text.length > config.maxSelectedChars) {
    return { ok: false, status: 413, error: `选中的文字太长（${text.length} 字，上限 ${config.maxSelectedChars}）` };
  }
  const question = typeof value.question === 'string' ? clip(value.question.trim(), config.maxQuestionChars) : '';
  const context = typeof value.context === 'string' ? clip(value.context.trim(), config.maxContextChars) : '';
  const sessionId = typeof value.sessionId === 'string' ? clip(value.sessionId.trim(), 200) : '';
  const history = [];
  if (Array.isArray(value.history)) {
    for (const turn of value.history.slice(-config.maxHistoryEntries)) {
      if (turn === null || typeof turn !== 'object') continue;
      if (!ROLE.has(turn.role) || typeof turn.content !== 'string') continue;
      const content = turn.content.trim();
      if (content === '') continue;
      history.push({ role: turn.role, content: clip(content, config.maxHistoryChars) });
    }
  }
  return { ok: true, value: { text, question, context, history, sessionId } };
}

/** Human-readable target of one tool call, for the reading trace. */
function traceTarget(name, args) {
  if (name === 'read_file') {
    const path = typeof args.path === 'string' ? args.path : '?';
    const start = Number.isFinite(Number(args.startLine)) ? Number(args.startLine) : undefined;
    const end = Number.isFinite(Number(args.endLine)) ? Number(args.endLine) : undefined;
    if (start !== undefined && end !== undefined) return `${path}:${start}-${end}`;
    if (start !== undefined) return `${path}:${start}+`;
    return path;
  }
  if (name === 'grep') {
    const glob = typeof args.glob === 'string' && args.glob.trim() !== '' ? ` ${args.glob.trim()}` : '';
    return `/${typeof args.pattern === 'string' ? args.pattern : '?'}/${glob}`;
  }
  if (name === 'glob') return typeof args.pattern === 'string' ? args.pattern : '?';
  return name;
}

/** Parse a tool call's raw JSON arguments, tolerating model malformations. */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Explains selections through an auxiliary LLM call.
 *
 * The service owns route resolution, prompt construction, request bounds, the
 * tool budget, the response cache and the concurrency cap. It reads the session
 * of the conversation being explained only to learn its working directory; it
 * never appends to it, so the conversation's turn count and context are
 * untouched.
 */
export class Eli5Service {
  /** @param ctx - Cordis context (host). */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** @type {Map<string, string>} insertion-ordered LRU of finished answers. */
    this.cache = new Map();
    this.active = 0;
    this.measured = undefined;
  }

  /** The registered LLM service, or `undefined` while it is not mounted. */
  get llm() {
    return this.ctx.get('llm');
  }

  /**
   * Working directory of the conversation being explained, or `undefined`.
   *
   * Read-only, one lookup: tools are simply unavailable when the session is
   * unknown (a stale panel, another profile, a plain HTTP client), and the
   * explanation still works without them.
   *
   * @param sessionId - session id sent by the browser half.
   * @returns the absolute cwd, when it can be resolved.
   */
  cwdOf(sessionId) {
    if (this.config.debug && this.config.debugCwd !== '') return this.config.debugCwd;
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    try {
      const sessions = this.ctx.get('sessions');
      const session = sessions?.get?.(sessionId);
      const cwd = session?.header?.cwd;
      return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve `{provider, model}`: explicit config first, then a known small
   * route, then the first provider's first model.
   *
   * @param signal - cancellation for the model listing.
   * @returns the route actually used.
   */
  async resolveRoute(signal) {
    const llm = this.llm;
    if (llm === undefined) throw new Error('LLM 服务未就绪');
    const providers = llm.listProviders().map((entry) => entry.id);
    if (providers.length === 0) throw new Error('没有已注册的模型路由');
    const configured = { provider: this.config.provider, model: this.config.model };
    if (configured.provider !== '' && configured.model !== '') return configured;

    const candidates = [];
    if (configured.provider !== '') candidates.push([configured.provider, configured.model]);
    for (const [provider, model] of PREFERRED) candidates.push([provider, model]);
    for (const provider of providers) candidates.push([provider, '']);

    for (const [provider, model] of candidates) {
      if (!providers.includes(provider)) continue;
      if (model !== '') return { provider, model };
      const models = await llm.listModels(provider);
      const first = models[0]?.id;
      if (first !== undefined) return { provider, model: first };
    }
    throw new Error(`没有可用的模型路由（已注册：${providers.join(', ')}）`);
  }

  /**
   * Health snapshot for the panel's "which model answers this" line.
   *
   * @param signal - cancellation for route and model listing.
   * @returns `{ok, provider?, model?, available, error?}`.
   */
  async health(signal) {
    try {
      const route = await this.resolveRoute(signal);
      const llm = this.llm;
      const models = await llm.listModels(route.provider);
      return {
        ok: true,
        provider: route.provider,
        model: route.model,
        listed: models.some((entry) => entry.id === route.model),
        tools: this.config.enableTools,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Cache key for one exact model-visible request. */
  keyOf(model, prompt) {
    return createHash('sha256')
      .update(PROMPT_REVISION)
      .update('\u0000')
      .update(model)
      .update('\u0000')
      .update(prompt)
      .digest('hex');
  }

  /** Remember one finished answer, evicting the oldest entries first. */
  remember(key, answer) {
    if (this.config.cacheEntries === 0) return;
    this.cache.delete(key);
    this.cache.set(key, answer);
    while (this.cache.size > this.config.cacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /**
   * Stream one explanation.
   *
   * Yields structured events rather than raw text, because the panel needs to
   * show what was read while the answer is still streaming:
   *
   *   `{kind: 'meta', route, cached, tools}`  once, before anything else
   *   `{kind: 'text', text}`                  answer fragments
   *   `{kind: 'trace', trace}`                one line per tool call
   *   `{kind: 'done', cached}`                the answer is complete
   *
   * Errors surface as throws before or during iteration; the caller decides how
   * to report them.
   *
   * @param request - validated `{text, question, context, history, sessionId}`.
   * @param signal - cancellation (the browser closing the panel aborts it).
   * @returns async iterable of events.
   */
  async *explain(request, signal) {
    if (this.active >= this.config.maxConcurrent) {
      const error = new Error('同时进行的解释太多，请稍后再试');
      error.status = 429;
      throw error;
    }
    const llm = this.llm;
    if (llm === undefined) {
      const error = new Error('LLM 服务未就绪，请等 Host 加载完成');
      error.status = 503;
      throw error;
    }
    const route = await this.resolveRoute(signal);
    const prompt = buildUserMessage(request, this.config);
    const key = this.keyOf(route.model, prompt);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      yield { kind: 'meta', route, cached: true, tools: false };
      yield { kind: 'text', text: cached };
      yield { kind: 'done', cached: true };
      return;
    }

    const cwd = this.cwdOf(request.sessionId);
    const toolsEnabled =
      this.config.enableTools && cwd !== undefined && this.config.maxToolRounds > 0 && this.config.maxToolCalls > 0;

    this.active += 1;
    try {
      const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];

      const reader = toolsEnabled
        ? new WorkspaceReader(cwd, {
            maxBytes: this.config.maxToolBytes,
            maxFileLines: this.config.maxFileLines,
            maxGrepResults: this.config.maxGrepResults,
            maxGlobResults: this.config.maxGlobResults,
          })
        : undefined;
      const startedAt = Date.now();
      let calls = 0;
      let usedTools = false;
      let truncated = false;
      let answer = '';

      for (let round = 0; round <= this.config.maxToolRounds; round += 1) {
        const budgetLeft =
          calls < this.config.maxToolCalls &&
          Date.now() - startedAt < this.config.maxToolMs &&
          round < this.config.maxToolRounds;
        const withTools = reader !== undefined && budgetLeft;
        if (!withTools && usedTools) {
          // The tools just went away; without this nudge a model that has been
          // calling them may print tool syntax as prose instead of answering.
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: '（系统提示：这次解释的读取预算已用完，不能再读文件。请直接用已经看到的结果回答，不要输出任何工具调用语法。）',
              },
            ],
          });
        }
        // A prepared call is dispatch-once, so every round prepares its own.
        const call = await this.prepareCall(route, signal);
        if (round === 0) yield { kind: 'meta', route, cached: false, tools: toolsEnabled };
        const turn = yield* this.streamTurn(call, {
          ...call.config,
          system: systemPrompt(toolsEnabled),
          signal,
          messages,
          ...(withTools ? { tools: TOOL_SCHEMAS } : {}),
        });
        answer += turn.text;
        if (turn.truncated === true) {
          // A cut-off turn's tool calls are half-written JSON; do not run them.
          truncated = true;
          break;
        }
        if (turn.toolCalls.length === 0) break;

        usedTools = true;
        messages.push({
          role: 'assistant',
          content: [
            ...(turn.text === '' ? [] : [{ type: 'text', text: turn.text }]),
            ...turn.toolCalls.map((toolCall) => ({
              type: 'tool-call',
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            })),
          ],
          source: { kind: 'model', provider: route.provider, model: route.model },
        });

        for (const toolCall of turn.toolCalls) {
          const result = await this.runTool(reader, toolCall, {
            calls,
            startedAt,
            exhaustedCallBudget: calls >= this.config.maxToolCalls,
            exhaustedTime: Date.now() - startedAt >= this.config.maxToolMs,
          });
          calls += 1;
          yield { kind: 'trace', trace: result.trace };
          messages.push({
            role: 'tool',
            toolCallId: toolCall.id,
            source: { kind: 'tool', callId: toolCall.id },
            content: [{ type: 'text', text: result.text }],
            isError: result.trace.ok !== true,
          });
        }
      }

      if (answer.trim() === '') throw new Error('模型返回了空解释，换个问法试试');
      if (truncated) {
        // Say it instead of pretending the answer ended: a cut-off explanation
        // reads like a wrong one, and the reader is the only one who can tell.
        yield { kind: 'notice', text: '回答撞到这次的长度上限，后面没写完——追问一句「接着说」可以继续。' };
      }
      if (!usedTools && !truncated) this.remember(key, answer);
      yield { kind: 'done', cached: false };
    } finally {
      this.active -= 1;
    }
  }

  /**
   * Prepare one dispatch of the configured route.
   *
   * The harness prepares a call for a single dispatch; a tool loop needs one per
   * turn, so this is the per-turn wrapper that also owns the error wording.
   *
   * @param route - `{provider, model}` resolved once per explanation.
   * @param signal - cancellation.
   * @returns the prepared call handle.
   */
  async prepareCall(route, signal) {
    try {
      return await this.llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          maxTokens: this.config.maxOutputTokens,
          ...(this.config.temperature === undefined ? {} : { temperature: this.config.temperature }),
        },
        signal,
        leastReasoning,
      );
    } catch (error) {
      throw new Error(`模型路由不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One model turn: stream its text and collect its tool calls.
   *
   * Tool calls arrive as deltas keyed by block index; `block-end` carries the
   * assembled block, which is preferred when the adapter emits it (some do not).
   *
   * @param call - prepared call handle.
   * @param options - request options for this turn.
   * @returns `{text, toolCalls, truncated}` once the stream finishes.
   */
  async *streamTurn(call, options) {
    let text = '';
    const filter = new ToolMarkupFilter();
    const partial = new Map();
    let finish;
    for await (const chunk of call.stream(options)) {
      if (chunk.type === 'text-delta' && chunk.text !== '') {
        const visible = filter.push(chunk.text);
        if (visible !== '') {
          text += visible;
          yield { kind: 'text', text: visible };
        }
      } else if (chunk.type === 'reasoning-delta') {
        // Reasoning stays out of the panel: the panel is a reading aid, not a
        // place to watch a model think.
      } else if (chunk.type === 'tool-call-delta') {
        const entry = partial.get(chunk.index) ?? { id: chunk.id ?? '', name: '', arguments: '' };
        if (typeof chunk.name === 'string' && chunk.name !== '') entry.name = chunk.name;
        entry.arguments += chunk.argumentsDelta ?? '';
        partial.set(chunk.index, entry);
      } else if (chunk.type === 'block-end') {
        const block = chunk.block;
        if (block?.type === 'tool-call') {
          partial.set(chunk.index, { id: block.id, name: block.name, arguments: block.arguments });
        }
      } else if (chunk.type === 'finish') {
        finish = chunk.reason;
      }
    }
    const tail = filter.flush();
    if (tail !== '') {
      text += tail;
      yield { kind: 'text', text: tail };
    }
    const failure = finishError(finish);
    if (failure !== undefined) throw failure;
    const toolCalls = [...partial.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => entry)
      .filter((entry) => entry.name !== '');
    return { text, toolCalls, truncated: finish?.kind === 'max-tokens' };
  }

  /**
   * Execute one tool call under the request's budget.
   *
   * A refusal is not an exception here: it becomes a tool result the model can
   * read and react to, plus a trace line for the reader.
   *
   * @param reader - sandboxed reader, or `undefined` when tools are disabled.
   * @param toolCall - `{id, name, arguments}` as the model emitted it.
   * @param budget - `{calls, startedAt, exhaustedCallBudget, exhaustedTime}`.
   * @returns `{text, trace}`.
   */
  async runTool(reader, toolCall, budget) {
    const started = Date.now();
    const args = parseArguments(toolCall.arguments);
    const target = traceTarget(toolCall.name, args);
    const handler = TOOL_HANDLERS[toolCall.name];
    if (reader === undefined || handler === undefined) {
      return {
        text: `工具 ${toolCall.name} 不可用（本会话没有可读的工作区）`,
        trace: { tool: toolCall.name, target, ok: false, ms: 0, reason: 'unavailable' },
      };
    }
    if (budget.exhaustedCallBudget || budget.exhaustedTime) {
      return {
        text: '这次解释的读取预算已用完，请基于已经看到的信息直接回答，并说明还有没读完的部分。',
        trace: { tool: toolCall.name, target, ok: false, ms: 0, reason: 'budget' },
      };
    }
    try {
      const text = await handler(reader, args);
      return {
        text: text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…（已截断）` : text,
        trace: { tool: toolCall.name, target, ok: true, ms: Date.now() - started },
      };
    } catch (error) {
      const message =
        error instanceof ToolError ? error.message : `读取失败：${error instanceof Error ? error.message : String(error)}`;
      return {
        text: message,
        trace: { tool: toolCall.name, target, ok: false, ms: Date.now() - started, reason: error?.code ?? 'error' },
      };
    }
  }
}
