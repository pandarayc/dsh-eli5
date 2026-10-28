/**
 * dsh-eli5 — configuration.
 *
 * Everything the host half needs, with defaults that make the plugin work on a
 * stock `web` profile: an auxiliary call to a small, fast model. Configuration
 * comes from the Loader entry's `config`, so it is edited in
 * `~/.dsh/profiles/<profile>/cordis.patch.yml`, not in code.
 *
 * @module dsh-eli5/config
 */

/** Defaults used when the Loader entry omits a key. */
export const DEFAULTS = Object.freeze({
  provider: '',
  model: '',
  maxOutputTokens: 1200,
  timeoutMs: 90_000,
  temperature: undefined,
  maxSelectedChars: 4000,
  maxContextChars: 4000,
  maxQuestionChars: 1000,
  maxHistoryEntries: 8,
  maxHistoryChars: 1500,
  cacheEntries: 80,
  maxConcurrent: 4,
  enableTools: true,
  maxToolRounds: 3,
  maxToolCalls: 6,
  maxToolBytes: 200_000,
  maxToolMs: 60_000,
  maxFileLines: 400,
  maxGrepResults: 40,
  maxGlobResults: 100,
  debug: false,
  debugCwd: '',
});

/** The route tried when configuration names neither provider nor model. */
const PREFERRED = Object.freeze([
  ['fancyhub', 'glm-5.3-flash'],
  ['fancyhub', 'deepseek-flash'],
]);

/** Read a boolean, falling back to a default. */
function flag(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Truncate one string to a UTF-16 unit budget. */
function clip(value, limit) {
  return typeof value === 'string' && value.length > limit ? value.slice(0, limit) : typeof value === 'string' ? value : '';
}

/** Read one positive integer, falling back to a default. */
function count(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * Normalize the untrusted Loader config into the object the service reads.
 *
 * The schema is deliberately forgiving: an unknown key is dropped, a bad number
 * becomes its default, and an empty `provider`/`model` stays empty so the
 * service can discover a route at request time instead of failing to mount.
 *
 * @param raw - Loader entry config, possibly `undefined`.
 * @returns a frozen config object.
 */
export function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const temperature = Number(value.temperature);
  return Object.freeze({
    provider,
    model,
    maxOutputTokens: count(value.maxOutputTokens, DEFAULTS.maxOutputTokens, 64, 32_000),
    timeoutMs: count(value.timeoutMs, DEFAULTS.timeoutMs, 5_000, 600_000),
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : undefined,
    maxSelectedChars: count(value.maxSelectedChars, DEFAULTS.maxSelectedChars, 16, 20_000),
    maxContextChars: count(value.maxContextChars, DEFAULTS.maxContextChars, 0, 20_000),
    maxQuestionChars: count(value.maxQuestionChars, DEFAULTS.maxQuestionChars, 16, 8_000),
    maxHistoryEntries: count(value.maxHistoryEntries, DEFAULTS.maxHistoryEntries, 0, 24),
    maxHistoryChars: count(value.maxHistoryChars, DEFAULTS.maxHistoryChars, 64, 8_000),
    cacheEntries: count(value.cacheEntries, DEFAULTS.cacheEntries, 0, 1000),
    maxConcurrent: count(value.maxConcurrent, DEFAULTS.maxConcurrent, 1, 16),
    enableTools: flag(value.enableTools, DEFAULTS.enableTools),
    maxToolRounds: count(value.maxToolRounds, DEFAULTS.maxToolRounds, 0, 8),
    maxToolCalls: count(value.maxToolCalls, DEFAULTS.maxToolCalls, 0, 24),
    maxToolBytes: count(value.maxToolBytes, DEFAULTS.maxToolBytes, 0, 2_000_000),
    maxToolMs: count(value.maxToolMs, DEFAULTS.maxToolMs, 1_000, 300_000),
    maxFileLines: count(value.maxFileLines, DEFAULTS.maxFileLines, 20, 2000),
    maxGrepResults: count(value.maxGrepResults, DEFAULTS.maxGrepResults, 1, 80),
    maxGlobResults: count(value.maxGlobResults, DEFAULTS.maxGlobResults, 1, 500),
    debug: flag(value.debug, DEFAULTS.debug),
    debugCwd: typeof value.debugCwd === 'string' ? value.debugCwd.trim() : '',
  });
}

export { PREFERRED, clip };
