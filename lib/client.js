/**
 * dsh-eli5 — browser half.
 *
 * Select any text in the Web GUI, click the floating 「解释」 chip, and read the
 * explanation in a panel that sits above the conversation. The panel talks to
 * the host over one same-origin route (`POST /eli5/ask`), which runs its own
 * auxiliary model call.
 *
 * Why it is built this way: the reader's problem is "I do not understand this
 * word", not "I want to continue the task". Routing that question through the
 * Agent would add a user turn, a tool round and a big answer to the very
 * conversation being read — growing its context and eventually forcing a
 * compaction. So this half never calls `ctx.sessions`, never sends a message and
 * never writes to the Session log: it only reads what the user selected from the
 * DOM and renders plain text back.
 *
 * Only DOM APIs are used: no React import, no shared modules, so the bundle has
 * no client-module dependencies to satisfy.
 *
 * @module dsh-eli5/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-eli5',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    void require; // No shared client module is required by this bundle.

    const VERSION = '0.4.1';
    const ASK_ENDPOINT = '/eli5/ask';
    const HEALTH_ENDPOINT = '/eli5/health';
    const PANEL_ID = 'dsh-eli5-panel';
    const CHIP_ID = 'dsh-eli5-chip';
    const STYLE_ID = 'dsh-eli5-style';
    const MAX_SELECTED_CHARS = 4000;

    const LABELS = {
      chip: '讲人话',
      title: '讲人话',
      copy: '复制',
      copied: '已复制',
      close: '关闭',
      placeholder: '还想问什么…（Enter 发送，Shift+Enter 换行）',
      send: '发送',
      hint: '独立模型查询 · 只读工作区与屏幕上这段对话，不写入会话',
      thinking: '正在想怎么说…',
      empty: '选中文字后点「讲人话」，这里会用大白话说明白。',
      retry: '重试',
      ctxOn: '上文 开',
      reask: '按新设置重答',
      ctxOffPending: '已关闭「上文」，下一次提问生效',
      ctxOnPending: '已开启「上文」，下一次提问生效',
      ctxOff: '上文 关',
      ctxHint: '把屏幕上这段对话一起发给解释模型（只读页面文字，不写入会话）',
      noSelection: '先选中一段文字',
      stop: '停止',
      stopped: '已停止，答案不完整',
      cached: '这段刚解释过，直接显示缓存（没有重新请求模型）',
      traceTitle: '看了这些',
      traceEmpty: '没有读文件',
      quick: ['再直白点', '举个例子', '画个图', '为什么这么说', '结合上下文看'],
    };

    const CSS = `
      #${CHIP_ID} {
        position: fixed;
        z-index: 9998;
        display: none;
        align-items: center;
        gap: 4px;
        padding: 5px 10px;
        font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #fff;
        background: #3b62f6;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        box-shadow: 0 6px 20px rgba(24, 40, 96, 0.32);
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
      }
      #${CHIP_ID}:hover { background: #2f52da; }
      #${CHIP_ID} .xp-chip-mark { font-size: 11px; opacity: 0.9; }

      #${PANEL_ID} {
        color-scheme: light dark;
        position: fixed;
        z-index: 9997;
        top: 74px;
        right: 18px;
        width: min(440px, calc(100vw - 32px));
        max-height: calc(100vh - 120px);
        display: flex;
        flex-direction: column;
        background: light-dark(#ffffff, #1b1c21);
        color: light-dark(#1d2126, #e7e8ea);
        border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.14));
        border-radius: 14px;
        box-shadow: 0 18px 48px rgba(9, 12, 24, 0.28);
        font: 14px/1.62 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        overflow: hidden;
      }
      #${PANEL_ID}[hidden] { display: none; }
      #${PANEL_ID} .xp-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid light-dark(rgba(15, 23, 42, 0.08), rgba(255, 255, 255, 0.1));
        background: light-dark(#f7f8fa, #202127);
        flex: 0 0 auto;
      }
      #${PANEL_ID} .xp-mark { color: #3b62f6; font-size: 12px; }
      #${PANEL_ID} .xp-title { font-weight: 600; font-size: 13px; letter-spacing: 0.01em; }
      #${PANEL_ID} .xp-model {
        font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: light-dark(#6b7280, #9aa0aa);
        background: light-dark(rgba(15, 23, 42, 0.05), rgba(255, 255, 255, 0.07));
        border-radius: 999px;
        padding: 3px 8px;
        margin-left: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 42%;
      }
      #${PANEL_ID} .xp-spacer { flex: 1 1 auto; }
      #${PANEL_ID} .xp-btn {
        appearance: none;
        border: 1px solid transparent;
        background: transparent;
        color: light-dark(#4b5563, #a6abb5);
        font: inherit;
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 8px;
        cursor: pointer;
      }
      #${PANEL_ID} .xp-ctx { font-size: 11.5px; }
      #${PANEL_ID} .xp-ctx[data-on="false"] { opacity: 0.55; }
      #${PANEL_ID} .xp-btn:hover {
        background: light-dark(rgba(15, 23, 42, 0.06), rgba(255, 255, 255, 0.08));
        color: light-dark(#111827, #f3f4f6);
      }
      #${PANEL_ID} .xp-body {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 12px 14px 6px;
        overscroll-behavior: contain;
      }
      #${PANEL_ID} .xp-quote {
        margin: 0 0 12px;
        padding: 8px 10px;
        max-height: 108px;
        overflow-y: auto;
        border-left: 3px solid light-dark(rgba(59, 98, 246, 0.55), rgba(120, 150, 255, 0.6));
        background: light-dark(rgba(59, 98, 246, 0.06), rgba(120, 150, 255, 0.09));
        border-radius: 0 8px 8px 0;
        color: light-dark(#374151, #c3c7cf);
        font-size: 12.5px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #${PANEL_ID} .xp-trace {
        margin: 0 0 10px;
        padding: 7px 9px;
        border: 1px dashed light-dark(rgba(15, 23, 42, 0.16), rgba(255, 255, 255, 0.16));
        border-radius: 8px;
        background: light-dark(rgba(15, 23, 42, 0.025), rgba(255, 255, 255, 0.03));
        font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: light-dark(#4b5563, #a6abb5);
      }
      #${PANEL_ID} .xp-trace[hidden] { display: none; }
      #${PANEL_ID} .xp-trace summary {
        cursor: pointer;
        user-select: none;
        font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 11.5px;
        color: light-dark(#6b7280, #9aa0aa);
      }
      #${PANEL_ID} .xp-trace ul { list-style: none; margin: 6px 0 0; padding: 0; }
      #${PANEL_ID} .xp-trace li { margin: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #${PANEL_ID} .xp-trace li[data-ok="false"] { color: light-dark(#9f1239, #ffb4b4); }
      #${PANEL_ID} .xp-trace code { background: none; padding: 0; font-size: 11.5px; }
      #${PANEL_ID} .xp-trace .xp-tool { opacity: 0.7; margin-right: 5px; }

      #${PANEL_ID} .xp-answer p { margin: 0 0 8px; }
      #${PANEL_ID} .xp-answer p:last-child { margin-bottom: 0; }
      #${PANEL_ID} .xp-answer .xp-h { font-weight: 600; margin: 10px 0 6px; }
      #${PANEL_ID} .xp-answer ul,
      #${PANEL_ID} .xp-answer ol { margin: 0 0 8px; padding-left: 20px; }
      #${PANEL_ID} .xp-answer li { margin: 2px 0; }
      #${PANEL_ID} .xp-answer code {
        font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        background: light-dark(rgba(15, 23, 42, 0.07), rgba(255, 255, 255, 0.1));
        border-radius: 5px;
        padding: 1px 5px;
      }
      #${PANEL_ID} .xp-answer pre {
        margin: 8px 0;
        padding: 10px 12px;
        background: light-dark(#f4f5f7, #14151a);
        border: 1px solid light-dark(rgba(15, 23, 42, 0.08), rgba(255, 255, 255, 0.09));
        border-radius: 8px;
        overflow-x: auto;
      }
      #${PANEL_ID} .xp-answer pre code { background: none; padding: 0; }
      #${PANEL_ID} .xp-diagram {
        margin: 8px 0;
        padding: 8px;
        border: 1px solid light-dark(rgba(15, 23, 42, 0.1), rgba(255, 255, 255, 0.12));
        border-radius: 8px;
        background: light-dark(#fbfbfc, #16171c);
        overflow-x: auto;
      }
      #${PANEL_ID} .xp-diagram svg { display: block; max-width: none; height: auto; margin: 0 auto; }
      #${PANEL_ID} .xp-diagram[data-fit="true"] svg { max-width: 100%; }
      #${PANEL_ID} .xp-diagram .xp-node { fill: light-dark(rgba(59, 98, 246, 0.07), rgba(120, 150, 255, 0.14)); }
      #${PANEL_ID} .xp-diagram .xp-edge-label-bg { fill: light-dark(#fbfbfc, #16171c); }
      #${PANEL_ID} .xp-diagram pre { margin: 0; }
      #${PANEL_ID} .xp-diagram-error {
        color: light-dark(#9f1239, #ffb4b4);
        font-size: 12px;
        margin: 4px 0 0;
      }
      #${PANEL_ID} .xp-notice {
        margin: 6px 0 2px;
        font-size: 12px;
        color: light-dark(#6b7280, #9aa0aa);
      }
      #${PANEL_ID} .xp-notice[hidden] { display: none; }
      #${PANEL_ID} .xp-stop { color: light-dark(#9f1239, #ffb4b4); }
      #${PANEL_ID} .xp-stop[hidden] { display: none; }
      #${PANEL_ID} .xp-caret {
        display: inline-block;
        width: 7px;
        height: 14px;
        margin-left: 2px;
        vertical-align: -2px;
        background: currentColor;
        opacity: 0.45;
        animation: xp-blink 1s steps(2, start) infinite;
      }
      @keyframes xp-blink { to { visibility: hidden; } }
      #${PANEL_ID} .xp-status {
        color: light-dark(#6b7280, #9aa0aa);
        font-size: 12.5px;
        margin: 2px 0 10px;
      }
      #${PANEL_ID} .xp-note {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin: 0 0 10px;
        padding: 6px 9px;
        border-radius: 8px;
        background: light-dark(rgba(59, 98, 246, 0.07), rgba(120, 150, 255, 0.1));
        color: light-dark(#3f4a5a, #b9bfc9);
        font-size: 12px;
      }
      #${PANEL_ID} .xp-note[hidden] { display: none; }
      #${PANEL_ID} .xp-note button {
        appearance: none;
        border: 1px solid light-dark(rgba(59, 98, 246, 0.35), rgba(120, 150, 255, 0.45));
        background: transparent;
        color: light-dark(#2f52da, #9db4ff);
        font: inherit;
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 6px;
        cursor: pointer;
      }
      #${PANEL_ID} .xp-error {
        margin: 2px 0 10px;
        padding: 8px 10px;
        border-radius: 8px;
        background: light-dark(rgba(190, 42, 42, 0.08), rgba(255, 120, 120, 0.12));
        color: light-dark(#9f1239, #ffb4b4);
        font-size: 12.5px;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      #${PANEL_ID} .xp-error button {
        appearance: none;
        border: 1px solid light-dark(rgba(159, 18, 57, 0.3), rgba(255, 180, 180, 0.35));
        background: transparent;
        color: inherit;
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 6px;
        cursor: pointer;
      }
      #${PANEL_ID} .xp-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 4px 0 8px;
      }
      #${PANEL_ID} .xp-actions[hidden] { display: none; }
      #${PANEL_ID} .xp-actions button {
        appearance: none;
        border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.14));
        background: light-dark(#fff, #24262c);
        color: light-dark(#374151, #c9cdd4);
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 999px;
        cursor: pointer;
      }
      #${PANEL_ID} .xp-actions button:hover {
        border-color: #3b62f6;
        color: #3b62f6;
      }
      #${PANEL_ID} .xp-foot {
        display: flex;
        gap: 8px;
        align-items: flex-end;
        padding: 10px 12px;
        border-top: 1px solid light-dark(rgba(15, 23, 42, 0.08), rgba(255, 255, 255, 0.1));
        background: light-dark(#fbfbfc, #1f2026);
        flex: 0 0 auto;
      }
      #${PANEL_ID} .xp-input {
        flex: 1 1 auto;
        resize: none;
        min-height: 34px;
        max-height: 120px;
        padding: 8px 10px;
        font: inherit;
        font-size: 13px;
        color: inherit;
        background: light-dark(#fff, #14151a);
        border: 1px solid light-dark(rgba(15, 23, 42, 0.14), rgba(255, 255, 255, 0.14));
        border-radius: 9px;
        outline: none;
      }
      #${PANEL_ID} .xp-input:focus { border-color: #3b62f6; }
      #${PANEL_ID} .xp-send {
        appearance: none;
        border: none;
        background: #3b62f6;
        color: #fff;
        font: inherit;
        font-size: 13px;
        padding: 8px 14px;
        border-radius: 9px;
        cursor: pointer;
      }
      #${PANEL_ID} .xp-send:disabled { opacity: 0.5; cursor: default; }
      #${PANEL_ID} .xp-hint {
        padding: 0 12px 9px;
        font-size: 11px;
        color: light-dark(#9ca3af, #6b7280);
        background: light-dark(#fbfbfc, #1f2026);
        flex: 0 0 auto;
      }
    `;

    // ── markup helpers ────────────────────────────────────────────────────

    /** Escape text for HTML interpolation. */
    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /** Inline formatting on already-escaped text: code, bold. */
    function inline(text) {
      return text
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    }

    /** Sources of the Mermaid blocks in the current answer, by data-diagram id. */
    let diagramSources = [];

    /** Cached dynamic import of the host-served renderer. */
    let rendererPromise;

    /** Load the diagram renderer once, on first use. */
    function loadRenderer() {
      rendererPromise ??= import('/eli5/mermaid-lite.js');
      return rendererPromise;
    }

    /**
     * Swap Mermaid placeholders for SVG diagrams.
     *
     * Runs only after the answer finished streaming, so a half-written diagram
     * is never parsed. A diagram the renderer cannot draw keeps its source and
     * gains a one-line explanation — a broken picture would be worse than none.
     */
    async function hydrateDiagrams() {
      if (els === undefined) return;
      const blocks = [...els.answer.querySelectorAll('.xp-diagram[data-diagram]')];
      if (blocks.length === 0) return;
      let module;
      try {
        module = await loadRenderer();
      } catch {
        return;
      }
      for (const block of blocks) {
        const source = diagramSources[Number(block.dataset.diagram)];
        if (typeof source !== 'string') continue;
        const result = module.renderMermaid(source);
        if (typeof result.svg !== 'string') {
          const note = document.createElement('div');
          note.className = 'xp-diagram-error';
          note.textContent = `图画不出来（${result.error}），上面是原始定义`;
          block.append(note);
          continue;
        }
        block.innerHTML = result.svg;
        // A diagram that is only a little wider than the panel is scaled down
        // instead of forcing the reader to scroll sideways; a very wide one
        // keeps its size, because shrinking it would make the text unreadable.
        const svg = block.querySelector('svg');
        if (svg !== null) {
          const natural = Number(svg.getAttribute('width')) || 0;
          const available = block.clientWidth - 16;
          if (natural > available && available > 0 && available / natural >= 0.72) {
            block.dataset.fit = 'true';
            block.title = '图比浮层宽，已缩小显示';
          }
        }
      }
    }

    /**
     * A deliberately small Markdown renderer: fences, headings, bullet and
     * ordered lists, paragraphs, inline code and bold. Everything is escaped
     * before any tag is added, so a model that echoes markup cannot inject it.
     */
    function renderMarkdown(source) {
      diagramSources = [];
      const lines = String(source).split('\n');
      let html = '';
      let list = null;
      const closeList = () => {
        if (list === null) return;
        html += `<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${list.tag}>`;
        list = null;
      };
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^```/.test(line)) {
          closeList();
          const language = line.slice(3).trim().toLowerCase();
          const code = [];
          index += 1;
          while (index < lines.length && !/^```/.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          if (language === 'mermaid') {
            const source = code.join('\n');
            const id = diagramSources.push(source) - 1;
            // Until the renderer swaps this for an SVG, the reader sees the
            // source: while an answer is still streaming that is the honest
            // thing to show.
            html += `<div class="xp-diagram" data-diagram="${id}"><pre><code>${escapeHtml(source)}</code></pre></div>`;
          } else {
            html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
          }
          continue;
        }
        if (/^\s*$/.test(line)) {
          closeList();
          continue;
        }
        const heading = /^#{1,4}\s+(.*)$/.exec(line);
        if (heading) {
          closeList();
          html += `<div class="xp-h">${inline(escapeHtml(heading[1]))}</div>`;
          continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
          if (list === null || list.tag !== 'ul') {
            closeList();
            list = { tag: 'ul', items: [] };
          }
          list.items.push(inline(escapeHtml(bullet[1])));
          continue;
        }
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ordered) {
          if (list === null || list.tag !== 'ol') {
            closeList();
            list = { tag: 'ol', items: [] };
          }
          list.items.push(inline(escapeHtml(ordered[1])));
          continue;
        }
        closeList();
        html += `<p>${inline(escapeHtml(line))}</p>`;
      }
      closeList();
      return html;
    }

    /** Bind a trusted string as HTML without letting the HTML parser run user text. */
    function setHtml(element, html) {
      element.innerHTML = html;
    }

    // ── state ────────────────────────────────────────────────────────────

    const state = {
      open: false,
      text: '',
      context: '',
      turns: [],
      raw: '',
      busy: false,
      controller: null,
      runId: 0,
      raf: 0,
      model: '',
      error: '',
      notice: '',
      useContext: true,
      trace: [],
      tools: false,
      sessionId: '',
    };

    /** @type {{chip: HTMLElement, panel: HTMLElement, quote: HTMLElement, answer: HTMLElement, status: HTMLElement, actions: HTMLElement, input: HTMLTextAreaElement, send: HTMLButtonElement, copy: HTMLButtonElement, model: HTMLElement, body: HTMLElement} | undefined} */
    let els;
    let pending = undefined;
    let installed = false;
    /** The client context, kept only to ask the session store which session is open. */
    let clientCtx;

    // ── DOM construction ─────────────────────────────────────────────────

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.dataset.pluginCss = 'dsh-eli5';
      style.textContent = CSS;
      document.head.append(style);
    }

    function buildChip() {
      const chip = document.createElement('button');
      chip.id = CHIP_ID;
      chip.type = 'button';
      chip.title = '用大白话讲讲这段（Ctrl+Shift+E）';
      chip.innerHTML = '<span class="xp-chip-mark">✦</span><span>解释</span>';
      chip.addEventListener('pointerdown', (event) => {
        // Keep the selection alive: a plain click would collapse it before the
        // handler reads the text we captured when the chip appeared.
        event.preventDefault();
        event.stopPropagation();
      });
      chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const captured = pending;
        hideChip();
        if (captured !== undefined) open(captured.text, captured.context);
      });
      return chip;
    }

    function buildPanel() {
      const panel = document.createElement('aside');
      panel.id = PANEL_ID;
      panel.hidden = true;
      panel.setAttribute('aria-label', LABELS.title);
      panel.innerHTML = `
        <div class="xp-head">
          <span class="xp-mark">✦</span>
          <span class="xp-title">${LABELS.title}</span>
          <span class="xp-model"></span>
          <span class="xp-spacer"></span>
          <button class="xp-btn xp-ctx" type="button"></button>
          <button class="xp-btn xp-stop" type="button" hidden>${LABELS.stop}</button>
          <button class="xp-btn xp-copy" type="button">${LABELS.copy}</button>
          <button class="xp-btn xp-close" type="button" title="${LABELS.close}（Esc）">✕</button>
        </div>
        <div class="xp-body">
          <blockquote class="xp-quote"></blockquote>
          <div class="xp-status"></div>
          <div class="xp-note" hidden></div>
          <details class="xp-trace" hidden></details>
          <div class="xp-answer"></div>
          <div class="xp-notice" hidden></div>
          <div class="xp-actions" hidden></div>
        </div>
        <div class="xp-foot">
          <textarea class="xp-input" rows="1" placeholder="${LABELS.placeholder}"></textarea>
          <button class="xp-send" type="button">${LABELS.send}</button>
        </div>
        <div class="xp-hint">${LABELS.hint}</div>
      `;

      panel.querySelector('.xp-close').addEventListener('click', close);
      panel.querySelector('.xp-copy').addEventListener('click', () => {
        if (state.raw.trim() === '') return;
        copyText(state.raw);
        const button = panel.querySelector('.xp-copy');
        button.textContent = LABELS.copied;
        setTimeout(() => {
          button.textContent = LABELS.copy;
        }, 1400);
      });

      panel.querySelector('.xp-stop').addEventListener('click', () => {
        if (!state.busy) return;
        state.notice = LABELS.stopped;
        if (state.controller !== null) state.controller.abort();
        paint();
      });

      panel.querySelector('.xp-ctx').addEventListener('click', () => {
        state.useContext = !state.useContext;
        writeContextPreference(state.useContext);
        renderContextToggle();
        // Toggling is a preference, not a request: re-asking costs a whole
        // explanation and silently throws away the answer being read. Offer the
        // re-run instead of doing it.
        if (state.raw.trim() !== '' && !state.busy) showContextNote();
      });

      const input = panel.querySelector('.xp-input');
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitQuestion();
        } else if (event.key === 'Escape') {
          close();
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(120, input.scrollHeight)}px`;
      });
      panel.querySelector('.xp-send').addEventListener('click', submitQuestion);

      return panel;
    }

    function collect(panel) {
      els = {
        chip: document.getElementById(CHIP_ID),
        panel,
        body: panel.querySelector('.xp-body'),
        quote: panel.querySelector('.xp-quote'),
        answer: panel.querySelector('.xp-answer'),
        notice: panel.querySelector('.xp-notice'),
        stop: panel.querySelector('.xp-stop'),
        status: panel.querySelector('.xp-status'),
        note: panel.querySelector('.xp-note'),
        trace: panel.querySelector('.xp-trace'),
        actions: panel.querySelector('.xp-actions'),
        input: panel.querySelector('.xp-input'),
        send: panel.querySelector('.xp-send'),
        copy: panel.querySelector('.xp-copy'),
        ctx: panel.querySelector('.xp-ctx'),
        model: panel.querySelector('.xp-model'),
      };
    }

    function copyText(text) {
      try {
        void navigator.clipboard.writeText(text);
      } catch {
        // Clipboard permission is not worth a dialog: the text is selectable.
      }
    }

    // ── context preference ───────────────────────────────────────────────

    const CONTEXT_PREF_KEY = 'dsh-eli5:use-context';

    /** Read the remembered "send context with this explanation" preference. */
    function readContextPreference() {
      try {
        return window.localStorage.getItem(CONTEXT_PREF_KEY) !== 'off';
      } catch {
        return true;
      }
    }

    /** Remember the preference; storage may be unavailable in private modes. */
    function writeContextPreference(value) {
      try {
        window.localStorage.setItem(CONTEXT_PREF_KEY, value ? 'on' : 'off');
      } catch {
        // A blocked storage only costs the preference across reloads.
      }
    }

    function renderContextToggle() {
      if (els === undefined) return;
      els.ctx.textContent = state.useContext ? LABELS.ctxOn : LABELS.ctxOff;
      els.ctx.title = `${LABELS.ctxHint}${state.useContext ? '' : '（当前只解释词本身）'}`;
      els.ctx.dataset.on = state.useContext ? 'true' : 'false';
      els.ctx.setAttribute('aria-pressed', state.useContext ? 'true' : 'false');
    }

    // ── selection detection ──────────────────────────────────────────────

    /** The element a range starts in, or `undefined` for a detached range. */
    function elementOf(node) {
      if (node === null || node === undefined) return undefined;
      return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement ?? undefined;
    }

    /** Read a sentence of surrounding text so the model knows where this came from. */
    function surroundingText(element, selection) {
      let node = element;
      let best = '';
      for (let depth = 0; depth < 6 && node !== null; depth += 1, node = node.parentElement) {
        const inner = (node.innerText ?? '').trim();
        if (inner.length === 0) continue;
        if (inner.length <= selection.length + 40) continue;
        if (inner.length > 6000) break;
        best = inner;
      }
      return best.length > 3000 ? best.slice(0, 3000) : best;
    }

    /**
     * The scroll pane holding the conversation the reader is looking at.
     *
     * The nearest scrollable ancestor is the conversation body; `document.body`
     * is the fallback for pages that do not scroll an inner pane (the welcome
     * screen, for instance).
     *
     * @param range - the current selection.
     * @returns the pane, or `undefined` when the selection sits inside our own UI.
     */
    function readingPane(range) {
      const start = elementOf(range.startContainer);
      if (start === undefined) return undefined;
      if (start.closest(`#${PANEL_ID}, #${CHIP_ID}`) !== null) return undefined;
      // The conversation owns a marked scrollport. Using it keeps sidebars, tool
      // cards and the composer out of the excerpt.
      const scrollport = start.closest('[data-conversation-scroll]');
      if (scrollport !== null) return scrollport;
      let node = start;
      for (let depth = 0; depth < 14 && node !== null && node !== document.body; depth += 1, node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 40) {
          return node;
        }
      }
      return document.body;
    }

    /**
     * The conversation text around the selection, as rendered.
     *
     * This is what gives the explanation its footing: a word like "agent" means
     * something different in a conversation about the reader's own runtime than
     * it does in a generic one, and the definition may sit a few messages above
     * the word. Only text already on screen is read — no Session store, no
     * history files — so the excerpt says exactly what the reader could see.
     *
     * @param range - the selection.
     * @param selection - the selected text, used when the range cannot be mapped.
     * @param limit - character budget for the whole excerpt.
     * @returns the excerpt, or `''` when nothing could be read.
     */
    function conversationExcerpt(range, selection, limit) {
      const pane = readingPane(range);
      if (pane === undefined) return '';
      const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent === null) return NodeFilter.FILTER_REJECT;
          if (parent.closest(`#${PANEL_ID}, #${CHIP_ID}`) !== null) return NodeFilter.FILTER_REJECT;
          if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return (node.nodeValue ?? '').trim() === '' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
        },
      });
      let text = '';
      let start = -1;
      let end = -1;
      let lastParent;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.parentElement !== lastParent && text !== '' && !text.endsWith('\n')) text += '\n';
        lastParent = node.parentElement;
        if (node === range.startContainer) start = text.length + range.startOffset;
        if (node === range.endContainer) end = text.length + range.endOffset;
        text += node.nodeValue ?? '';
      }
      if (text.trim() === '') return '';
      if (start < 0) start = Math.max(0, text.indexOf(selection));
      if (start < 0) start = 0;
      if (end < 0) end = Math.min(text.length, start + selection.length);
      const before = Math.max(0, start - Math.floor(limit * 0.8));
      const after = Math.min(text.length, end + Math.floor(limit * 0.2));
      const excerpt = text.slice(before, after).trim();
      return excerpt.length > limit ? excerpt.slice(excerpt.length - limit) : excerpt;
    }

    /** The current selection, when it looks like something the reader is reading. */
    function currentSelection() {
      const selection = document.getSelection();
      if (selection === null || selection === undefined || selection.isCollapsed || selection.rangeCount === 0) {
        return undefined;
      }
      const text = selection.toString().trim();
      if (text.length < 2 || text.length > MAX_SELECTED_CHARS) return undefined;
      const range = selection.getRangeAt(0);
      const element = elementOf(range.startContainer);
      if (element === undefined) return undefined;
      if (element.closest(`#${PANEL_ID}, #${CHIP_ID}`) !== null) return undefined;
      if (element.closest('textarea, input, [contenteditable="true"], [contenteditable=""]') !== null) return undefined;
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (rect === undefined || (rect.width === 0 && rect.height === 0)) return undefined;
      const context = conversationExcerpt(range, text, 3500) || surroundingText(element, text);
      return { text, rect, context };
    }

    function showChip(found) {
      pending = { text: found.text, context: found.context };
      const chip = els.chip;
      chip.style.display = 'inline-flex';
      chip.style.visibility = 'hidden';
      const width = chip.offsetWidth || 76;
      const maxLeft = window.innerWidth - width - 8;
      const left = Math.max(8, Math.min(maxLeft, found.rect.right - width / 2));
      const below = found.rect.bottom + 8;
      const top = below + 34 > window.innerHeight ? Math.max(8, found.rect.top - 36) : below;
      chip.style.left = `${Math.round(left)}px`;
      chip.style.top = `${Math.round(top)}px`;
      chip.style.visibility = 'visible';
    }

    function hideChip() {
      if (els === undefined) return;
      els.chip.style.display = 'none';
      pending = undefined;
    }

    /**
     * Session id of the conversation the reader is looking at.
     *
     * The host needs it for one thing: resolving that conversation's working
     * directory so read-only tools cannot read outside it. It is read from the
     * client's own session store (never written), and an empty value simply
     * means the panel answers without file access.
     *
     * @returns the current session id, or `''` when it cannot be resolved.
     */
    function resolveSessionId() {
      try {
        const sessions = clientCtx?.get?.('sessions');
        const list = sessions?.list;
        const snapshot =
          typeof list?.getSnapshot === 'function'
            ? list.getSnapshot()
            : typeof list?.get === 'function'
              ? list.get()
              : undefined;
        const current = snapshot?.current;
        return typeof current === 'string' ? current : '';
      } catch {
        return '';
      }
    }

    // ── panel ────────────────────────────────────────────────────────────

    function setStatus(text) {
      els.status.textContent = text;
      els.status.style.display = text === '' ? 'none' : 'block';
    }

    /**
     * Offer a re-run after the context preference changed.
     *
     * The button re-asks the last question with the new setting; nothing
     * happens until the reader clicks it.
     */
    function showContextNote() {
      const note = els.note;
      if (note === undefined) return;
      note.hidden = false;
      note.textContent = '';
      const text = document.createElement('span');
      text.textContent = state.useContext ? LABELS.ctxOnPending : LABELS.ctxOffPending;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = LABELS.reask;
      button.addEventListener('click', () => {
        hideContextNote();
        const first = state.turns.find((turn) => turn.role === 'user');
        const question = first === undefined || first.content === '解释这段' ? '' : first.content;
        // Re-answering is a fresh explanation, not a follow-up: drop the old
        // panel history so the request does not accumulate duplicates.
        state.turns = [];
        state.trace = [];
        renderTrace();
        state.error = '';
        renderError();
        void ask(question);
      });
      note.append(text, button);
    }

    /** Hide the re-run offer. */
    function hideContextNote() {
      if (els?.note === undefined) return;
      els.note.hidden = true;
      els.note.textContent = '';
    }

    /** Short label for one tool name, as shown in the reading trace. */
    function toolLabel(name) {
      if (name === 'read_file') return '读';
      if (name === 'grep') return '搜';
      if (name === 'glob') return '列';
      return name;
    }

    /**
     * Paint the reading trace.
     *
     * The trace exists so the reader can tell "it looked at the code" from "it
     * guessed": every read the panel performed is a line here, with its path and
     * line range, clickable to collapse. Nothing in it is required to read the
     * answer — it is the receipt for the extra seconds the request took.
     */
    function renderTrace() {
      const box = els.trace;
      if (box === undefined) return;
      if (state.trace.length === 0) {
        box.hidden = true;
        box.textContent = '';
        return;
      }
      const ok = state.trace.filter((entry) => entry.ok === true).length;
      const wasOpen = state.trace.length === 1 ? true : box.open;
      box.hidden = false;
      const head = state.tools
        ? `${LABELS.traceTitle} · ${ok} 次成功${state.trace.length > ok ? ` · ${state.trace.length - ok} 次失败` : ''}`
        : LABELS.traceTitle;
      const items = state.trace
        .map(
          (entry) =>
            `<li data-ok="${entry.ok === true ? 'true' : 'false'}"><span class="xp-tool">${escapeHtml(toolLabel(entry.tool))}</span>${escapeHtml(String(entry.target ?? ''))}${entry.ms > 0 ? ` <span style="opacity:.55">${Math.round(entry.ms)}ms</span>` : ''}</li>`,
        )
        .join('');
      box.innerHTML = `<summary>${escapeHtml(head)}</summary><ul>${items}</ul>`;
      box.open = wasOpen;
    }

    function setError(message) {
      state.error = message;
      renderError();
    }

    function renderError() {
      const existing = els.body.querySelector('.xp-error');
      if (existing !== null) existing.remove();
      if (state.error === '') return;
      const box = document.createElement('div');
      box.className = 'xp-error';
      const text = document.createElement('span');
      text.textContent = state.error;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = LABELS.retry;
      retry.addEventListener('click', () => {
        state.error = '';
        renderError();
        void ask(state.turns.length === 0 ? '' : state.turns[state.turns.length - 1].role === 'user' ? state.turns[state.turns.length - 1].content : '');
      });
      box.append(text, retry);
      els.body.insertBefore(box, els.answer);
    }

    function paint() {
      state.raf = 0;
      setHtml(
        els.answer,
        state.raw === '' ? '' : renderMarkdown(state.raw),
      );
      if (state.busy && state.raw === '') {
        setStatus(LABELS.thinking);
      } else if (!state.busy && state.raw === '') {
        setStatus(state.error === '' && state.notice === '' ? LABELS.empty : '');
      } else {
        setStatus('');
      }
      if (state.busy) {
        const caret = document.createElement('span');
        caret.className = 'xp-caret';
        els.answer.append(caret);
      } else if (state.raw.includes('```mermaid')) {
        void hydrateDiagrams();
      }
      const body = els.body;
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 96;
      if (nearBottom) body.scrollTop = body.scrollHeight;
      els.send.disabled = state.busy;
      if (els.notice !== undefined) {
        els.notice.textContent = state.notice;
        els.notice.hidden = state.notice === '';
      }
      if (els.stop !== undefined) els.stop.hidden = !state.busy;
    }

    function schedulePaint() {
      if (state.raf !== 0) return;
      state.raf = window.requestAnimationFrame(paint);
    }

    function renderQuickActions() {
      if (state.busy || state.raw.trim() === '') {
        els.actions.hidden = true;
        return;
      }
      els.actions.hidden = false;
      els.actions.textContent = '';
      for (const label of LABELS.quick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          els.input.value = label;
          submitQuestion();
        });
        els.actions.append(button);
      }
    }

    function setModel(model) {
      state.model = model;
      els.model.textContent = model;
      els.model.title = model === '' ? '' : `由 ${model} 解释`;
    }

    function open(text, context) {
      if (els === undefined) return;
      state.open = true;
      state.text = text;
      state.context = context ?? '';
      state.sessionId = resolveSessionId();
      state.turns = [];
      state.trace = [];
      state.raw = '';
      state.busy = false;
      state.error = '';
      state.notice = '';
      state.runId += 1;
      if (state.controller !== null) state.controller.abort();
      state.controller = null;
      els.quote.textContent = text.length > 320 ? `${text.slice(0, 320)}…` : text;
      els.panel.hidden = false;
      els.input.value = '';
      els.actions.hidden = true;
      renderTrace();
      hideContextNote();
      setError('');
      paint();
      void ask('');
    }

    function close() {
      if (els === undefined) return;
      state.open = false;
      state.runId += 1;
      if (state.controller !== null) {
        state.controller.abort();
        state.controller = null;
      }
      state.busy = false;
      els.panel.hidden = true;
      hideChip();
    }

    function submitQuestion() {
      if (!state.open || state.busy) return;
      const question = els.input.value.trim();
      if (question === '') {
        els.input.focus();
        return;
      }
      els.input.value = '';
      els.input.style.height = 'auto';
      els.actions.hidden = true;
      void ask(question);
    }

    /** Strip the endpoint's JSON error envelope into a readable line. */
    async function readFailure(response) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body !== null && typeof body === 'object' && typeof body.error === 'string') detail = body.error;
      } catch {
        // A non-JSON failure keeps the status line.
      }
      return detail;
    }

    /**
     * Apply one SSE frame from the host.
     *
     * Events: `meta` (route + whether tools are mounted), `text` (answer
     * fragment), `trace` (one tool call), `done`, `error`.
     *
     * @param frame - one frame's text, without the blank-line terminator.
     * @returns an error message to abort with, or `''` to continue.
     */
    function handleFrame(frame) {
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) return '';
      let payload;
      try {
        payload = JSON.parse(data.join('\n'));
      } catch {
        return '';
      }
      if (event === 'meta') {
        if (typeof payload.model === 'string' && payload.model !== '') setModel(payload.model);
        state.tools = payload.tools === true;
        if (payload.cached === true) {
          state.notice = LABELS.cached;
          schedulePaint();
        }
      } else if (event === 'text') {
        if (typeof payload.text === 'string' && payload.text !== '') {
          state.raw += payload.text;
          schedulePaint();
        }
      } else if (event === 'trace') {
        state.trace.push(payload);
        renderTrace();
      } else if (event === 'notice') {
        if (typeof payload.text === 'string' && payload.text !== '') {
          state.notice = payload.text;
          schedulePaint();
        }
      } else if (event === 'error') {
        return typeof payload.message === 'string' ? payload.message : '解释失败';
      }
      return '';
    }

    /**
     * Ask the host for one explanation and stream it into the panel.
     *
     * @param question - follow-up text, or `''` for the first explanation.
     */
    async function ask(question) {
      if (state.busy) return;
      const runId = ++state.runId;
      const controller = new AbortController();
      state.controller = controller;
      state.busy = true;
      state.raw = '';
      state.error = '';
      state.notice = '';
      state.trace = [];
      renderTrace();
      hideContextNote();
      renderError();
      els.send.disabled = true;
      setStatus(LABELS.thinking);
      schedulePaint();

      const payload = {
        text: state.text,
        context: state.useContext ? state.context : '',
        question,
        history: state.turns.slice(-8),
        sessionId: state.sessionId,
      };

      try {
        const response = await fetch(ASK_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream, text/plain' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (runId !== state.runId) return;
        if (!response.ok) throw new Error(await readFailure(response));
        if (response.body === null) throw new Error('这个浏览器不支持流式响应');
        const header = response.headers.get('x-eli5-model');
        if (header !== null && header !== '') setModel(header);

        // A host that predates the SSE protocol still answers text/plain. Keep
        // working across the restart window instead of showing an empty panel.
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
          state.raw = await response.text();
          if (state.raw.trim() === '') throw new Error('模型返回了空解释，换个问法试试');
          state.turns.push({ role: 'user', content: question === '' ? '解释这段' : question });
          state.turns.push({ role: 'assistant', content: state.raw });
          if (state.turns.length > 8) state.turns = state.turns.slice(-8);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finished = false;
        let failure = '';
        while (!finished && failure === '') {
          const chunk = await reader.read();
          finished = chunk.done;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (finished) buffer += decoder.decode();
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            failure = handleFrame(frame);
            if (failure !== '') break;
            boundary = buffer.indexOf('\n\n');
          }
        }
        if (failure !== '') throw new Error(failure);
        if (state.raw.trim() === '') throw new Error('模型返回了空解释，换个问法试试');
        state.turns.push({ role: 'user', content: question === '' ? '解释这段' : question });
        state.turns.push({ role: 'assistant', content: state.raw });
        if (state.turns.length > 8) state.turns = state.turns.slice(-8);
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
        if (runId !== state.runId) return;
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (runId === state.runId) {
          state.busy = false;
          state.controller = null;
          paint();
          renderQuickActions();
          if (state.raw.trim() !== '') state.error = '';
        }
      }
    }

    // ── events ───────────────────────────────────────────────────────────

    function onMouseUp(event) {
      if (els === undefined) return;
      const target = event.target;
      if (target instanceof Element && target.closest(`#${PANEL_ID}, #${CHIP_ID}`) !== null) return;
      // Let the browser settle the selection before reading it.
      window.setTimeout(() => {
        const found = currentSelection();
        if (found === undefined) hideChip();
        else showChip(found);
      }, 0);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && state.open) {
        event.stopPropagation();
        close();
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        const found = currentSelection();
        if (found === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        hideChip();
        open(found.text, found.context);
      }
    }

    function onScroll() {
      if (state.open) return;
      hideChip();
    }

    function install() {
      if (installed) return;
      installed = true;
      state.useContext = readContextPreference();
      ensureStyle();
      const chip = buildChip();
      const panel = buildPanel();
      document.body.append(chip, panel);
      collect(panel);
      renderContextToggle();
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScroll, true);
      document.addEventListener('selectionchange', () => {
        if (state.open) return;
        const selection = document.getSelection();
        if (selection === null || selection.isCollapsed) hideChip();
      });
      void fetch(HEALTH_ENDPOINT, { headers: { accept: 'application/json' } })
        .then(async (response) => (response.ok ? response.json() : undefined))
        .then((body) => {
          if (body !== undefined && body.ok === true && typeof body.model === 'string') setModel(body.model);
        })
        .catch(() => {
          // A missing host route only costs the model badge.
        });
      // A debug handle: open the panel without a selection (useful from the
      // browser console and for the plugin's own end-to-end check).
      window.__dshEli5 = {
        version: VERSION,
        open: (text, context) => open(String(text), typeof context === 'string' ? context : ''),
        close,
      };
    }

    function uninstall() {
      if (!installed) return;
      installed = false;
      if (state.controller !== null) state.controller.abort();
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      document.getElementById(CHIP_ID)?.remove();
      document.getElementById(PANEL_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      els = undefined;
      pending = undefined;
      state.open = false;
      state.busy = false;
      delete window.__dshEli5;
    }

    /** Mount the browser half. */
    function apply(ctx) {
      clientCtx = ctx;
      ctx.effect(() => {
        if (document.body === null) {
          document.addEventListener('DOMContentLoaded', install, { once: true });
          return () => document.removeEventListener('DOMContentLoaded', install);
        }
        install();
        return uninstall;
      }, 'dsh-eli5: selection panel');
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
