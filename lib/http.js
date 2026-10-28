/**
 * dsh-eli5 — same-origin HTTP routes.
 *
 * The browser half cannot call the LLM service directly, so the host exposes two
 * exact routes on the Web GUI's own server:
 *
 *   GET  /eli5/health   which route would answer, or why none can
 *   POST /eli5/ask      stream one explanation as Server-Sent Events
 *
 * `ask` speaks SSE rather than plain text because the panel shows two different
 * streams: the answer, and the reading trace ("已读 internal/worker/retry.go:1-40").
 * One line protocol keeps them in order without inventing a second endpoint.
 *
 * Both routes sit beside the SPA fallback, so they only answer their own exact
 * paths. Responses are never cached by the browser (`no-store`), and every frame
 * is flushed immediately so the panel can render while the model is speaking.
 *
 * @module dsh-eli5/http
 */

/** import { readRequest } keeps request validation in one place. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRequest } from './service.js';
import { PROMPT_REVISION } from './prompt.js';

/** Absolute path of the renderer module that ships with this package. */
const RENDERER_FILE = join(dirname(fileURLToPath(import.meta.url)), 'mermaid-lite.js');

/** Path of the health probe. */
export const HEALTH_PATH = '/eli5/health';

/** Path of the explanation stream. */
export const ASK_PATH = '/eli5/ask';

/** Path of the browser-side diagram renderer (loaded lazily, only when a diagram appears). */
export const DIAGRAM_RENDERER_PATH = '/eli5/mermaid-lite.js';

/** Largest accepted request body; a selection plus history never needs more. */
const MAX_BODY_BYTES = 64 * 1024;

/** Read a JSON request body with a hard size cap. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体太大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.status = 400;
    throw error;
  }
}

/** Answer with a JSON failure, unless the stream already started. */
function fail(res, status, message) {
  if (res.headersSent) {
    writeFrame(res, 'error', { message });
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: false, error: message }));
}

/** Write one SSE frame and flush it. */
function writeFrame(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Status for an unexpected failure, keeping a thrown status when there is one. */
function statusOf(error) {
  const status = error !== null && typeof error === 'object' ? error.status : undefined;
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

/**
 * Build the two routes for `ctx.webServer.register`.
 *
 * @param service - the `Eli5Service` instance.
 * @param config - normalized plugin config (timeouts and bounds).
 * @returns route descriptors, in registration order.
 */
export function createRoutes(service, config) {
  return [
    {
      kind: 'exact',
      path: HEALTH_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        const health = await service.health();
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(health));
      },
    },
    {
      kind: 'exact',
      path: DIAGRAM_RENDERER_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        try {
          const source = await readFile(RENDERER_FILE, 'utf8');
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(source);
        } catch (error) {
          fail(res, 500, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      kind: 'exact',
      path: ASK_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          fail(res, statusOf(error), error instanceof Error ? error.message : String(error));
          return;
        }
        const checked = readRequest(body, config);
        if (!checked.ok) {
          fail(res, checked.status, checked.error);
          return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('解释超时')), config.timeoutMs);
        const onClose = () => controller.abort(new Error('浏览器断开了请求'));
        res.on('close', onClose);

        try {
          // The `meta` event is held back until the first real event arrives:
          // an adapter that fails before emitting anything must still be
          // reportable as a JSON error with a proper status, which is only
          // possible while no headers have been sent.
          let meta;
          let started = false;
          const startStream = () => {
            started = true;
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
              'x-eli5-provider': meta?.route.provider ?? '',
              'x-eli5-model': meta?.route.model ?? '',
              'x-eli5-prompt': PROMPT_REVISION,
            });
            writeFrame(res, 'meta', {
              provider: meta?.route.provider ?? '',
              model: meta?.route.model ?? '',
              cached: meta?.cached === true,
              tools: meta?.tools === true,
              prompt: PROMPT_REVISION,
            });
          };
          for await (const step of service.explain(checked.value, controller.signal)) {
            if (controller.signal.aborted) break;
            if (step.kind === 'meta') {
              meta = step;
              continue;
            }
            if (!started) startStream();
            if (step.kind === 'text') {
              writeFrame(res, 'text', { text: step.text });
            } else if (step.kind === 'trace') {
              writeFrame(res, 'trace', step.trace);
            } else if (step.kind === 'notice') {
              writeFrame(res, 'notice', { text: step.text });
            } else if (step.kind === 'done') {
              writeFrame(res, 'done', { cached: step.cached === true });
            }
          }
          if (!started) fail(res, 500, '没有生成任何解释');
          else if (!res.writableEnded) res.end();
        } catch (error) {
          fail(res, statusOf(error), error instanceof Error ? error.message : String(error));
        } finally {
          clearTimeout(timer);
          res.off('close', onClose);
        }
      },
    },
  ];
}
