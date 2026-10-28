/**
 * dsh-eli5 — read-only workspace tools.
 *
 * The panel may spend a few calls looking at the workspace before it explains:
 * a term in a conversation is often defined in the code the conversation is
 * about, and a model asked to explain `retryPolicy` without the file will
 * describe the generic idea instead of this repository's. That reading is part
 * of *explaining*, not part of the task, so it happens inside the panel's own
 * auxiliary call — never in the Agent loop, never in a Session.
 *
 * What the model may do is deliberately narrow:
 *
 *   read_file(path, startLine?, endLine?)   numbered lines of one text file
 *   grep(pattern, glob?, maxResults?)       matching lines, path:line:text
 *   glob(pattern)                           workspace-relative paths
 *
 * There is no write, no shell, no network. Every path is resolved against the
 * conversation's working directory and refused when it escapes it (including
 * through a symlink), and every result is capped so one bad call cannot blow up
 * the request. The service owns the *budget* (rounds, calls, bytes, time); this
 * module owns the *boundary*.
 *
 * @module dsh-eli5/tools
 */

import { realpathSync } from 'node:fs';
import { open, readdir, readFile as readText, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Tool schemas handed to the model, in the order it sees them. */
export const TOOL_SCHEMAS = Object.freeze([
  {
    name: 'read_file',
    description:
      '读取工作区里的一个文本文件，返回带行号的内容。仅在该文件确实能澄清读者的问题时使用；一次最多 400 行。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的路径，例如 internal/worker/retry.go' },
        startLine: { type: 'integer', description: '起始行（从 1 开始，可省略）' },
        endLine: { type: 'integer', description: '结束行（含，可省略；省略时从 startLine 起最多 400 行）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description:
      '在工作区里按正则搜索文本，返回 路径:行号:内容。适合先定位再读；默认最多 40 条、跳过依赖与构建目录。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则表达式（不区分大小写）' },
        glob: { type: 'string', description: '只搜索匹配该 glob 的文件，例如 **/*.go' },
        maxResults: { type: 'integer', description: '最多返回多少条（默认 40，上限 80）' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description: '按 glob 列出工作区里的文件路径（最多 100 条），用来确认某个文件是否存在。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '例如 internal/**/*.go 或 README.md' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
]);

/** Directory names never walked (dependency trees, VCS internals, caches). */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'target',
  '.idea',
  '.pytest_cache',
  '.mypy_cache',
]);

/** Files that stay unreadable even inside the workspace. */
const DENY_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)|[^/]+\.(pem|key|p12|pfx|keystore))$/i;

/** Largest text file the tools will open. */
const MAX_FILE_BYTES = 256 * 1024;

/** Bytes sniffed to decide whether a file is text. */
const SNIFF_BYTES = 4096;

/** Walk caps: enough for a real repository, small enough to stay quick. */
const MAX_WALK_ENTRIES = 20_000;

/** Files one `grep` call may open before it gives up. */
const MAX_GREP_FILES = 800;

/** Bytes one `grep` call may scan before it gives up. */
const MAX_GREP_BYTES = 8 * 1024 * 1024;

/** A refused or failed tool call, reported back to the model as text. */
export class ToolError extends Error {
  /**
   * @param message - human-readable reason, shown to the model.
   * @param code - stable machine tag for the trace line.
   */
  constructor(message, code) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** Escape one literal path segment for a regular expression. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a small glob into a regular expression over `/`-separated paths.
 *
 * Supported: `**` (any depth, including none), `*` (within a segment), `?`
 * (one character). Anything else is literal. That is the subset the tool
 * descriptions promise and enough for a two-star suffix like `*.ts` or a
 * directory prefix that stars out.
 *
 * @param pattern - glob as written by the model.
 * @returns a matcher over workspace-relative paths.
 */
export function globToRegExp(pattern) {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        out += '(?:[^/]+/)*';
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(char);
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when a file name is unreadable by policy. */
function denied(relPath) {
  return DENY_FILE.test(relPath.split(sep).join('/'));
}

/** Read at most `bytes` from the head of a file. */
async function readHead(absolute, bytes) {
  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Cheap binary probe: a NUL byte in the first few KiB means "not text". */
function looksBinary(buffer) {
  return buffer.includes(0);
}

/**
 * The sandboxed reader handed to one explanation.
 *
 * One instance per request: it carries the conversation root, the byte budget
 * already spent, and nothing else. It never writes and never leaves `root`.
 */
export class WorkspaceReader {
  /**
   * @param root - absolute working directory of the conversation.
   * @param limits - `{maxBytes, maxFileLines, maxGrepResults, maxGlobResults}`.
   */
  constructor(root, limits) {
    this.root = resolve(root);
    this.limits = limits;
    this.spentBytes = 0;
    /** Set by `resolve()` so a symlinked root still compares like-for-like. */
    this.realRoot = undefined;
  }

  /** Resolve the real root once, so symlinked workspaces are not rejected. */
  async rootReal() {
    if (this.realRoot === undefined) {
      try {
        this.realRoot = await realpath(this.root);
      } catch {
        throw new ToolError(`工作目录不存在：${this.root}`, 'ENOENT');
      }
    }
    return this.realRoot;
  }

  /**
   * Turn a model-supplied path into an absolute path inside the workspace.
   *
   * Both the lexical path and (when it exists) its real path must stay under
   * the root, so `../` and a symlink pointing outside are both refused.
   *
   * @param requested - path as the model wrote it.
   * @returns the absolute path to read.
   */
  async resolvePath(requested) {
    if (typeof requested !== 'string' || requested.trim() === '') {
      throw new ToolError('缺少 path', 'BAD_ARGUMENT');
    }
    const root = await this.rootReal();
    const absolute = resolve(root, isAbsolute(requested) ? requested : join(root, requested));
    const within = (base, candidate) => candidate === base || candidate.startsWith(base + sep);
    if (!within(root, absolute)) {
      throw new ToolError(`路径在工作区之外：${requested}`, 'OUTSIDE_WORKSPACE');
    }
    let real = absolute;
    try {
      real = realpathSync(absolute);
    } catch {
      // A missing file keeps the lexical path; the caller reports ENOENT.
    }
    if (!within(root, real)) {
      throw new ToolError(`路径经符号链接指到了工作区之外：${requested}`, 'OUTSIDE_WORKSPACE');
    }
    if (denied(relative(root, real).split(sep).join('/'))) {
      throw new ToolError(`这类文件不开放读取：${requested}`, 'DENIED');
    }
    return real;
  }

  /** Charge `bytes` against the request's read budget. */
  charge(bytes) {
    this.spentBytes += bytes;
    if (this.spentBytes > this.limits.maxBytes) {
      throw new ToolError(`本次解释读取的内容超过预算（${this.limits.maxBytes} 字节）`, 'BUDGET_BYTES');
    }
  }

  /**
   * Walk the workspace, yielding `{absolute, relative}` for regular files.
   *
   * Skipped: dependency/cache directories, dot-directories other than a few the
   * model may legitimately need is not a thing here, symlinks, and files above
   * the per-file cap. The walk stops at {@link MAX_WALK_ENTRIES}.
   *
   * @returns async generator of files.
   */
  async *walk() {
    const root = await this.rootReal();
    const queue = [''];
    let seen = 0;
    while (queue.length > 0) {
      const current = queue.pop();
      let entries;
      try {
        entries = await readdir(join(root, current), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++seen > MAX_WALK_ENTRIES) return;
        const rel = current === '' ? entry.name : `${current}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || denied(rel)) continue;
          queue.push(rel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (denied(rel)) continue;
        yield { absolute: join(root, rel), relative: rel };
      }
    }
  }

  /**
   * `read_file`: numbered lines inside a byte budget.
   *
   * @param args - `{path, startLine?, endLine?}`.
   * @returns text the model can cite as `path:start-end`.
   */
  async readFile(args) {
    const absolute = await this.resolvePath(args.path);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`文件不存在：${args.path}`, 'ENOENT');
    }
    if (!info.isFile()) throw new ToolError(`不是普通文件：${args.path}`, 'NOT_A_FILE');
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError(
        `文件太大（${Math.round(info.size / 1024)}KB），请用 grep 定位后用 startLine/endLine 读局部`,
        'FILE_TOO_LARGE',
      );
    }
    const head = await readHead(absolute, Math.min(SNIFF_BYTES, info.size));
    if (looksBinary(head)) throw new ToolError(`看起来是二进制文件：${args.path}`, 'BINARY');

    let text;
    try {
      text = await readText(absolute, 'utf8');
    } catch {
      throw new ToolError(`读不了这个文件：${args.path}`, 'READ_FAILED');
    }
    this.charge(Buffer.byteLength(text, 'utf8'));

    const lines = text.split('\n');
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const start = clampLine(args.startLine, 1, total);
    const maxLines = this.limits.maxFileLines ?? 400;
    const requestedEnd = args.endLine === undefined ? total : clampLine(args.endLine, start, total);
    const end = Math.min(requestedEnd, start + maxLines - 1);
    const relative = await this.relativeOf(absolute);
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(width, ' ')}| ${line}`)
      .join('\n');
    const suffix = end < total ? `\n\n（共 ${total} 行，只给了 ${start}-${end}；需要更多请带 startLine/endLine 再读）` : '';
    return `【${relative}:${start}-${end}】\n${body}${suffix}`;
  }

  /**
   * `glob`: workspace-relative paths matching one pattern.
   *
   * @param args - `{pattern}`.
   * @returns newline-separated relative paths.
   */
  async glob(args) {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (pattern === '') throw new ToolError('缺少 pattern', 'BAD_ARGUMENT');
    const matcher = globToRegExp(pattern.replace(/^\.\//, ''));
    const found = [];
    for await (const file of this.walk()) {
      if (!matcher.test(file.relative)) continue;
      found.push(file.relative);
      if (found.length >= this.limits.maxGlobResults) break;
    }
    if (found.length === 0) return `没有文件匹配 ${pattern}`;
    found.sort();
    return `${found.join('\n')}\n\n（${found.length} 个${found.length >= this.limits.maxGlobResults ? '，已截断' : ''}）`;
  }

  /**
   * `grep`: matching lines, one `path:line:text` per hit.
   *
   * The pattern is a JavaScript regular expression with the `i` flag; an
   * invalid one is reported to the model instead of thrown out of the request.
   *
   * @param args - `{pattern, glob?, maxResults?}`.
   * @returns matching lines, capped.
   */
  async grep(args) {
    const source = typeof args.pattern === 'string' ? args.pattern : '';
    if (source.trim() === '') throw new ToolError('缺少 pattern', 'BAD_ARGUMENT');
    let matcher;
    try {
      matcher = new RegExp(source, 'i');
    } catch (error) {
      throw new ToolError(`正则写错了：${error instanceof Error ? error.message : String(error)}`, 'BAD_PATTERN');
    }
    const fileFilter =
      typeof args.glob === 'string' && args.glob.trim() !== '' ? globToRegExp(args.glob.trim()) : undefined;
    const limit = Math.max(1, Math.min(args.maxResults ?? this.limits.maxGrepResults, 80));
    const hits = [];
    // Searching is IO, not context: it gets its own scan budget so a large
    // repository does not eat the byte budget that `read_file` answers with.
    let scannedBytes = 0;
    let scannedFiles = 0;
    for await (const file of this.walk()) {
      if (fileFilter !== undefined && !fileFilter.test(file.relative)) continue;
      if (++scannedFiles > MAX_GREP_FILES) {
        hits.push(`（已扫描 ${MAX_GREP_FILES} 个文件，搜索提前结束；请用更具体的 glob 缩小范围）`);
        break;
      }
      let head;
      try {
        const info = await stat(file.absolute);
        if (info.size > MAX_FILE_BYTES) continue;
        head = await readHead(file.absolute, Math.min(SNIFF_BYTES, info.size));
      } catch {
        continue;
      }
      if (looksBinary(head)) continue;
      let text;
      try {
        text = await readText(file.absolute, 'utf8');
      } catch {
        continue;
      }
      scannedBytes += Buffer.byteLength(text, 'utf8');
      if (scannedBytes > MAX_GREP_BYTES) {
        hits.push('（已扫描的内容超过上限，搜索提前结束；请用更具体的 glob 缩小范围）');
        break;
      }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index])) continue;
        const line = lines[index].trim();
        hits.push(`${file.relative}:${index + 1}: ${line.length > 240 ? `${line.slice(0, 240)}…` : line}`);
        if (hits.length >= limit) break;
      }
      if (hits.length >= limit) break;
    }
    if (hits.length === 0) return `没有匹配 /${source}/ 的行`;
    return `${hits.join('\n')}\n\n（${hits.length} 条${hits.length >= limit ? '，已截断' : ''}）`;
  }

  /** Path of `absolute` relative to the real root, for display. */
  async relativeOf(absolute) {
    const root = await this.rootReal();
    const rel = relative(root, absolute);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
}

/** Clamp one optional 1-based line number into `[min, max]`, defaulting to `min`. */
function clampLine(value, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * The dispatch table: tool name → method on {@link WorkspaceReader}.
 *
 * The service checks the name against this map before executing, so a model
 * cannot reach anything that is not listed here.
 */
export const TOOL_HANDLERS = Object.freeze({
  read_file: (reader, args) => reader.readFile(args),
  grep: (reader, args) => reader.grep(args),
  glob: (reader, args) => reader.glob(args),
});
