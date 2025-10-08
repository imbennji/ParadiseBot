const { log } = require('./logger');

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const STEAM_API_KEY     = process.env.STEAM_API_KEY;
const DEV_GUILD_ID      = process.env.DEV_GUILD_ID || null;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !STEAM_API_KEY) {
  log.error('[FATAL] Missing .env: DISCORD_TOKEN, DISCORD_CLIENT_ID, STEAM_API_KEY');
  process.exit(1);
}

const DB_CFG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'steam_discord_bot',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_general_ci',
};

const STEAM_HOST = 'https://api.steampowered.com';

function parseColor(input, fallbackInt) {
  try {
    if (!input) return fallbackInt;
    const s = String(input).trim();
    if (s.startsWith('#')) return parseInt(s.slice(1), 16);
    if (s.startsWith('0x')) return parseInt(s, 16);
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
    return parseInt(s, 16);
  } catch { return fallbackInt; }
}
const STEAM_COLOR = parseColor(process.env.STEAM_EMBED_COLOR || '#171A21', 0x171A21);

const SALES_REGION_CC = process.env.SALES_REGION_CC || 'US';
const SALES_PAGE_SIZE = Math.max(5, parseInt(process.env.SALES_PAGE_SIZE || '10', 10));
const SALES_PRECACHE_PAGES = Math.max(0, parseInt(process.env.SALES_PRECACHE_PAGES || '10', 10));
const SALES_PRECACHE_PREV_PAGES = Math.max(0, parseInt(process.env.SALES_PRECACHE_PREV_PAGES || '2', 10));
const SALES_PAGE_TTL_MS = Math.max(60_000, parseInt(process.env.SALES_PAGE_TTL_MS || '1200000', 10));
const SALES_MAX_PAGES_CACHE = Math.max(50, parseInt(process.env.SALES_MAX_PAGES_CACHE || '400', 10));
const SALES_PREWARM_SPACING_MS = Math.max(250, parseInt(process.env.SALES_PREWARM_SPACING_MS || '800', 10));
const SALES_EXTEND_TTL_ON_HIT = (process.env.SALES_EXTEND_TTL_ON_HIT ?? 'true').toLowerCase() !== 'false';
const SALES_SORT_BY = process.env.SALES_SORT_BY || 'Discount_DESC';

const SALES_FULL_WARMER_ENABLED = (process.env.SALES_FULL_WARMER_ENABLED ?? 'true').toLowerCase() !== 'false';
const SALES_FULL_WARMER_DELAY_MS = Math.max(0, parseInt(process.env.SALES_FULL_WARMER_DELAY_MS || '15000', 10));
const SALES_FULL_WARMER_SPACING_MS = Math.max(400, parseInt(process.env.SALES_FULL_WARMER_SPACING_MS || '1500', 10));

const POLL_MS             = Math.max(30, parseInt(process.env.POLL_SECONDS || '300', 10)) * 1000;
const OWNED_POLL_MS       = Math.max(60, parseInt(process.env.OWNED_POLL_SECONDS || '3600', 10)) * 1000;
const NOWPLAYING_POLL_MS  = Math.max(30, parseInt(process.env.NOWPLAYING_POLL_SECONDS || '120', 10)) * 1000;
const LEADERBOARD_POLL_MS = Math.max(60, parseInt(process.env.LEADERBOARD_POLL_SECONDS || '300', 10)) * 1000;
const SALES_POLL_MS       = Math.max(3600, parseInt(process.env.SALES_POLL_SECONDS || `${24*3600}`, 10)) * 1000;

const CONCURRENCY   = Math.max(1, parseInt(process.env.MAX_CONCURRENCY || '2', 10));
const SCHEMA_TTL_MS = Math.max(1, parseInt(process.env.SCHEMA_TTL_HOURS || '168', 10)) * 3600 * 1000;

const SEED_ON_FIRST_RUN            = (process.env.SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const BACKFILL_LIMIT               = Math.max(0, parseInt(process.env.BACKFILL_LIMIT || '5', 10));
const SEED_IF_ZERO                 = (process.env.SEED_IF_ZERO ?? 'true').toLowerCase() !== 'false';
const OWNED_SEED_ON_FIRST          = (process.env.OWNED_SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const PLAYTIME_SEED_ON_FIRST_RUN   = (process.env.PLAYTIME_SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const NOWPLAYING_SEED_ON_FIRST_RUN = (process.env.NOWPLAYING_SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const OWNED_ANNOUNCE_LIMIT         = Math.max(1, parseInt(process.env.OWNED_ANNOUNCE_LIMIT || '5', 10));
const OWNED_REMOVAL_GRACE_MIN      = Math.max(5, parseInt(process.env.OWNED_REMOVAL_GRACE_MINUTES || '30', 10));

const DEFAULT_PLAYTIME_MARKS = (process.env.PLAYTIME_MARKS || '10,25,50,100').split(',').map(s => parseInt(s.trim(),10)).filter(Boolean);
const DEFAULT_ACH_MARKS      = (process.env.ACHIEVEMENT_MARKS || '25,50,75,100').split(',').map(s => parseInt(s.trim(),10)).filter(Boolean);
const RARE_PCT               = Math.max(0, parseFloat(process.env.RARE_PCT || '1.0'));
const RARITY_TTL_MS          = Math.max(1, parseInt(process.env.RARITY_TTL_HOURS || '24', 10)) * 3600 * 1000;

const NOWPLAYING_CONFIRM_SECONDS      = Math.max(0, parseInt(process.env.NOWPLAYING_CONFIRM_SECONDS || '60', 10));
const NOWPLAYING_IDLE_TIMEOUT_SECONDS = Math.max(Math.ceil(NOWPLAYING_POLL_MS/1000)+30, parseInt(process.env.NOWPLAYING_IDLE_TIMEOUT_SECONDS || `${Math.ceil(NOWPLAYING_POLL_MS/1000)+30}`, 10));
const SESSION_MIN_MINUTES             = Math.max(1, parseInt(process.env.SESSION_MIN_MINUTES || '10', 10));

const RECENT_LIMIT = Math.max(3, parseInt(process.env.RECENT_LIMIT || '10', 10));

module.exports = {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  STEAM_API_KEY,
  DEV_GUILD_ID,
  DB_CFG,
  STEAM_HOST,
  STEAM_COLOR,
  SALES_REGION_CC,
  SALES_PAGE_SIZE,
  SALES_PRECACHE_PAGES,
  SALES_PRECACHE_PREV_PAGES,
  SALES_PAGE_TTL_MS,
  SALES_MAX_PAGES_CACHE,
  SALES_PREWARM_SPACING_MS,
  SALES_EXTEND_TTL_ON_HIT,
  SALES_SORT_BY,
  SALES_FULL_WARMER_ENABLED,
  SALES_FULL_WARMER_DELAY_MS,
  SALES_FULL_WARMER_SPACING_MS,
  POLL_MS,
  OWNED_POLL_MS,
  NOWPLAYING_POLL_MS,
  LEADERBOARD_POLL_MS,
  SALES_POLL_MS,
  CONCURRENCY,
  SCHEMA_TTL_MS,
  SEED_ON_FIRST_RUN,
  BACKFILL_LIMIT,
  SEED_IF_ZERO,
  OWNED_SEED_ON_FIRST,
  PLAYTIME_SEED_ON_FIRST_RUN,
  NOWPLAYING_SEED_ON_FIRST_RUN,
  OWNED_ANNOUNCE_LIMIT,
  OWNED_REMOVAL_GRACE_MIN,
  DEFAULT_PLAYTIME_MARKS,
  DEFAULT_ACH_MARKS,
  RARE_PCT,
  RARITY_TTL_MS,
  NOWPLAYING_CONFIRM_SECONDS,
  NOWPLAYING_IDLE_TIMEOUT_SECONDS,
  SESSION_MIN_MINUTES,
  RECENT_LIMIT,
};
