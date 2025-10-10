/**
 * Lightweight logging utility that mimics structured logging without introducing external
 * dependencies. The module exposes helper functions for namespaced logging, request timing, and
 * selective debug toggles that are all controlled via environment variables.
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const DEBUG_LEVEL = (process.env.DEBUG_LEVEL || 'info').toLowerCase();
const LOG_LEVEL = LEVELS[DEBUG_LEVEL] ?? LEVELS.info;
const DEBUG_HTTP = !!Number(process.env.DEBUG_HTTP || 0);
const DEBUG_SQL  = !!Number(process.env.DEBUG_SQL  || 0);

/**
 * Replaces occurrences of sensitive values (tokens, API keys, passwords) with a placeholder so
 * logs can safely be shared when debugging. This defensive measure allows the rest of the codebase
 * to log freely without worrying about accidental credential leaks.
 *
 * @param {unknown} v - Value to be logged.
 * @returns {unknown} Redacted value when input contains secrets.
 */
const redact = (v) => {
  if (!v) return v;
  let s = String(v);
  const secrets = [
    process.env.DISCORD_TOKEN,
    process.env.STEAM_API_KEY,
    process.env.DB_PASS,
    process.env.GITHUB_TOKEN,
  ];
  for (const sec of secrets) if (sec) s = s.split(sec).join('••••••••');
  return s;
};
const ts = () => new Date().toISOString();

/**
 * Core logging primitive that performs the level check and invokes `console.log` with a consistent
 * timestamp + tag prefix. All exported helper methods ultimately funnel through this function.
 *
 * @param {keyof typeof LEVELS} lvl - Severity that determines whether the message is emitted.
 * @param {string} tag - Optional contextual tag (e.g. module name).
 * @param {...unknown} args - Arguments passed to `console.log`.
 */
function logAt(lvl, tag, ...args) {
  if (LEVELS[lvl] <= LOG_LEVEL) console.log(`[${ts()}] [${lvl.toUpperCase()}]${tag ? ` [${tag}]` : ''}`, ...args.map(redact));
}
/**
 * Public logging facade that mirrors the common console API (`error`, `warn`, `info`, etc.) while
 * automatically redacting sensitive information. The `tag` helper returns a bound logger that adds
 * its tag to every subsequent call.
 */
const log = {
  error: (...a) => logAt('error', '', ...a),
  warn:  (...a) => logAt('warn',  '', ...a),
  info:  (...a) => logAt('info',  '', ...a),
  debug: (...a) => logAt('debug', '', ...a),
  trace: (...a) => logAt('trace', '', ...a),
  tag: (tag) => ({
    error: (...a) => logAt('error', tag, ...a),
    warn:  (...a) => logAt('warn',  tag, ...a),
    info:  (...a) => logAt('info',  tag, ...a),
    debug: (...a) => logAt('debug', tag, ...a),
    trace: (...a) => logAt('trace', tag, ...a),
  }),
};
/**
 * Measures elapsed time between invocations. Useful when wrapping async boot sequences so we can
 * observe slow startups or API responses without an external profiler.
 *
 * @param {string} label - Descriptive identifier for the timing span.
 * @returns {{ end(tag?: string): string }} Function that logs and returns the elapsed milliseconds.
 */
const time = (label) => {
  const start = process.hrtime.bigint();
  return { end: (tag = label) => {
    const ns = Number(process.hrtime.bigint() - start);
    const ms = (ns / 1e6).toFixed(2);
    log.tag(tag).trace(`done in ${ms} ms`);
    return ms;
  }};
};

module.exports = {
  LEVELS,
  DEBUG_LEVEL,
  LOG_LEVEL,
  DEBUG_HTTP,
  DEBUG_SQL,
  log,
  time,
  redact,
};
