// file: index.js
require('dotenv').config();

const axios = require('axios').default;
const {
  log,
  time,
  DEBUG_HTTP,
  DEBUG_SQL,
  DEBUG_LEVEL,
  redact,
} = require('./src/logger');
const {
  DISCORD_TOKEN,
  SALES_REGION_CC,
  SALES_PAGE_SIZE,
  SALES_PRECACHE_PAGES,
  SALES_PRECACHE_PREV_PAGES,
  SALES_PREWARM_SPACING_MS,
  SALES_PAGE_TTL_MS,
  SALES_MAX_PAGES_CACHE,
  SALES_EXTEND_TTL_ON_HIT,
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
  BACKFILL_LIMIT,
  GITHUB_ANNOUNCER_ENABLED,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GITHUB_POLL_MS,
  GITHUB_ANNOUNCE_ON_START,
  GITHUB_MAX_CATCHUP,
} = require('./src/config');
const { client } = require('./src/discord/client');
const { registerCommandsOnStartup, handleChatCommand } = require('./src/discord/commands');
const { registerLogging } = require('./src/discord/logging');
const { awardMessageXp } = require('./src/discord/xp');
const { messageHasLink, hasActivePermit, isStaff } = require('./src/discord/permits');
const { enforceContentModeration } = require('./src/discord/moderation');
const { scheduleAchievementsLoop } = require('./src/loops/achievements');
const { scheduleOwnedLoop } = require('./src/loops/owned');
const { scheduleNowPlayingLoop } = require('./src/loops/nowPlaying');
const { scheduleLeaderboardLoop } = require('./src/loops/leaderboard');
const { scheduleSalesLoop, handleButtonInteraction, startFullSalesWarm } = require('./src/sales/index');
const { scheduleGithubLoop } = require('./src/github/announcer');
const { initDb } = require('./src/db');
const { Events } = require('discord.js');

process.on('unhandledRejection', (e) => log.tag('UNHANDLED').error('Promise rejection:', e?.stack || e));
process.on('uncaughtException', (e) => log.tag('UNCAUGHT').error('Exception:', e?.stack || e));

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

log.info('Config:', JSON.stringify({
  SALES_REGION_CC,
  SALES_PAGE_SIZE,
  SALES_PRECACHE_PAGES,
  SALES_PRECACHE_PREV_PAGES,
  SALES_PREWARM_SPACING_MS,
  SALES_PAGE_TTL_MS,
  SALES_MAX_PAGES_CACHE,
  SALES_EXTEND_TTL_ON_HIT,
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
  BACKFILL_LIMIT,
  GITHUB_ANNOUNCER_ENABLED,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GITHUB_POLL_MS,
  GITHUB_ANNOUNCE_ON_START,
  GITHUB_MAX_CATCHUP,
  DEBUG_LEVEL,
  DEBUG_HTTP,
  DEBUG_SQL,
}));

registerLogging();

client.once(Events.ClientReady, async (c) => {
  log.tag('READY').info(`Logged in as ${c.user.tag}`);
  await registerCommandsOnStartup();

  scheduleAchievementsLoop(true);
  scheduleOwnedLoop(true);
  scheduleNowPlayingLoop(true);
  scheduleLeaderboardLoop(true);
  scheduleSalesLoop(true);
  scheduleGithubLoop(true);

  if (SALES_FULL_WARMER_ENABLED) startFullSalesWarm(SALES_REGION_CC);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const tag = `CMD:${interaction.commandName}`;
      log.tag(tag).info(`from user=${interaction.user.id} in guild=${interaction.guildId}`);
      await handleChatCommand(interaction);
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

client.on(Events.MessageCreate, async (message) => {
  try {
    await awardMessageXp(message);
  } catch (err) {
    log.tag('XP').error('Failed to award message XP:', err?.stack || err);
  }

  if (!message.guild || message.author.bot) return;

  let member = message.member;
  if (!member) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }

  if (!isStaff(member)) {
    try {
      const removed = await enforceContentModeration(message);
      if (removed) return;
    } catch (err) {
      log.tag('MODERATION').error('Failed to evaluate message for moderation:', err?.stack || err);
    }
  }

  if (!messageHasLink(message)) return;

  try {
    if (isStaff(member)) return;

    const permitted = await hasActivePermit(message.guild.id, message.author.id);
    if (permitted) return;

    await message.delete().catch(() => {});
    await message.author.send(`Your message in **${message.guild.name}** was removed because posting links requires a staff permit.`).catch(() => {});
    log.tag('PERMIT').info(`Deleted link from user=${message.author.id} guild=${message.guild.id}`);
  } catch (err) {
    log.tag('PERMIT').error('Failed to enforce link permit:', err?.stack || err);
  }
});

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
