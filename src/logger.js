const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const DEBUG_LEVEL = (process.env.DEBUG_LEVEL || 'info').toLowerCase();
const LOG_LEVEL = LEVELS[DEBUG_LEVEL] ?? LEVELS.info;
const DEBUG_HTTP = !!Number(process.env.DEBUG_HTTP || 0);
const DEBUG_SQL  = !!Number(process.env.DEBUG_SQL  || 0);

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
function logAt(lvl, tag, ...args) {
  if (LEVELS[lvl] <= LOG_LEVEL) console.log(`[${ts()}] [${lvl.toUpperCase()}]${tag ? ` [${tag}]` : ''}`, ...args.map(redact));
}
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
