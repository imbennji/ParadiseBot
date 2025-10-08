// file: index.js
/**
 * Discord ⟷ Steam per-profile Announcers (Node.js, MySQL)
 * Sales: Games-only, accurate discounts, instant paging (LRU cache + epoch guard),
 *        prewarm next N pages (spaced), and eventual full warm (1→∞, trickled).
 *
 * Requirements:
 *  - .env with DISCORD_TOKEN, DISCORD_CLIENT_ID, STEAM_API_KEY, DB_*
 *  - npm i discord.js axios mysql2 p-limit dotenv cheerio tough-cookie axios-cookiejar-support
 */

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const axios = require('axios').default;
const mysql = require('mysql2/promise');
const pLimitImport = require('p-limit');
const pLimit = typeof pLimitImport === 'function' ? pLimitImport : pLimitImport.default;

const cheerio = require('cheerio');
const { wrapper: axiosCookieJarSupport } = require('axios-cookiejar-support');
const tough = require('tough-cookie');

/* =========================
 * Logging & timing
 * ========================= */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const DEBUG_LEVEL = (process.env.DEBUG_LEVEL || 'info').toLowerCase();
const LOG_LEVEL = LEVELS[DEBUG_LEVEL] ?? LEVELS.info;
const DEBUG_HTTP = !!Number(process.env.DEBUG_HTTP || 0);
const DEBUG_SQL  = !!Number(process.env.DEBUG_SQL  || 0);

const SALES_SORT_BY = process.env.SALES_SORT_BY || 'Discount_DESC';

const redact = (v) => {
  if (!v) return v;
  let s = String(v);
  const secrets = [process.env.DISCORD_TOKEN, process.env.STEAM_API_KEY, process.env.DB_PASS];
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

process.on('unhandledRejection', (e) => log.tag('UNHANDLED').error('Promise rejection:', e?.stack || e));
process.on('uncaughtException', (e) => log.tag('UNCAUGHT').error('Exception:', e?.stack || e));

/* =========================
 * Config
 * ========================= */
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

/* Color */
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

/* Sales env */
const SALES_REGION_CC = process.env.SALES_REGION_CC || 'US';
const SALES_PAGE_SIZE = Math.max(5, parseInt(process.env.SALES_PAGE_SIZE || '10', 10));
const SALES_PRECACHE_PAGES = Math.max(0, parseInt(process.env.SALES_PRECACHE_PAGES || '10', 10));
const SALES_PRECACHE_PREV_PAGES = Math.max(0, parseInt(process.env.SALES_PRECACHE_PREV_PAGES || '2', 10));
const SALES_PAGE_TTL_MS = Math.max(60_000, parseInt(process.env.SALES_PAGE_TTL_MS || '1200000', 10)); // 20m
const SALES_MAX_PAGES_CACHE = Math.max(50, parseInt(process.env.SALES_MAX_PAGES_CACHE || '400', 10));
const SALES_PREWARM_SPACING_MS = Math.max(250, parseInt(process.env.SALES_PREWARM_SPACING_MS || '800', 10)); // avoid bursts
const SALES_EXTEND_TTL_ON_HIT = (process.env.SALES_EXTEND_TTL_ON_HIT ?? 'true').toLowerCase() !== 'false';

// Eventual full warm:
const SALES_FULL_WARMER_ENABLED = (process.env.SALES_FULL_WARMER_ENABLED ?? 'true').toLowerCase() !== 'false';
const SALES_FULL_WARMER_DELAY_MS = Math.max(0, parseInt(process.env.SALES_FULL_WARMER_DELAY_MS || '15000', 10));
const SALES_FULL_WARMER_SPACING_MS = Math.max(400, parseInt(process.env.SALES_FULL_WARMER_SPACING_MS || '1500', 10));

/* Polling */
const POLL_MS                 = Math.max(30, parseInt(process.env.POLL_SECONDS || '300', 10)) * 1000;
const OWNED_POLL_MS           = Math.max(60, parseInt(process.env.OWNED_POLL_SECONDS || '3600', 10)) * 1000;
const NOWPLAYING_POLL_MS      = Math.max(30, parseInt(process.env.NOWPLAYING_POLL_SECONDS || '120', 10)) * 1000;
const LEADERBOARD_POLL_MS     = Math.max(60, parseInt(process.env.LEADERBOARD_POLL_SECONDS || '300', 10)) * 1000;
const SALES_POLL_MS           = Math.max(3600, parseInt(process.env.SALES_POLL_SECONDS || `${24*3600}`, 10)) * 1000;

/* Concurrency & TTL */
const CONCURRENCY             = Math.max(1, parseInt(process.env.MAX_CONCURRENCY || '2', 10));
const SCHEMA_TTL_MS           = Math.max(1, parseInt(process.env.SCHEMA_TTL_HOURS || '168', 10)) * 3600 * 1000;

/* Flags & spam guards */
const SEED_ON_FIRST_RUN             = (process.env.SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const BACKFILL_LIMIT                = Math.max(0, parseInt(process.env.BACKFILL_LIMIT || '5', 10));
const SEED_IF_ZERO                  = (process.env.SEED_IF_ZERO ?? 'true').toLowerCase() !== 'false';
const OWNED_SEED_ON_FIRST           = (process.env.OWNED_SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const PLAYTIME_SEED_ON_FIRST_RUN    = (process.env.PLAYTIME_SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const NOWPLAYING_SEED_ON_FIRST_RUN  = (process.env.NOWPLAYING_SEED_ON_FIRST_RUN ?? 'true').toLowerCase() !== 'false';
const OWNED_ANNOUNCE_LIMIT          = Math.max(1, parseInt(process.env.OWNED_ANNOUNCE_LIMIT || '5', 10));
const OWNED_REMOVAL_GRACE_MIN       = Math.max(5, parseInt(process.env.OWNED_REMOVAL_GRACE_MINUTES || '30', 10));

/* Milestones & rarity */
const DEFAULT_PLAYTIME_MARKS = (process.env.PLAYTIME_MARKS || '10,25,50,100').split(',').map(s => parseInt(s.trim(),10)).filter(Boolean);
const DEFAULT_ACH_MARKS      = (process.env.ACHIEVEMENT_MARKS || '25,50,75,100').split(',').map(s => parseInt(s.trim(),10)).filter(Boolean);
const RARE_PCT               = Math.max(0, parseFloat(process.env.RARE_PCT || '1.0'));
const RARITY_TTL_MS          = Math.max(1, parseInt(process.env.RARITY_TTL_HOURS || '24', 10)) * 3600 * 1000;

/* Now-playing session controls */
const NOWPLAYING_CONFIRM_SECONDS     = Math.max(0, parseInt(process.env.NOWPLAYING_CONFIRM_SECONDS || '60', 10));
const NOWPLAYING_IDLE_TIMEOUT_SECONDS= Math.max(Math.ceil(NOWPLAYING_POLL_MS/1000)+30, parseInt(process.env.NOWPLAYING_IDLE_TIMEOUT_SECONDS || `${Math.ceil(NOWPLAYING_POLL_MS/1000)+30}`, 10));
const SESSION_MIN_MINUTES            = Math.max(1, parseInt(process.env.SESSION_MIN_MINUTES || '10', 10));

/* Recent cap */
const RECENT_LIMIT = Math.max(3, parseInt(process.env.RECENT_LIMIT || '10', 10));

log.info('Config:', JSON.stringify({
  SALES_REGION_CC, SALES_PAGE_SIZE, SALES_PRECACHE_PAGES, SALES_PRECACHE_PREV_PAGES, SALES_PREWARM_SPACING_MS,
  SALES_PAGE_TTL_MS, SALES_MAX_PAGES_CACHE, SALES_EXTEND_TTL_ON_HIT,
  SALES_FULL_WARMER_ENABLED, SALES_FULL_WARMER_DELAY_MS, SALES_FULL_WARMER_SPACING_MS,
  POLL_MS, OWNED_POLL_MS, NOWPLAYING_POLL_MS, LEADERBOARD_POLL_MS, SALES_POLL_MS,
  CONCURRENCY, SCHEMA_TTL_MS, BACKFILL_LIMIT, DEBUG_LEVEL, DEBUG_HTTP, DEBUG_SQL
}));

/* =========================
 * MySQL pool + helpers
 * ========================= */
let pool;
async function initDb() {
  const t = time('DB:init');
  pool = mysql.createPool(DB_CFG);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id   VARCHAR(32) NOT NULL PRIMARY KEY,
      channel_id VARCHAR(32) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS guild_channels (
      guild_id   VARCHAR(32) NOT NULL,
      kind       VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      PRIMARY KEY (guild_id, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS links (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      steam_id VARCHAR(32) NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS steam_account_locks (
      steam_id VARCHAR(32) NOT NULL PRIMARY KEY,
      user_id  VARCHAR(32) NOT NULL,
      linked_at INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS watermarks (
      guild_id    VARCHAR(32) NOT NULL,
      user_id     VARCHAR(32) NOT NULL,
      appid       INT NOT NULL,
      last_unlock INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_schema (
      appid      INT NOT NULL PRIMARY KEY,
      fetched_at BIGINT NOT NULL,
      payload    LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS owned_seen (
      guild_id   VARCHAR(32) NOT NULL,
      user_id    VARCHAR(32) NOT NULL,
      appid      INT NOT NULL,
      first_seen INT NOT NULL,
      seeded     TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS global_ach_pct (
      appid INT NOT NULL,
      api_name VARCHAR(191) NOT NULL,
      pct DOUBLE NOT NULL,
      fetched_at BIGINT NOT NULL,
      PRIMARY KEY (appid, api_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS ach_progress_marks (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      last_pct INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS playtime_marks (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      last_mark_hours INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS nowplaying_state (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      started_at INT NOT NULL,
      last_seen_at INT NOT NULL,
      announced TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS owned_presence (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      last_seen INT NOT NULL,
      missing_since INT NULL,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_game_stats (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      playtime_total_min INT NOT NULL DEFAULT 0,
      playtime_2w_min    INT NOT NULL DEFAULT 0,
      ach_unlocked       INT NOT NULL DEFAULT 0,
      ach_total          INT NOT NULL DEFAULT 0,
      updated_at         INT NOT NULL,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS leaderboard_msgs (
      guild_id   VARCHAR(32) NOT NULL PRIMARY KEY,
      channel_id VARCHAR(32) NOT NULL,
      message_id VARCHAR(32) NOT NULL,
      updated_at INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sales_msgs (
      guild_id   VARCHAR(32) NOT NULL PRIMARY KEY,
      channel_id VARCHAR(32) NOT NULL,
      message_id VARCHAR(32) NOT NULL,
      updated_at INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await ensureColumn('nowplaying_state', 'announced', 'TINYINT NOT NULL DEFAULT 0');
  await ensureColumn('owned_seen', 'seeded', 'TINYINT NOT NULL DEFAULT 0');

  t.end();
}
async function dbGet(sql, params = []) {
  const t = time('DB:get');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [rows] = await pool.query(sql, params);
  const row = rows[0] || null;
  log.tag('DB').trace(`get -> ${row ? '1 row' : '0 rows'}`);
  t.end(); return row;
}
async function dbAll(sql, params = []) {
  const t = time('DB:all');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [rows] = await pool.query(sql, params);
  log.tag('DB').trace(`all -> ${rows.length} rows`);
  t.end(); return rows;
}
async function dbRun(sql, params = []) {
  const t = time('DB:run');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [res] = await pool.query(sql, params);
  log.tag('DB').trace(`run -> affectedRows=${res?.affectedRows ?? 0}`);
  t.end(); return res;
}
async function ensureColumn(table, column, columnDef) {
  const row = await dbGet(
    'SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
    [DB_CFG.database, table, column]
  );
  if (!row) {
    await dbRun(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${columnDef}`);
    log.tag('DB:MIGRATE').info(`Added column ${table}.${column}`);
  }
}

/* =========================
 * Discord client & commands
 * ========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

const CHANNEL_KINDS = {
  ACHIEVEMENTS: 'achievements',
  NEW_GAMES: 'new_games',
  NOW_PLAYING: 'now_playing',
  MILESTONES: 'milestones',
  LIBRARY: 'library',
  LEADERBOARD: 'leaderboard',
  SALES: 'steam_game_sales',
};
function normalizeKind(s) {
  const v = String(s || '').toLowerCase().replace(/\s+/g, '_');
  if (['achievements','steam_achievements','steamachievements'].includes(v)) return CHANNEL_KINDS.ACHIEVEMENTS;
  if (['new_games','new_game_notifications','notifications','library_adds'].includes(v)) return CHANNEL_KINDS.NEW_GAMES;
  if (['now_playing','nowplaying','sessions'].includes(v)) return CHANNEL_KINDS.NOW_PLAYING;
  if (['milestones','progress'].includes(v)) return CHANNEL_KINDS.MILESTONES;
  if (['library','removals','library_removals'].includes(v)) return CHANNEL_KINDS.LIBRARY;
  if (['leaderboard','lb','boards'].includes(v)) return CHANNEL_KINDS.LEADERBOARD;
  if (['steam_sales','sales','store_sales','steam_sales_board','steam_game_sales'].includes(v)) return CHANNEL_KINDS.SALES;
  return null;
}

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel for Steam announcements')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('type')
        .setDescription('Which announcements should go to this channel')
        .setRequired(true)
        .addChoices(
          { name: 'steam_achievements',     value: CHANNEL_KINDS.ACHIEVEMENTS },
          { name: 'new_game_notifications', value: CHANNEL_KINDS.NEW_GAMES },
          { name: 'now_playing',            value: CHANNEL_KINDS.NOW_PLAYING },
          { name: 'milestones',             value: CHANNEL_KINDS.MILESTONES },
          { name: 'library_removals',       value: CHANNEL_KINDS.LIBRARY },
          { name: 'leaderboard',            value: CHANNEL_KINDS.LEADERBOARD },
          { name: 'steam_game_sales',       value: CHANNEL_KINDS.SALES },
        )
    )
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('Defaults to the current channel if omitted')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('linksteam')
    .setDescription('Link your Steam account (vanity, profile URL, or 64-bit SteamID)')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('profile')
        .setDescription('e.g. mysteamname OR https://steamcommunity.com/id/mysteamname OR 7656119...')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Unlink your Steam account in this server')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('pingsteam')
    .setDescription('Quick health check: DB + Steam API (optional: test a profile)')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('profile')
        .setDescription('Optional vanity/profile URL/steamid64 to test resolution & a simple call')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Manage the permanent leaderboard message')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('init').setDescription('Create or move the leaderboard to this channel')),
  new SlashCommandBuilder()
    .setName('sales')
    .setDescription('Manage the Steam Game Sales permanent embed')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('init').setDescription('Create/move the Steam Game Sales embed to this channel')),
];

const commands = commandBuilders.map(c => c.toJSON());
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

/* =========================
 * Ready & interactions
 * ========================= */
client.once(Events.ClientReady, async (c) => {
  log.tag('READY').info(`Logged in as ${c.user.tag}`);
  await registerCommandsOnStartup();

  scheduleAchievementsLoop(true);
  scheduleOwnedLoop(true);
  scheduleNowPlayingLoop(true);
  scheduleLeaderboardLoop(true);
  scheduleSalesLoop(true);

  if (SALES_FULL_WARMER_ENABLED) startFullSalesWarm(SALES_REGION_CC);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const tag = `CMD:${interaction.commandName}`;
      log.tag(tag).info(`from user=${interaction.user.id} in guild=${interaction.guildId}`);
      switch (interaction.commandName) {
        case 'setchannel':   await handleSetChannel(interaction);  break;
        case 'linksteam':    await handleLinkSteam(interaction);   break;
        case 'unlinksteam':  await handleUnlinkSteam(interaction); break;
        case 'pingsteam':    await handlePingSteam(interaction);   break;
        case 'leaderboard':  await handleLeaderboard(interaction); break;
        case 'sales':        await handleSalesCmd(interaction);    break;
      }
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  } catch (err) {
    log.error('Interaction error:', err?.stack || err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `❌ ${err.message || err}`, ephemeral: true }).catch(()=>{});
    } else {
      await interaction.reply({ content: `❌ ${err.message || err}`, ephemeral: true }).catch(()=>{});
    }
  }
});

/* =========================
 * Command handlers
 * ========================= */
async function registerCommandsOnStartup() {
  const t = time('CMD:register');
  try {
    if (DEV_GUILD_ID) {
      log.tag('CMD').info(`Registering ${commands.length} commands → guild ${DEV_GUILD_ID}`);
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DEV_GUILD_ID), { body: commands });
      log.tag('CMD').info('Guild commands registered.');
    } else {
      log.tag('CMD').info(`Registering ${commands.length} commands → GLOBAL`);
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
      log.tag('CMD').info('Global commands registered (may take a bit to propagate).');
    }
  } catch (err) {
    log.tag('CMD').error('Registration failed:', err?.stack || err);
  } finally { t.end(); }
}

function hasBotPerms(channel) {
  const mePerms = channel.permissionsFor(channel.client.user);
  if (!mePerms) return { ok: false, missing: ['ViewChannel', 'SendMessages', 'EmbedLinks'] };
  const needed = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
  ];
  const missing = needed.filter(p => !mePerms.has(p));
  return { ok: missing.length === 0, missing: missing.map(x => PermissionsBitField.Flags[x] || x) };
}

async function handleSetChannel(interaction) {
  const kind = normalizeKind(interaction.options.getString('type', true));
  if (!kind) return interaction.reply({ content: 'Unknown type.', ephemeral: true });

  const target = interaction.options.getChannel('channel') || interaction.channel;
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({ content: 'You need **Manage Server** to do this.', ephemeral: true });
  }
  if (target.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
  }
  const perms = hasBotPerms(target);
  if (!perms.ok) {
    return interaction.reply({
      content: `I’m missing permissions in ${target}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`,
      ephemeral: true
    });
  }

  await dbRun(
    'INSERT INTO guild_channels (guild_id, kind, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)',
    [interaction.guildId, kind, target.id]
  );
  await dbRun('INSERT INTO guilds (guild_id, channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)',
    [interaction.guildId, target.id]);

  if (kind === CHANNEL_KINDS.LEADERBOARD) {
    await ensureLeaderboardMessage(interaction.guild, target);
  } else if (kind === CHANNEL_KINDS.SALES) {
    await ensureSalesMessage(interaction.guild, target);
  }

  log.tag('CMD:setchannel').info(`guild=${interaction.guildId} kind=${kind} channel=${target.id}`);
  return interaction.reply({ content: `✅ Channel set for **${kind.replaceAll('_',' ')}** → ${target}.`, ephemeral: true });
}

async function handleLinkSteam(interaction) {
  const input = interaction.options.getString('profile', true).trim();
  await interaction.deferReply({ ephemeral: true });

  const already = await dbGet('SELECT steam_id FROM links WHERE guild_id=? AND user_id=?', [interaction.guildId, interaction.user.id]);
  if (already) {
    return interaction.editReply(`You already linked **${already.steam_id}** here. Use \`/unlinksteam\` first (this also clears your cached data).`);
  }

  const steamId = await resolveSteamId(input);
  if (!steamId) throw new Error('Could not resolve that Steam profile. Make sure the URL/name/ID is valid.');

  const lock = await dbGet('SELECT user_id FROM steam_account_locks WHERE steam_id=?', [steamId]);
  if (lock && lock.user_id !== interaction.user.id) {
    return interaction.editReply(`❌ That Steam account is already linked by another Discord user.`);
  }

  await dbRun('INSERT INTO links (guild_id, user_id, steam_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE steam_id=VALUES(steam_id)', [interaction.guildId, interaction.user.id, steamId]);
  await dbRun('INSERT INTO steam_account_locks (steam_id, user_id, linked_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), linked_at=VALUES(linked_at)', [steamId, interaction.user.id, Math.floor(Date.now()/1000)]);

  log.tag('CMD:linksteam').info(`guild=${interaction.guildId} user=${interaction.user.id} steamId=${steamId}`);
  return interaction.editReply(`✅ Linked <@${interaction.user.id}> → **${steamId}**.`);
}

async function handleUnlinkSteam(interaction) {
  const g = interaction.guildId, u = interaction.user.id;
  const link = await dbGet('SELECT steam_id FROM links WHERE guild_id=? AND user_id=?', [g, u]);
  const steamId = link?.steam_id || null;

  await dbRun('DELETE FROM links WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM watermarks WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM owned_seen WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM ach_progress_marks WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM playtime_marks WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM nowplaying_state WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM owned_presence WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM user_game_stats WHERE guild_id = ? AND user_id = ?', [g, u]);

  if (steamId) {
    const lock = await dbGet('SELECT user_id FROM steam_account_locks WHERE steam_id=?', [steamId]);
    if (lock && lock.user_id === u) await dbRun('DELETE FROM steam_account_locks WHERE steam_id=?', [steamId]);
  }

  log.tag('CMD:unlinksteam').info(`guild=${g} user=${u} -> cleared & unlocked`);
  return interaction.reply({ content: '✅ Unlinked and all cached data cleared.', ephemeral: true });
}

async function handlePingSteam(interaction) {
  const profile = interaction.options.getString('profile', false)?.trim();
  await interaction.deferReply({ ephemeral: true });

  try { await dbGet('SELECT 1 AS ok'); } catch (e) { return interaction.editReply(`❌ DB check failed: ${e.message || e}`); }
  try {
    const t = time('HTTP:ServerInfo');
    await axios.get(`${STEAM_HOST}/ISteamWebAPIUtil/GetServerInfo/v1/?key=${encodeURIComponent(STEAM_API_KEY)}`, { timeout: 10000 });
    t.end();
  } catch (e) { return interaction.editReply(`❌ Steam API base check failed: ${e.message || e}`); }

  if (profile) {
    try {
      const steamId = await resolveSteamId(profile);
      if (!steamId) throw new Error('profile could not be resolved');
      await getRecentlyPlayed(steamId);
      return interaction.editReply(`✅ Health OK. DB ✅, Steam API ✅, Profile **${steamId}** ✅`);
    } catch (e) {
      return interaction.editReply(`⚠️ Basic OK (DB ✅ Steam ✅) but profile test failed: ${e.message || e}`);
    }
  }
  return interaction.editReply(`✅ Health OK. DB ✅, Steam API ✅`);
}

async function handleLeaderboard(interaction) {
  if (interaction.options.getSubcommand() === 'init') {
    const channel = interaction.channel;
    const perms = hasBotPerms(channel);
    if (!perms.ok) {
      return interaction.reply({ content: `I’m missing permissions in ${channel}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    await ensureLeaderboardMessage(interaction.guild, channel);
    await interaction.editReply('✅ Leaderboard initialized/moved here. I’ll keep this message updated.');
  }
}

async function handleSalesCmd(interaction) {
  if (interaction.options.getSubcommand() === 'init') {
    const channel = interaction.channel;
    const perms = hasBotPerms(channel);
    if (!perms.ok) {
      return interaction.reply({ content: `I’m missing permissions in ${channel}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    await ensureSalesMessage(interaction.guild, channel);
    await interaction.editReply('✅ Steam Game Sales embed initialized/moved here. Use the buttons to page through discounted games.');
  }
}

/* =========================
 * Generic HTTP logging
 * ========================= */
const httpTag = log.tag('HTTP');
axios.interceptors.request.use((cfg) => {
  cfg.metadata = { start: process.hrtime.bigint() };
  DEBUG_HTTP && httpTag.debug(`→ ${cfg.method?.toUpperCase()} ${redact(cfg.url || `${cfg.baseURL || ''}${cfg.urlPath || ''}`)} timeout=${cfg.timeout}ms`);
  return cfg;
});
axios.interceptors.response.use(
  (res) => {
    if (DEBUG_HTTP) {
      const ns = Number(process.hrtime.bigint() - (res.config.metadata?.start ?? process.hrtime.bigint()));
      const ms = (ns / 1e6).toFixed(1);
      httpTag.debug(`← ${res.status} ${redact(res.config.url || `${res.config.baseURL || ''}${res.config.urlPath || ''}`)} in ${ms}ms`);
    }
    return res;
  },
  (err) => {
    if (DEBUG_HTTP) {
      const cfg = err.config || {};
      const start = cfg.metadata?.start ?? process.hrtime.bigint();
      const ns = Number(process.hrtime.bigint() - start);
      const ms = (ns / 1e6).toFixed(1);
      httpTag.error(`✖ ${cfg.method?.toUpperCase()} ${redact(cfg.url || `${cfg.baseURL || ''}${cfg.urlPath || ''}`)} failed in ${ms}ms: ${err?.response?.status || ''} ${err?.message}`);
    }
    return Promise.reject(err);
  }
);

/* =========================
 * Steam API helpers (profiles/achievements/etc.)
 * ========================= */
const STEAM_API = log.tag('STEAM');
function parseSteamIdish(input) {
  const trimmed = input.trim();
  const mProfiles = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (mProfiles) return mProfiles[1];
  const mId = trimmed.match(/^\d{17}$/);
  if (mId) return mId[0];
  const mVanity = trimmed.match(/steamcommunity\.com\/id\/([\w-_.]+)/i);
  if (mVanity) return mVanity[1];
  return trimmed;
}
async function resolveSteamId(input) {
  const idish = parseSteamIdish(input);
  if (/^\d{17}$/.test(idish)) return idish;
  const url = `${STEAM_HOST}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&vanityurl=${encodeURIComponent(idish)}`;
  const t = time('HTTP:ResolveVanityURL');
  const { data } = await axios.get(url, { timeout: 15000 });
  t.end();
  const ok = data?.response?.success === 1 && data.response.steamid;
  STEAM_API.info(`resolveSteamId("${idish}") -> ${ok ? data.response.steamid : 'NOT FOUND'}`);
  return ok ? data.response.steamid : null;
}
async function getRecentlyPlayed(steamId) {
  const url = `${STEAM_HOST}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(steamId)}`;
  const t = time('HTTP:GetRecentlyPlayedGames');
  const { data } = await axios.get(url, { timeout: 15000 });
  t.end();
  const games = data?.response?.games || [];
  STEAM_API.debug(`recentlyPlayed steam=${steamId} -> ${games.length} games`);
  return games.map(g => ({ appid: g.appid, name: g.name, playtime_2weeks: g.playtime_2weeks || 0, playtime_forever: g.playtime_forever || 0 }));
}
async function getCurrentGame(steamId) {
  const url = `${STEAM_HOST}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`;
  const t = time('HTTP:GetPlayerSummaries');
  const { data } = await axios.get(url, { timeout: 10000 });
  t.end();
  const p = data?.response?.players?.[0];
  if (p?.gameid) return { appid: Number(p.gameid), name: p.gameextrainfo || `App ${p.gameid}` };
  return null;
}
async function fetchSchemaRaw(appid) {
  const url = `${STEAM_HOST}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&appid=${appid}&l=en`;
  const t = time('HTTP:GetSchemaForGame');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  return data?.game || null;
}
async function fetchSchema(appid) {
  const schema = await fetchSchemaRaw(appid);
  if (schema) {
    const achCount = schema?.availableGameStats?.achievements?.length || 0;
    await dbRun(
      'INSERT INTO app_schema (appid, fetched_at, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE fetched_at=VALUES(fetched_at), payload=VALUES(payload)',
      [appid, Date.now(), JSON.stringify({ ...schema, _achCount: achCount })]
    );
    log.tag('SCHEMA').debug(`cached appid=${appid} (achievements=${achCount})`);
  } else {
    log.tag('SCHEMA').warn(`no schema for appid=${appid}`);
  }
  return { schema };
}
async function getSchemaFromCache(appid) {
  const row = await dbGet('SELECT payload, fetched_at FROM app_schema WHERE appid = ?', [appid]);
  const stale = row ? (Date.now() - Number(row.fetched_at) > SCHEMA_TTL_MS) : false;
  if (!row || stale) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}
async function getSchema(appid) { return (await getSchemaFromCache(appid)) || (await fetchSchema(appid)).schema; }
async function getPlayerAchievements(steamId, appid) {
  const url = `${STEAM_HOST}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${steamId}&appid=${appid}&l=en`;
  const t = time('HTTP:GetPlayerAchievements');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  const list = data?.playerstats?.achievements || [];
  STEAM_API.debug(`achievements steam=${steamId} appid=${appid} -> ${list.length} entries`);
  return list.map(a => ({ apiName: a.apiname, achieved: a.achieved === 1, unlocktime: a.unlocktime || 0 }));
}

/* App name helper */
async function getAppNameCached(appid) {
  const s = await getSchemaFromCache(appid);
  if (s?.gameName || s?.game?.gameName) return s.gameName || s.game?.gameName;
  return `App ${appid}`;
}

/* =========================
 * Channel helpers
 * ========================= */
async function getAnnouncementChannel(guild, kind) {
  const row = await dbGet('SELECT channel_id FROM guild_channels WHERE guild_id=? AND kind=?', [guild.id, kind]);
  let channelId = row?.channel_id;
  if (!channelId) {
    const legacy = await dbGet('SELECT channel_id FROM guilds WHERE guild_id=?', [guild.id]);
    channelId = legacy?.channel_id || null;
  }
  return channelId ? guild.channels.cache.get(channelId) : null;
}
async function getConfiguredGuildIds() {
  const legacy = await dbAll('SELECT DISTINCT guild_id FROM guilds');
  const typed  = await dbAll('SELECT DISTINCT guild_id FROM guild_channels');
  const set = new Set();
  legacy.forEach(r => set.add(r.guild_id));
  typed .forEach(r => set.add(r.guild_id));
  return Array.from(set);
}

/* =========================
 * Small helpers
 * ========================= */
function makeProgressBar(current, total, width = 12) {
  if (!total || total <= 0) return 'N/A';
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '🟩'.repeat(filled) + '⬜'.repeat(empty);
}
function fmtDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function hours(mins) { return (Number(mins || 0) / 60).toFixed(1).replace(/\.0$/, ''); }

/* =========================
 * Rarity cache
 * ========================= */
async function getGlobalRarity(appid) {
  const staleSince = Date.now() - RARITY_TTL_MS;
  const anyFresh = await dbGet('SELECT 1 AS ok FROM global_ach_pct WHERE appid=? AND fetched_at>=? LIMIT 1', [appid, staleSince]);
  if (!anyFresh) {
    try {
      const url = `${STEAM_HOST}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
      const t = time('HTTP:GetGlobalAchievementPercentages');
      const { data } = await axios.get(url, { timeout: 15000 });
      t.end();
      const list = data?.achievementpercentages?.achievements || [];
      if (list.length) {
        const now = Date.now();
        for (const a of list) {
          await dbRun(
            'INSERT INTO global_ach_pct (appid, api_name, pct, fetched_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pct=VALUES(pct), fetched_at=VALUES(fetched_at)',
            [appid, a.name, Number(a.percent || 0), now]
          );
        }
      }
    } catch (e) {
      log.tag('RARITY').warn(`fetch rarity failed appid=${appid}: ${e?.message}`);
    }
  }
  const rows = await dbAll('SELECT api_name, pct FROM global_ach_pct WHERE appid=?', [appid]);
  const map = new Map();
  rows.forEach(r => map.set(r.api_name, Number(r.pct)));
  return map;
}

/* =========================
 * Leaderboard helpers + embed
 * ========================= */
async function upsertPlaytimeStats(gid, uid, appid, totalMin, twoWMin) {
  const now = Math.floor(Date.now()/1000);
  await dbRun(
    `INSERT INTO user_game_stats (guild_id, user_id, appid, playtime_total_min, playtime_2w_min, ach_unlocked, ach_total, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)
     ON DUPLICATE KEY UPDATE playtime_total_min=VALUES(playtime_total_min), playtime_2w_min=VALUES(playtime_2w_min), updated_at=VALUES(updated_at)`,
    [gid, uid, appid, Math.max(0, totalMin|0), Math.max(0, twoWMin|0), now]
  );
}
async function upsertAchievementStats(gid, uid, appid, unlocked, total) {
  const now = Math.floor(Date.now()/1000);
  await dbRun(
    `INSERT INTO user_game_stats (guild_id, user_id, appid, playtime_total_min, playtime_2w_min, ach_unlocked, ach_total, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ach_unlocked=VALUES(ach_unlocked), ach_total=VALUES(ach_total), updated_at=VALUES(updated_at)`,
    [gid, uid, appid, Math.max(0, unlocked|0), Math.max(0, total|0), now]
  );
}

async function ensureLeaderboardMessage(guild, targetChannel = null) {
  const row = await dbGet('SELECT channel_id, message_id FROM leaderboard_msgs WHERE guild_id=?', [guild.id]);
  const configured = await getAnnouncementChannel(guild, CHANNEL_KINDS.LEADERBOARD);
  const desiredChannel = targetChannel || configured;

  if (!row && desiredChannel) {
    const embed = new EmbedBuilder()
      .setColor(STEAM_COLOR)
      .setTitle('Steam Leaderboard')
      .setDescription('Collecting stats…\n\n_This shows top stats across linked accounts._')
      .setFooter({ text: 'Auto-updates' })
      .setTimestamp(new Date());
    const msg = await desiredChannel.send({ embeds: [embed] });
    await dbRun('INSERT INTO leaderboard_msgs (guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)', [guild.id, desiredChannel.id, msg.id, Math.floor(Date.now()/1000)]);
    return { channel: desiredChannel, messageId: msg.id };
  }

  if (!row) return null;

  if (desiredChannel && row.channel_id !== desiredChannel.id) {
    try {
      const oldCh = await client.channels.fetch(row.channel_id).catch(()=>null);
      if (oldCh) { const oldMsg = await oldCh.messages.fetch(row.message_id).catch(()=>null); if (oldMsg) await oldMsg.delete().catch(()=>{}); }
    } catch {}
    const embed = new EmbedBuilder()
      .setColor(STEAM_COLOR)
      .setTitle('Steam Leaderboard')
      .setDescription('Collecting stats…\n\n_This shows top stats across linked accounts._')
      .setFooter({ text: 'Auto-updates' })
      .setTimestamp(new Date());
    const msg = await desiredChannel.send({ embeds: [embed] });
    await dbRun('UPDATE leaderboard_msgs SET channel_id=?, message_id=?, updated_at=? WHERE guild_id=?', [desiredChannel.id, msg.id, Math.floor(Date.now()/1000), guild.id]);
    return { channel: desiredChannel, messageId: msg.id };
  }

  const ch = await client.channels.fetch(row.channel_id).catch(()=>null);
  if (!ch) return null;
  return { channel: ch, messageId: row.message_id };
}

async function refreshLeaderboards() {
  const guildIds = await getConfiguredGuildIds();
  for (const gid of guildIds) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;

    const lbChannelConfigured = await getAnnouncementChannel(guild, CHANNEL_KINDS.LEADERBOARD);
    if (!lbChannelConfigured) continue;

    const holder = await ensureLeaderboardMessage(guild, lbChannelConfigured);
    if (!holder) continue;

    const { channel, messageId } = holder;

    const topLife = await dbAll(`SELECT user_id, SUM(playtime_total_min) as m FROM user_game_stats WHERE guild_id=? GROUP BY user_id HAVING m>0 ORDER BY m DESC LIMIT 10`, [gid]);
    const top2w  = await dbAll(`SELECT user_id, SUM(playtime_2w_min) as m FROM user_game_stats WHERE guild_id=? GROUP BY user_id HAVING m>0 ORDER BY m DESC LIMIT 10`, [gid]);
    const topAch = await dbAll(`SELECT user_id, SUM(ach_unlocked) as a FROM user_game_stats WHERE guild_id=? GROUP BY user_id HAVING a>0 ORDER BY a DESC LIMIT 10`, [gid]);
    const since = Math.floor(Date.now()/1000) - 30*86400;
    const topAdds = await dbAll(`SELECT user_id, COUNT(*) as c FROM owned_seen WHERE guild_id=? AND first_seen>=? AND seeded=0 GROUP BY user_id HAVING c>0 ORDER BY c DESC LIMIT 10`, [gid, since]);

    const fmtList = (rows, fmtVal) => rows.length ? rows.map((r,i)=> `${i+1}. <@${r.user_id}> — ${fmtVal(r)}`).join('\n') : '_No data yet_';

    const embed = new EmbedBuilder()
      .setColor(STEAM_COLOR)
      .setTitle('Steam Leaderboard')
      .setDescription('_Top 10 across linked accounts here._')
      .addFields(
        { name: '🏆 Lifetime Playtime (hours)', value: fmtList(topLife, r => `${hours(r.m)}h`), inline: false },
        { name: '⏱️ 2-Week Playtime (hours)', value: fmtList(top2w, r => `${hours(r.m)}h`), inline: false },
        { name: '🎯 Achievements Unlocked (total)', value: fmtList(topAch, r => `${r.a}`), inline: false },
        { name: '🆕 New Games Added (last 30d)', value: fmtList(topAdds, r => `${r.c}`), inline: false },
      )
      .setFooter({ text: 'Auto-updates' })
      .setTimestamp(new Date());

    try {
      const msg = await channel.messages.fetch(messageId).catch(()=>null);
      if (msg) await msg.edit({ embeds: [embed] });
      else {
        const newMsg = await channel.send({ embeds: [embed] });
        await dbRun('UPDATE leaderboard_msgs SET message_id=?, channel_id=?, updated_at=? WHERE guild_id=?', [newMsg.id, channel.id, Math.floor(Date.now()/1000), gid]);
      }
    } catch (e) {
      log.tag('LB').warn(`edit failed guild=${gid}: ${e?.message}`);
    }
  }
}
function scheduleLeaderboardLoop(runNow = false) {
  const run = async () => {
    try { await refreshLeaderboards(); }
    catch (err) { log.tag('LB').error('refreshLeaderboards error:', err?.stack || err); }
    finally { setTimeout(run, LEADERBOARD_POLL_MS); }
  };
  log.tag('LB').info(`Leaderboard refresh every ${Math.round(LEADERBOARD_POLL_MS / 1000)}s`);
  if (runNow) run();
}

/* =========================
 * Seed-burst retro marking
 * ========================= */
async function retroMarkSeededBursts(gid, uid) {
  const totalRow = await dbGet('SELECT COUNT(*) AS total FROM owned_seen WHERE guild_id=? AND user_id=?', [gid, uid]);
  const total = Number(totalRow?.total || 0);
  if (total < 10) return;

  const top = await dbGet(
    `SELECT first_seen, COUNT(*) AS c
     FROM owned_seen WHERE guild_id=? AND user_id=? AND seeded=0
     GROUP BY first_seen ORDER BY c DESC LIMIT 1`,
    [gid, uid]
  );
  if (!top) return;
  const c = Number(top.c || 0);
  if (c >= 10 && c >= Math.ceil(total * 0.5)) {
    await dbRun('UPDATE owned_seen SET seeded=1 WHERE guild_id=? AND user_id=? AND first_seen=? AND seeded=0', [gid, uid, top.first_seen]);
    log.tag('OWNED').info(`retro-marked seeded burst for user=${uid}: ${c}/${total} at ts=${top.first_seen}`);
  }
}

/* =========================
 * Achievements loop
 * ========================= */
const limiter = pLimit(CONCURRENCY);
function scheduleAchievementsLoop(runNow = false) {
  const run = async () => {
    try { await monitorAchievements(); }
    catch (err) { log.tag('POLL').error('monitorAchievements error:', err?.stack || err); }
    finally { setTimeout(run, POLL_MS); }
  };
  log.tag('POLL').info(`Achievements poll every ${Math.round(POLL_MS / 1000)}s, concurrency=${CONCURRENCY}`);
  if (runNow) run();
}
async function monitorAchievements() {
  const t = time('POLL:achievements');
  const guildIds = await getConfiguredGuildIds();
  if (!guildIds.length) { t.end(); return; }

  for (const gid of guildIds) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) { log.tag('ACH').warn(`guild missing cache: ${gid}`); continue; }

    const channel = await getAnnouncementChannel(guild, CHANNEL_KINDS.ACHIEVEMENTS);
    if (!channel) { log.tag('ACH').warn(`no achievements channel set for guild=${gid}`); continue; }
    const perms = hasBotPerms(channel);
    if (!perms.ok) { log.tag('ACH').warn(`missing perms in channel ${channel.id} -> skipping`); continue; }

    const members = await dbAll('SELECT user_id, steam_id FROM links WHERE guild_id=?', [gid]);
    if (!members.length) continue;

    const tasks = members.map(({ user_id, steam_id }) => limiter(async () => {
      try { await guild.members.fetch({ user: user_id }).catch(() => {}); } catch {}
      let recent = [];
      try { recent = (await getRecentlyPlayed(steam_id)).slice(0, RECENT_LIMIT).map(x => x.appid); } catch { recent = []; }
      const appids = Array.from(new Set(recent));
      for (const appid of appids) {
        await achCheckOne(guild, channel, user_id, steam_id, appid);
      }
    }));
    await Promise.all(tasks);
  }
  t.end();
}
async function achCheckOne(guild, channel, userId, steamId, appid) {
  const tag = log.tag(`ACH:${userId}:${appid}`);
  const tw = time(`ACH:${userId}:${appid}`);

  const w = await dbGet('SELECT last_unlock FROM watermarks WHERE guild_id=? AND user_id=? AND appid=?', [guild.id, userId, appid]);
  const hadWatermark = !!w;
  const lastUnlock = w?.last_unlock ? Number(w.last_unlock) : 0;

  let achievements;
  try { achievements = await getPlayerAchievements(steamId, appid); }
  catch (e) { tag.warn(`GetPlayerAchievements failed: ${e?.message}`); tw.end(); return; }
  if (!achievements.length) { tw.end(); return; }

  if ((!hadWatermark && SEED_ON_FIRST_RUN) || (hadWatermark && lastUnlock === 0 && SEED_IF_ZERO)) {
    const latest = achievements.filter(a => a.achieved).reduce((m, a) => Math.max(m, a.unlocktime || 0), 0);
    const seed = latest || Math.floor(Date.now() / 1000);
    await dbRun('INSERT INTO watermarks (guild_id, user_id, appid, last_unlock) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_unlock=VALUES(last_unlock)', [guild.id, userId, appid, seed]);
    tag.info(`seeded watermark=${seed}`);
    tw.end();
    const schema = await getSchema(appid);
    const totalAch = schema?.availableGameStats?.achievements?.length || 0;
    const unlockedCountNow = achievements.filter(x => x.achieved).length;
    await upsertAchievementStats(guild.id, userId, appid, unlockedCountNow, totalAch);
    return;
  }

  const newly = achievements.filter(a => a.achieved && a.unlocktime > lastUnlock).sort((a,b)=>a.unlocktime - b.unlocktime);
  const schema = await getSchema(appid);
  const gameName = schema?.gameName || schema?.game?.gameName || await getAppNameCached(appid);
  const totalAch = schema?.availableGameStats?.achievements?.length || 0;
  const unlockedCountNow = achievements.filter(x => x.achieved).length;

  await upsertAchievementStats(guild.id, userId, appid, unlockedCountNow, totalAch);
  if (!newly.length) { tw.end(); return; }

  const progressPct = totalAch ? ((unlockedCountNow / totalAch) * 100).toFixed(0) : null;
  const progressLine = totalAch ? `${unlockedCountNow}/${totalAch} (${progressPct}%)` : null;
  const progressBar  = totalAch ? makeProgressBar(unlockedCountNow, totalAch, 12) : null;
  const rarityMap = await getGlobalRarity(appid);

  if (BACKFILL_LIMIT > 0 && newly.length > BACKFILL_LIMIT) {
    const latestUnlock = newly[newly.length - 1].unlocktime;
    const subset = newly.slice(-BACKFILL_LIMIT);
    const lines = subset.map(a => {
      const meta = findAchievementMeta(schema, a.apiName);
      const title = meta?.displayName || a.apiName;
      const d = new Date(a.unlocktime * 1000).toLocaleString();
      const pct = rarityMap.get(a.apiName);
      const rare = (pct!=null && pct<=RARE_PCT) ? ` • ✨ ${pct.toFixed(2)}%` : '';
      return `• **${title}**${rare} — ${d}`;
    }).join('\n');
    const extra = newly.length - subset.length;

    const embed = new EmbedBuilder()
      .setColor(STEAM_COLOR)
      .setTitle(`${gameName} • ${newly.length} achievements unlocked`)
      .setDescription(`${lines}${extra > 0 ? `\n…and **${extra}** more earlier unlocks` : ''}`)
      .setFooter({ text: 'Steam Achievement' })
      .setTimestamp(new Date(latestUnlock * 1000));
    if (totalAch && progressLine) embed.addFields({ name: 'Progress', value: `${progressLine}\n${progressBar}`, inline: false });

    await channel.send({ content: `<@${userId}>`, embeds: [embed] });
    await dbRun('INSERT INTO watermarks (guild_id, user_id, appid, last_unlock) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_unlock=VALUES(last_unlock)', [guild.id, userId, appid, latestUnlock]);
    await maybeAnnounceAchMilestone(guild, userId, appid, gameName, totalAch, unlockedCountNow, channel, progressBar);
    tw.end(); return;
  }

  for (const a of newly) {
    const meta  = findAchievementMeta(schema, a.apiName);
    const title = meta?.displayName || a.apiName;
    const desc  = meta?.description || 'Achievement unlocked!';
    const icon  = meta?.icon || null;
    const pct   = rarityMap.get(a.apiName);
    const rareBadge = (pct!=null && pct<=RARE_PCT) ? ` ✨ (${pct.toFixed(2)}% global)` : '';

    const embed = new EmbedBuilder()
      .setColor(STEAM_COLOR)
      .setTitle(`Achievement: ${title}${rareBadge}`)
      .setDescription(`<@${userId}> unlocked **${title}** in **${gameName}**.`)
      .setFooter({ text: 'Steam Achievement' })
      .setTimestamp(new Date(a.unlocktime * 1000));
    if (icon) embed.setThumbnail(icon);

    if (totalAch && progressLine) {
      embed.addFields({ name: 'Details', value: desc, inline: false });
      embed.addFields({ name: 'Progress', value: `${progressLine}\n${progressBar}`, inline: false });
    } else {
      embed.setDescription(`${embed.data.description}\n\n${desc}`);
    }

    await channel.send({ embeds: [embed] });
    await dbRun('INSERT INTO watermarks (guild_id, user_id, appid, last_unlock) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_unlock=VALUES(last_unlock)', [guild.id, userId, appid, a.unlocktime]);
  }

  await maybeAnnounceAchMilestone(guild, userId, appid, gameName, totalAch, unlockedCountNow, channel, progressBar);
  tw.end();
}
function findAchievementMeta(schema, apiName) {
  if (!schema) return null;
  const list = schema?.availableGameStats?.achievements || [];
  const hit = list.find(x => x.name === apiName);
  if (!hit) return null;
  return { displayName: hit.displayName, description: hit.description, icon: hit.icon, icongray: hit.icongray };
}
async function maybeAnnounceAchMilestone(guild, userId, appid, gameName, totalAch, unlockedCountNow, channel, bar) {
  if (!totalAch) return;
  const pct = Math.floor((unlockedCountNow / totalAch) * 100);
  const row = await dbGet('SELECT last_pct FROM ach_progress_marks WHERE guild_id=? AND user_id=? AND appid=?', [guild.id, userId, appid]);
  const last = row ? Number(row.last_pct) : 0;
  const marks = DEFAULT_ACH_MARKS.filter(x => x > last && x <= pct).sort((a,b)=>a-b);
  if (!marks.length) return;
  const hit = marks[marks.length-1];

  await dbRun('INSERT INTO ach_progress_marks (guild_id, user_id, appid, last_pct) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_pct=VALUES(last_pct)', [guild.id, userId, appid, hit]);

  const achChannel = await getAnnouncementChannel(guild, CHANNEL_KINDS.ACHIEVEMENTS);
  if (!achChannel) return;

  const embed = new EmbedBuilder()
    .setColor(STEAM_COLOR)
    .setTitle(`Milestone: ${hit}% in ${gameName}`)
    .setDescription(`<@${userId}> has completed **${hit}%** of achievements.`)
    .addFields({ name: 'Progress', value: `${Math.min(pct,100)}% \n${bar || ''}`, inline: false })
    .setFooter({ text: 'Achievement Milestone' })
    .setTimestamp(new Date());
  await achChannel.send({ embeds: [embed] });
}

/* =========================
 * Owned loop
 * ========================= */
async function getOwnedGames(steamId) {
  const url = `${STEAM_HOST}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1`;
  const t = time('HTTP:GetOwnedGames');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  const games = data?.response?.games || [];
  if (!games.length) {
    log.tag('STEAM').warn(`ownedGames steam=${steamId} -> 0 games (library may be private)`);
  } else {
    log.tag('STEAM').debug(`ownedGames steam=${steamId} -> ${games.length} games`);
  }
  return games.map(g => ({
    appid: g.appid,
    name: g.name,
    img_icon_url: g.img_icon_url || null,
    playtime_forever: g.playtime_forever || 0
  }));
}
function scheduleOwnedLoop(runNow = false) {
  const run = async () => {
    try { await monitorOwnedAdds(); }
    catch (err) { log.tag('OWNED').error('monitorOwnedAdds error:', err?.stack || err); }
    finally { setTimeout(run, OWNED_POLL_MS); }
  };
  log.tag('OWNED').info(`Owned poll every ${Math.round(OWNED_POLL_MS / 1000)}s`);
  if (runNow) run();
}
async function monitorOwnedAdds() {
  const t = time('POLL:owned');
  const guildIds = await getConfiguredGuildIds();
  if (!guildIds.length) { t.end(); return; }

  for (const gid of guildIds) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) { log.tag('OWNED').warn(`guild missing cache: ${gid}`); continue; }

    const newGameCh = await getAnnouncementChannel(guild, CHANNEL_KINDS.NEW_GAMES);
    const milestonesCh = await getAnnouncementChannel(guild, CHANNEL_KINDS.MILESTONES) || newGameCh;
    const libraryCh = await getAnnouncementChannel(guild, CHANNEL_KINDS.LIBRARY) || newGameCh;
    if (!newGameCh) { log.tag('OWNED').warn(`no new-games channel set for guild=${gid}`); continue; }
    const perms1 = hasBotPerms(newGameCh), perms2 = milestonesCh?hasBotPerms(milestonesCh):{ok:true}, perms3 = libraryCh?hasBotPerms(libraryCh):{ok:true};
    if (!perms1.ok || !perms2.ok || !perms3.ok) { log.tag('OWNED').warn(`missing perms -> skipping guild=${gid}`); continue; }

    const members = await dbAll('SELECT user_id, steam_id FROM links WHERE guild_id=?', [gid]);
    if (!members.length) continue;

    for (const { user_id, steam_id } of members) {
      const tt = time(`OWNED:user:${user_id}`);
      try {
        try { await guild.members.fetch({ user: user_id }); } catch {}

        let owned = [];
        try { owned = await getOwnedGames(steam_id); } catch (e) { log.tag('OWNED').warn(`getOwnedGames failed user=${user_id}: ${e?.message}`); continue; }
        if (!owned.length) continue;

        let recentMap = new Map();
        try {
          const rec = await getRecentlyPlayed(steam_id);
          recentMap = new Map(rec.map(x => [x.appid, x.playtime_2weeks || 0]));
        } catch {}

        const now = Math.floor(Date.now() / 1000);

        const seenRow = await dbGet('SELECT COUNT(*) AS c FROM owned_seen WHERE guild_id=? AND user_id=?', [gid, user_id]);
        const seenCount = Number(seenRow?.c || 0);
        if (seenCount === 0 && OWNED_SEED_ON_FIRST) {
          for (const game of owned) {
            await dbRun('INSERT IGNORE INTO owned_seen (guild_id, user_id, appid, first_seen, seeded) VALUES (?, ?, ?, ?, 1)', [gid, user_id, game.appid, now]);
          }
          log.tag('OWNED').info(`seeded owned_seen user=${user_id} count=${owned.length}`);
        }

        await retroMarkSeededBursts(gid, user_id);

        const appids = owned.map(o => o.appid);
        const presentSet = new Set(appids);
        for (const appid of appids) {
          await dbRun('INSERT INTO owned_presence (guild_id, user_id, appid, last_seen, missing_since) VALUES (?, ?, ?, ?, NULL) ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen), missing_since=NULL', [gid, user_id, appid, now]);
        }
        const prevRows = await dbAll('SELECT appid, last_seen, missing_since FROM owned_presence WHERE guild_id=? AND user_id=?', [gid, user_id]);
        for (const row of prevRows) {
          if (!presentSet.has(row.appid)) {
            if (!row.missing_since) {
              await dbRun('UPDATE owned_presence SET missing_since=? WHERE guild_id=? AND user_id=? AND appid=?', [now, gid, user_id, row.appid]);
            } else if (now - Number(row.missing_since) >= OWNED_REMOVAL_GRACE_MIN * 60) {
              const appName = await getAppNameCached(row.appid);
              const embed = new EmbedBuilder()
                .setColor(STEAM_COLOR)
                .setTitle(`Game Removed: ${appName}`)
                .setDescription(`<@${user_id}>'s library no longer shows this title.`)
                .setFooter({ text: 'Steam Library' })
                .setTimestamp(new Date());
              await libraryCh.send({ embeds: [embed] });
              await dbRun('DELETE FROM owned_presence WHERE guild_id=? AND user_id=? AND appid=?', [gid, user_id, row.appid]);
            }
          }
        }

        const existingSet = new Set((await dbAll(`SELECT appid FROM owned_seen WHERE guild_id=? AND user_id=?`, [gid, user_id])).map(r=>r.appid));
        const newly = owned.filter(o => !existingSet.has(o.appid));
        if (newly.length) {
          for (const gm of newly) {
            await dbRun('INSERT IGNORE INTO owned_seen (guild_id, user_id, appid, first_seen, seeded) VALUES (?, ?, ?, ?, 0)', [gid, user_id, gm.appid, now]);
          }
          if (newly.length > OWNED_ANNOUNCE_LIMIT) {
            const subset = newly.slice(-OWNED_ANNOUNCE_LIMIT);
            const extra = newly.length - subset.length;
            const lines = subset.map(gm => `• **${gm.name || `App ${gm.appid}`}**`).join('\n');
            const embed = new EmbedBuilder()
              .setColor(STEAM_COLOR)
              .setTitle(`New Games Added to Library`)
              .setDescription(`${lines}${extra > 0 ? `\n…and **${extra}** more` : ''}`)
              .setFooter({ text: 'Steam Library' })
              .setTimestamp(new Date());
            await newGameCh.send({ content: `<@${user_id}>`, embeds: [embed] });
          } else {
            for (const gm of newly) {
              const embed = new EmbedBuilder()
                .setColor(STEAM_COLOR)
                .setTitle(`Added: ${gm.name || `App ${gm.appid}`}`)
                .setDescription(`<@${user_id}> added **${gm.name || `App ${gm.appid}`}** to their Steam library.`)
                .setThumbnail(appIconUrl(gm.appid, gm.img_icon_url))
                .setFooter({ text: 'Steam Library' })
                .setTimestamp(new Date());
              await newGameCh.send({ embeds: [embed] });
            }
          }
        }

        for (const gm of owned) {
          const totalMin = gm.playtime_forever || 0;
          const twoWMin  = recentMap.get(gm.appid) || 0;
          await upsertPlaytimeStats(gid, user_id, gm.appid, totalMin, twoWMin);
        }

      } finally { tt.end(); }
    }
  }
  t.end();
}

/* =========================
 * Now-Playing loop
 * ========================= */
function scheduleNowPlayingLoop(runNow = false) {
  const run = async () => {
    try { await monitorNowPlaying(); }
    catch (err) { log.tag('NOW').error('monitorNowPlaying error:', err?.stack || err); }
    finally { setTimeout(run, NOWPLAYING_POLL_MS); }
  };
  log.tag('NOW').info(`Now-playing poll every ${Math.round(NOWPLAYING_POLL_MS / 1000)}s`);
  if (runNow) run();
}
async function monitorNowPlaying() {
  const t = time('POLL:nowplaying');
  const guildIds = await getConfiguredGuildIds();
  if (!guildIds.length) { t.end(); return; }

  for (const gid of guildIds) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) { log.tag('NOW').warn(`guild missing cache: ${gid}`); continue; }

    const channel = await getAnnouncementChannel(guild, CHANNEL_KINDS.NOW_PLAYING);
    if (!channel) continue;
    const perms = hasBotPerms(channel);
    if (!perms.ok) { log.tag('NOW').warn(`missing perms in channel ${channel.id} -> skipping`); continue; }

    const members = await dbAll('SELECT user_id, steam_id FROM links WHERE guild_id=?', [gid]);
    if (!members.length) continue;

    for (const { user_id, steam_id } of members) {
      const now = Math.floor(Date.now() / 1000);
      let current = null;
      try { current = await getCurrentGame(steam_id); } catch (e) { log.tag('NOW').warn(`GetPlayerSummaries failed user=${user_id}: ${e?.message}`); }

      const states = await dbAll('SELECT appid, started_at, last_seen_at, announced FROM nowplaying_state WHERE guild_id=? AND user_id=?', [gid, user_id]);

      if (current) {
        const st = states.find(s => s.appid === current.appid);
        if (!st) {
          const seedAnnounced = NOWPLAYING_SEED_ON_FIRST_RUN && states.length === 0;
          await dbRun('INSERT INTO nowplaying_state (guild_id, user_id, appid, started_at, last_seen_at, announced) VALUES (?, ?, ?, ?, ?, ?)', [gid, user_id, current.appid, now, now, seedAnnounced ? 1 : 0]);
        } else {
          await dbRun('UPDATE nowplaying_state SET last_seen_at=? WHERE guild_id=? AND user_id=? AND appid=?', [now, gid, user_id, current.appid]);
          if (!st.announced && (now - Number(st.started_at)) >= NOWPLAYING_CONFIRM_SECONDS) {
            const embed = new EmbedBuilder()
              .setColor(STEAM_COLOR)
              .setTitle(`Now Playing: ${current.name}`)
              .setDescription(`<@${user_id}> just started playing.`)
              .setFooter({ text: 'Now Playing' })
              .setTimestamp(new Date());
            await channel.send({ embeds: [embed] });
            await dbRun('UPDATE nowplaying_state SET announced=1 WHERE guild_id=? AND user_id=? AND appid=?', [gid, user_id, current.appid]);
          }
        }
      }

      for (const s of states) {
        const stillCurrent = current && current.appid === s.appid;
        if (stillCurrent) continue;
        if (now - Number(s.last_seen_at) >= NOWPLAYING_IDLE_TIMEOUT_SECONDS) {
          const durationMin = Math.max(0, Math.floor((Number(s.last_seen_at) - Number(s.started_at)) / 60));
          if (s.announced && durationMin >= SESSION_MIN_MINUTES) {
            const name = await getAppNameCached(s.appid);
            const embed = new EmbedBuilder()
              .setColor(STEAM_COLOR)
              .setTitle(`Session Ended: ${name}`)
              .setDescription(`<@${user_id}> played for **${fmtDuration(durationMin)}**.`)
              .setFooter({ text: 'Session Recap' })
              .setTimestamp(new Date());
            await channel.send({ embeds: [embed] });
          }
          await dbRun('DELETE FROM nowplaying_state WHERE guild_id=? AND user_id=? AND appid=?', [gid, user_id, s.appid]);
        }
      }
    }
  }
  t.end();
}

/* =========================
 * SALES: Games-only, accurate, LRU cache, prewarm + full warm, race-proof buttons
 * ========================= */
const SALES_TAG = log.tag('SALES');

// Store axios: cookie jar + UA + referer
const storeAxios = axios.create({
  baseURL: 'https://store.steampowered.com',
  timeout: 15_000, // keep shorter to avoid 50s stalls
  withCredentials: true,
});
axiosCookieJarSupport(storeAxios);
storeAxios.defaults.jar = new tough.CookieJar();
storeAxios.defaults.headers.common['User-Agent'] =
  process.env.STORE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
storeAxios.defaults.headers.common['Accept'] = 'application/json, text/javascript, */*; q=0.01';
storeAxios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';
const SEARCH_REFERER = (cc) => `https://store.steampowered.com/search/?specials=1&category1=998&cc=${cc}&l=en`;

// Session bootstrap to dodge 403 and mature gate
let cryptoWeb;
try { cryptoWeb = require('node:crypto').webcrypto; } catch { cryptoWeb = { getRandomValues: (a) => require('crypto').randomFillSync(a) }; }
function randomHex(n) { return [...cryptoWeb.getRandomValues(new Uint8Array(n/2))].map(b=>b.toString(16).padStart(2,'0')).join(''); }

async function bootstrapStoreSession(cc = SALES_REGION_CC) {
  const jar = storeAxios.defaults.jar;
  const sessionid = randomHex(32);
  await jar.setCookie(`sessionid=${sessionid}; Path=/; Secure; SameSite=None; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  await jar.setCookie(`steamCountry=${encodeURIComponent(cc)}%7C0%7C; Path=/; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  await jar.setCookie(`timezoneOffset=0,0; Path=/; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  await jar.setCookie(`birthtime=0; lastagecheckage=1-January-1970; mature_content=1; Path=/; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  try { await storeAxios.get('/', { params: { cc, l: 'en' } }); } catch {}
}
let storeReady = false;
async function ensureStoreSession(cc) {
  if (!storeReady) { await bootstrapStoreSession(cc); storeReady = true; }
}

async function fetchSearchJson(cc, start, count) {
  await ensureStoreSession(cc);
  const params = {
    query: '',
    specials: 1,
    category1: 998,
    cc,
    l: 'en',
    start,
    count,
    infinite: 1,
    force_infinite: 1,
    dynamic_data: 1,
    no_cache: 1,
    sort_by: SALES_SORT_BY,
    _: Date.now(), // cache-buster
  };
  const headers = {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': SEARCH_REFERER(cc),
  };

  const doGet = async () => {
    const { data } = await storeAxios.get('/search/results/', { params, headers });
    if (!data || typeof data !== 'object' || data.success !== 1) {
      throw new Error('Unexpected search response');
    }
    return data;
  };

  try {
    return await doGet();
  } catch (e) {
    if (e.response?.status === 403) {
      SALES_TAG.warn('403 on search; re-bootstrapping session and retrying…');
      await bootstrapStoreSession(cc);
      return await doGet();
    }
    throw e;
  }
}


async function fetchSearchPageHtml(cc, pageIndex) {
  await ensureStoreSession(cc);
  const params = {
    specials: 1,
    category1: 998,
    cc,
    l: 'en',
    page: pageIndex + 1,     // full page numbering is 1-based
    sort_by: SALES_SORT_BY,
    no_cache: 1
  };
  const headers = { 'Referer': SEARCH_REFERER(cc) };
  const { data: html } = await storeAxios.get('/search/', { params, headers, responseType: 'text' });
  return String(html || '');
}


/* Robust price parsing across locales (e.g., $9.99, 9,99€, R$ 19,99) */
function priceToNumber(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.,]+/g);
  if (!m) return null;
  const raw = m[m.length - 1]; // use last number-like chunk
  let digits = raw.replace(/[^\d.,]/g, '');
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  const sepIdx = Math.max(lastComma, lastDot);
  if (sepIdx >= 0) {
    const intPart = digits.slice(0, sepIdx).replace(/[.,]/g, '');
    const fracPart = digits.slice(sepIdx + 1).replace(/[.,]/g, '');
    return parseFloat(`${intPart}.${fracPart}`);
  }
  return parseFloat(digits.replace(/[.,]/g, ''));
}

function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.search_result_row').each((_, el) => {
    const a = $(el);
    const idAttr = a.attr('data-ds-appid');
    if (!idAttr) return; // skip bundles/packages
    const id = Number(String(idAttr).split(',')[0]);
    if (!id || Number.isNaN(id)) return;

    const name = a.find('.title').first().text().trim() || `App ${id}`;

    // Prefer explicit percentage if present
    let discount_percent = 0;
    const pctText = a.find('.search_discount .discount_pct').first().text().trim() || a.find('.discount_pct').first().text().trim();
    if (pctText) discount_percent = Math.abs(parseInt(pctText.replace(/[^\d-]/g,''), 10) || 0);

    // Extract price info (newer markup uses .discount_block)
    let final_price_str = null;
    let original_price_str = null;

    const discBlock = a.find('.discount_block').first();
    if (discBlock.length) {
      const fp = discBlock.find('.discount_final_price').first().text().trim();
      const op = discBlock.find('.discount_original_price').first().text().trim();
      if (fp) final_price_str = fp;
      if (op) original_price_str = op;
    }

    // Fallback: legacy .search_price text
    if (!final_price_str) {
      const priceNode = a.find('.search_price').first();
      const txt = priceNode.text().replace(/\s+/g,' ').trim();
      if (txt) {
        // Typically: "Was $59.99 Now $29.99" or "$59.99 $29.99"
        const tokens = txt.split(' ').filter(Boolean);
        // grab numeric-like tokens
        const nums = tokens.filter(t => /[\d]/.test(t));
        if (nums.length >= 2) {
          original_price_str = nums[0];
          final_price_str = nums[nums.length - 1];
        } else if (nums.length === 1) {
          final_price_str = nums[0];
        } else {
          final_price_str = txt; // maybe "Free", "Free to Play", etc.
        }
      }
    }

    // Compute % if Steam omitted it
    const finalNum = priceToNumber(final_price_str);
    const origNum  = priceToNumber(original_price_str);
    if ((!discount_percent || discount_percent <= 0) && finalNum != null && origNum != null && finalNum < origNum) {
      discount_percent = Math.max(1, Math.round((1 - (finalNum / origNum)) * 100));
    }

    // Keep only real discounts
    const isDiscounted = discount_percent > 0 || (finalNum != null && origNum != null && finalNum < origNum);
    if (!isDiscounted) return;

    const finalStr = final_price_str || 'Free';
    const urlRaw = (a.attr('href') || '').split('?')[0];
    const url = urlRaw && /\/app\/\d+/.test(urlRaw) ? urlRaw : `https://store.steampowered.com/app/${id}/`;
    out.push({ id, name, discount_percent, final_price_str: finalStr, original_price_str, url });
  });
  return out;
}

/* LRU page cache (data only) */
const pageCache = new Map(); // key -> { until, items, totalPages }
const pageInflight = new Map(); // key -> Promise
function lruTouch(key, val) {
  if (pageCache.has(key)) pageCache.delete(key);
  pageCache.set(key, val);
  while (pageCache.size > SALES_MAX_PAGES_CACHE) {
    const firstKey = pageCache.keys().next().value;
    pageCache.delete(firstKey);
  }
}
function cacheDataGet(cc, idx) {
  const key = `${cc}:${idx}`;
  const hit = pageCache.get(key);
  if (hit && hit.until > Date.now()) {
    if (SALES_EXTEND_TTL_ON_HIT) hit.until = Date.now() + SALES_PAGE_TTL_MS;
    lruTouch(key, hit);
    return hit;
  }
  if (hit) pageCache.delete(key);
  return null;
}
function cacheDataSet(cc, idx, items, totalPages) {
  const key = `${cc}:${idx}`;
  const val = { until: Date.now() + SALES_PAGE_TTL_MS, items, totalPages };
  lruTouch(key, val);
  return val;
}

/* Prewarm queue with spacing + dedupe */
const warmingSet = new Set();
function jitter(ms, j=0.3){ return Math.max(0, Math.round(ms * (1 - j + Math.random()*2*j))); }
function scheduleWarm(cc, idx, delay) {
  const key = `${cc}:${idx}`;
  if (warmingSet.has(key) || cacheDataGet(cc, idx)) return;
  warmingSet.add(key);
  setTimeout(async () => {
    try { await getPageData(cc, idx); SALES_TAG.trace(`prewarm ok ${key}`); }
    catch (e) { SALES_TAG.debug(`prewarm fail ${key}: ${e?.message}`); }
    finally { warmingSet.delete(key); }
  }, delay);
}

function idsOf(items){ return items.map(it => it.id).join(','); }
function sameIds(a,b){ return a && b && idsOf(a) === idsOf(b); }

async function getPageData(cc, pageIndex) {
  const cached = cacheDataGet(cc, pageIndex);
  if (cached) return cached;

  const key = `${cc}:${pageIndex}`;
  if (pageInflight.has(key)) return pageInflight.get(key);

  const fetchPromise = (async () => {
    const start = pageIndex * SALES_PAGE_SIZE;
    const t = time(`SALES:fetch:${cc}:${pageIndex}`);
    const data = await fetchSearchJson(cc, start, SALES_PAGE_SIZE);
    let items = parseSearchHtml(data.results_html || '');

    // Compute total pages (robust)
    const rawTotal = Number(data.total_count);
    let totalPages;
    if (Number.isFinite(rawTotal) && rawTotal > 0) {
      totalPages = Math.max(1, Math.ceil(rawTotal / SALES_PAGE_SIZE));
    } else {
      totalPages = items.length === SALES_PAGE_SIZE ? (pageIndex + 2) : (pageIndex + 1);
    }

    // 🔁 Fallback: if Steam gave us the same IDs as the previous page, grab the full HTML page
    const prev = cacheDataGet(cc, pageIndex - 1);
    if (prev && sameIds(prev.items, items)) {
      try {
        const html = await fetchSearchPageHtml(cc, pageIndex);
        const alt = parseSearchHtml(html);
        if (alt.length) {
          // Match our page size; Steam's full page may be 25 items
          items = alt.slice(0, SALES_PAGE_SIZE);
          // Update totalPages pessimistically if needed
          if (alt.length < SALES_PAGE_SIZE && totalPages < pageIndex + 1) {
            totalPages = pageIndex + 1;
          }
        }
      } catch (e) {
        SALES_TAG.debug(`fallback page fetch failed p=${pageIndex}: ${e?.message}`);
      }
    }

    t.end();
    const fresh = cacheDataSet(cc, pageIndex, items, totalPages);
    SALES_TAG.trace(`p${pageIndex} ids=`, items.map(i=>i.id).join(','));
    return fresh;
  })();

  pageInflight.set(key, fetchPromise);
  fetchPromise.finally(() => { pageInflight.delete(key); });
  return fetchPromise;
}



function saleItemToLine(it) {
  const off = it.discount_percent ?? 0;
  const fin = (it.final_price_str && it.final_price_str.trim()) || 'Free';
  const orig = it.original_price_str ? ` ~~${it.original_price_str}~~` : '';
  return `**${it.name}** — ${off}% off • ${fin}${orig ? ` ${orig}` : ''} — [Store](${it.url})`;
}


/* Epoch map per message to race-proof UI */
const navEpoch = new Map(); // messageId -> int

function buildSalesEmbed(cc, pageIndex, items, totalPages) {
  const lines = items.length ? items.map(saleItemToLine).join('\n\n') : '_No discounted games found._';
  return new EmbedBuilder()
    .setColor(STEAM_COLOR)
    .setTitle(`Steam Game Sales — page ${Math.min(pageIndex+1, totalPages)}/${totalPages}`)
    .setDescription(lines)
    .setFooter({ text: `Showing ${items.length} items • ${SALES_PAGE_SIZE} per page • Region ${cc}` })
    .setTimestamp(new Date());
}
function buildSalesComponents(cc, pageIndex, totalPages, epoch) {
  const prevBtn = new ButtonBuilder()
    .setCustomId(`sales_nav:${cc}:${pageIndex-1}:${epoch}`)
    .setLabel('◀️ Prev')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(pageIndex <= 0);
  const nextBtn = new ButtonBuilder()
    .setCustomId(`sales_nav:${cc}:${pageIndex+1}:${epoch}`)
    .setLabel('Next ▶️')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(pageIndex >= totalPages-1);
  return [ new ActionRowBuilder().addComponents(prevBtn, nextBtn) ];
}

/* Prewarm helper around current */
function prewarmAround(cc, pageIndex, totalPages) {
  const upcoming = [];
  for (let i = 1; i <= SALES_PRECACHE_PAGES; i++) {
    const idx = pageIndex + i;
    if (idx >= totalPages) break;
    upcoming.push({ idx, distance: i });
  }
  for (let i = 1; i <= SALES_PRECACHE_PREV_PAGES; i++) {
    const idx = pageIndex - i;
    if (idx < 0) break;
    upcoming.push({ idx, distance: i });
  }
  upcoming
    .sort((a, b) => a.distance - b.distance)
    .forEach(({ idx }, order) => {
      const delay = jitter(SALES_PREWARM_SPACING_MS * (order + 1));
      scheduleWarm(cc, idx, delay);
    });
}

/* Permanent sales message + periodic refresh */
async function ensureSalesMessage(guild, targetChannel = null) {
  const row = await dbGet('SELECT channel_id, message_id FROM sales_msgs WHERE guild_id=?', [guild.id]);
  const configured = await getAnnouncementChannel(guild, CHANNEL_KINDS.SALES);
  const desiredChannel = targetChannel || configured;
  if (!desiredChannel) return null;

  if (!row) {
    const { items, totalPages } = await getPageData(SALES_REGION_CC, 0);
    const embed = buildSalesEmbed(SALES_REGION_CC, 0, items, totalPages);
    const epoch = 1;
    const components = buildSalesComponents(SALES_REGION_CC, 0, totalPages, epoch);
    const msg = await desiredChannel.send({ embeds: [embed], components });
    navEpoch.set(msg.id, epoch);
    prewarmAround(SALES_REGION_CC, 0, totalPages);
    await dbRun('INSERT INTO sales_msgs (guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)', [guild.id, desiredChannel.id, msg.id, Math.floor(Date.now()/1000)]);
    return { channel: desiredChannel, messageId: msg.id };
  }

  if (row.channel_id !== desiredChannel.id) {
    try {
      const oldCh = await client.channels.fetch(row.channel_id).catch(()=>null);
      if (oldCh) { const oldMsg = await oldCh.messages.fetch(row.message_id).catch(()=>null); if (oldMsg) await oldMsg.delete().catch(()=>{}); }
    } catch {}
    const { items, totalPages } = await getPageData(SALES_REGION_CC, 0);
    const embed = buildSalesEmbed(SALES_REGION_CC, 0, items, totalPages);
    const epoch = 1;
    const components = buildSalesComponents(SALES_REGION_CC, 0, totalPages, epoch);
    const msg = await desiredChannel.send({ embeds: [embed], components });
    navEpoch.set(msg.id, epoch);
    prewarmAround(SALES_REGION_CC, 0, totalPages);
    await dbRun('UPDATE sales_msgs SET channel_id=?, message_id=?, updated_at=? WHERE guild_id=?', [desiredChannel.id, msg.id, Math.floor(Date.now()/1000), guild.id]);
    return { channel: desiredChannel, messageId: msg.id };
  }

  const ch = await client.channels.fetch(row.channel_id).catch(()=>null);
  if (!ch) return null;
  return { channel: ch, messageId: row.message_id };
}

async function refreshSalesForAllGuilds() {
  const guildIds = await getConfiguredGuildIds();
  for (const gid of guildIds) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;
    const salesCh = await getAnnouncementChannel(guild, CHANNEL_KINDS.SALES);
    if (!salesCh) continue;
    const holder = await ensureSalesMessage(guild, salesCh);
    if (!holder) continue;
    const { channel, messageId } = holder;
    try {
      const { items, totalPages } = await getPageData(SALES_REGION_CC, 0);
      const embed = buildSalesEmbed(SALES_REGION_CC, 0, items, totalPages);
      const epoch = (navEpoch.get(messageId) || 0) + 1;
      const components = buildSalesComponents(SALES_REGION_CC, 0, totalPages, epoch);
      const msg = await channel.messages.fetch(messageId).catch(()=>null);
      if (msg) {
        await msg.edit({ embeds: [embed], components });
        navEpoch.set(messageId, epoch);
        prewarmAround(SALES_REGION_CC, 0, totalPages);
        await dbRun('UPDATE sales_msgs SET updated_at=? WHERE guild_id=?', [Math.floor(Date.now()/1000), gid]);
      } else {
        const newMsg = await channel.send({ embeds: [embed], components });
        navEpoch.set(newMsg.id, epoch);
        prewarmAround(SALES_REGION_CC, 0, totalPages);
        await dbRun('UPDATE sales_msgs SET message_id=?, channel_id=?, updated_at=? WHERE guild_id=?', [newMsg.id, channel.id, Math.floor(Date.now()/1000), gid]);
      }
    } catch (e) {
      SALES_TAG.warn(`refresh failed guild=${gid}: ${e?.message}`);
    }
  }
}
function scheduleSalesLoop(runNow = false) {
  const run = async () => {
    try { await refreshSalesForAllGuilds(); }
    catch (err) { SALES_TAG.error('refreshSalesForAllGuilds error:', err?.stack || err); }
    finally { setTimeout(run, SALES_POLL_MS); }
  };
  SALES_TAG.info(`Sales refresh every ${Math.round(SALES_POLL_MS / 1000)}s`);
  if (runNow) run();
}

/* Button interaction (epoch + deferUpdate) */
async function handleButtonInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('sales_nav:')) return;

  const parts = id.split(':'); // sales_nav:cc:page:epoch
  if (parts.length < 4) return interaction.reply({ content: 'Malformed button.', ephemeral: true }).catch(()=>{});

  const cc = parts[1] || SALES_REGION_CC;
  const requestedPage = Math.max(0, Number(parts[2] || 0));
  const msgId = interaction.message?.id;
  if (!msgId) return interaction.reply({ content: 'Missing message context.', ephemeral: true }).catch(()=>{});

  // Race guard
  const myEpoch = (navEpoch.get(msgId) || 0) + 1;
  navEpoch.set(msgId, myEpoch);

  // Acknowledge immediately to avoid "click too fast" issues
  await interaction.deferUpdate().catch(()=>{});

  try {
    const data = await getPageData(cc, requestedPage);
    // Drop if a newer click happened while we were fetching
    if ((navEpoch.get(msgId) || 0) !== myEpoch) return;

    const embed = buildSalesEmbed(cc, requestedPage, data.items, data.totalPages);
    const components = buildSalesComponents(cc, requestedPage, data.totalPages, myEpoch);
    await interaction.editReply({ embeds: [embed], components }).catch(()=>{});

    prewarmAround(cc, requestedPage, data.totalPages);
  } catch (e) {
    SALES_TAG.error('button handler error:', e?.stack || e);
    // Still drop a minimal update so UI doesn't get stuck
    try { await interaction.editReply({ content: `Error: ${e.message || e}`, components: [] }); } catch {}
  }
}

/* Eventual full warm (1 → total), spaced to avoid timeouts */
let fullWarmTimer = null;
function startFullSalesWarm(cc = SALES_REGION_CC) {
  if (fullWarmTimer) return;
  setTimeout(async () => {
    SALES_TAG.info(`Starting full warm for region ${cc}…`);
    try {
      const first = await getPageData(cc, 0);
      const totalPages = first.totalPages;
      // warm page 0 already fetched, start at 1
      let page = 1;
      fullWarmTimer = setInterval(async () => {
        if (page >= totalPages) {
          clearInterval(fullWarmTimer); fullWarmTimer = null; SALES_TAG.info('Full warm complete.');
          return;
        }
        if (!cacheDataGet(cc, page)) {
          try { await getPageData(cc, page); SALES_TAG.trace(`warm ok ${cc}:${page}/${totalPages}`); }
          catch (e) { SALES_TAG.debug(`warm fail ${cc}:${page}: ${e?.message}`); }
        }
        page++;
      }, SALES_FULL_WARMER_SPACING_MS);
    } catch (e) {
      SALES_TAG.warn(`Full warm bootstrap failed: ${e?.message}`);
    }
  }, SALES_FULL_WARMER_DELAY_MS);
}

/* Misc */
function appIconUrl(appid, img_icon_url) {
  if (!img_icon_url) return null;
  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${img_icon_url}.jpg`;
}

/* =========================
 * Boot
 * ========================= */
(async () => {
  const t = time('BOOT');
  try {
    await initDb();
    await client.login(DISCORD_TOKEN);
    log.tag('BOOT').info('Client login requested.');
  } catch (e) {
    log.tag('BOOT').error('Startup failed:', e?.stack || e);
    process.exit(1);
  } finally { t.end(); }
})();
