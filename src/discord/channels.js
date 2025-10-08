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
