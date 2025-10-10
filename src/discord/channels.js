/**
 * Channel configuration helpers. Guild owners can opt-in to specific announcement feeds by mapping
 * semantic "kinds" (achievements, sales, etc.) to concrete Discord channels. The helpers below
 * normalise user input, fetch persisted configuration, and check for required permissions before an
 * announcement is emitted.
 */
const { ChannelType, PermissionsBitField } = require('discord.js');
const { dbGet, dbAll } = require('../db');

const CHANNEL_KINDS = {
  ACHIEVEMENTS: 'achievements',
  NEW_GAMES: 'new_games',
  NOW_PLAYING: 'now_playing',
  MILESTONES: 'milestones',
  LIBRARY: 'library',
  LEADERBOARD: 'leaderboard',
  SALES: 'steam_game_sales',
  XP: 'xp_levelups',
  LOGGING: 'logging',
  GITHUB: 'github_commits',
  MUSIC: 'music',
};

/**
 * Maps user-provided strings to a canonical channel kind. Normalisation allows the slash commands
 * to accept friendly aliases ("achievements", "steam achievements", etc.) without persisting
 * inconsistent data.
 *
 * @param {string} s - Arbitrary user input.
 * @returns {string|null} Canonical kind or `null` when the input is not recognised.
 */
function normalizeKind(s) {
  const v = String(s || '').toLowerCase().replace(/\s+/g, '_');
  if (['achievements','steam_achievements','steamachievements'].includes(v)) return CHANNEL_KINDS.ACHIEVEMENTS;
  if (['new_games','new_game_notifications','notifications','library_adds'].includes(v)) return CHANNEL_KINDS.NEW_GAMES;
  if (['now_playing','nowplaying','sessions'].includes(v)) return CHANNEL_KINDS.NOW_PLAYING;
  if (['milestones','progress'].includes(v)) return CHANNEL_KINDS.MILESTONES;
  if (['library','removals','library_removals'].includes(v)) return CHANNEL_KINDS.LIBRARY;
  if (['leaderboard','lb','boards'].includes(v)) return CHANNEL_KINDS.LEADERBOARD;
  if (['steam_sales','sales','store_sales','steam_sales_board','steam_game_sales'].includes(v)) return CHANNEL_KINDS.SALES;
  if (['xp','levels','level_ups','levelups','xp_levelups','xp_announcements'].includes(v)) return CHANNEL_KINDS.XP;
  if (['log','logs','logging','mod_logs','server_logs'].includes(v)) return CHANNEL_KINDS.LOGGING;
  if (['github','commits','github_commits','github_updates','gh'].includes(v)) return CHANNEL_KINDS.GITHUB;
  if (['music','songs','dj','jukebox'].includes(v)) return CHANNEL_KINDS.MUSIC;
  return null;
}

/**
 * Resolves the configured announcement channel for a guild and kind. Backwards compatibility is
 * maintained by falling back to the legacy `guilds` table when no kind-specific mapping exists.
 *
 * @param {import('discord.js').Guild} guild - Guild whose configuration we should inspect.
 * @param {string} kind - Channel type constant from `CHANNEL_KINDS`.
 * @returns {Promise<import('discord.js').GuildBasedChannel|null>} Cached channel or `null`.
 */
async function getAnnouncementChannel(guild, kind) {
  const row = await dbGet('SELECT channel_id FROM guild_channels WHERE guild_id=? AND kind=?', [guild.id, kind]);
  let channelId = row?.channel_id;
  if (!channelId) {
    const legacy = await dbGet('SELECT channel_id FROM guilds WHERE guild_id=?', [guild.id]);
    channelId = legacy?.channel_id || null;
  }
  return channelId ? guild.channels.cache.get(channelId) : null;
}

/**
 * Returns a deduplicated list of guild IDs that have any form of configuration. Useful for iterating
 * through all known guilds when running maintenance tasks (e.g. re-seeding caches).
 *
 * @returns {Promise<string[]>}
 */
async function getConfiguredGuildIds() {
  const legacy = await dbAll('SELECT DISTINCT guild_id FROM guilds');
  const typed  = await dbAll('SELECT DISTINCT guild_id FROM guild_channels');
  const set = new Set();
  legacy.forEach(r => set.add(r.guild_id));
  typed .forEach(r => set.add(r.guild_id));
  return Array.from(set);
}

/**
 * Verifies that the bot has the bare minimum permissions required to post embeds to a channel. By
 * returning the missing permission names we can surface actionable error messages to moderators.
 *
 * @param {import('discord.js').GuildBasedChannel} channel - Channel to inspect.
 * @returns {{ ok: boolean, missing: string[] }} Permission audit outcome.
 */
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

module.exports = {
  CHANNEL_KINDS,
  normalizeKind,
  getAnnouncementChannel,
  getConfiguredGuildIds,
  hasBotPerms,
};
