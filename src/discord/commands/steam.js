/**
 * Steam-focused slash commands: linking profiles, health checks, and library inspection.
 * Shared Steam helpers live here so command handlers can defer to the API wrapper utilities.
 */
const { SlashCommandBuilder } = require('discord.js');
const axios = require('axios').default;
const { log, time } = require('../../logger');
const { dbRun, dbGet } = require('../../db');
const {
  STEAM_API_KEY,
  STEAM_HOST,
} = require('../../config');
const {
  resolveSteamId,
  getRecentlyPlayed,
  getOwnedGames,
  getAppInstallSize,
} = require('../../steam/api');

const steamBuilders = [
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
    .setName('librarysize')
    .setDescription("Estimate a Steam user's total install size across their library")
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('profile')
        .setDescription('Steam vanity/profile URL/steamid64 to inspect')
        .setRequired(true)
    ),
];

/** Formats a byte count into a human-friendly string. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / (1024 ** idx);
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[idx]}`;
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
    return interaction.editReply('❌ That Steam account is already linked by another Discord user.');
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
  return interaction.editReply('✅ Health OK. DB ✅, Steam API ✅');
}

async function handleLibrarySize(interaction) {
  const profile = interaction.options.getString('profile', true).trim();
  await interaction.deferReply({ ephemeral: true });

  const steamId = await resolveSteamId(profile);
  if (!steamId) {
    return interaction.editReply('❌ Could not resolve that Steam profile. Please double-check the vanity name or SteamID64.');
  }

  let games;
  try {
    games = await getOwnedGames(steamId);
  } catch (err) {
    log.tag('CMD:librarysize').warn(`owned fetch failed steam=${steamId}:`, err?.stack || err);
    return interaction.editReply('I could not fetch that library. The profile may be private or Steam is unreachable.');
  }

  if (!games.length) {
    return interaction.editReply('That library appears to be empty or private.');
  }

  let cursor = 0;
  let totalBytes = 0;
  let counted = 0;
  let missing = 0;
  const concurrency = 8;

  async function worker() {
    while (cursor < games.length) {
      const idx = cursor++;
      const game = games[idx];
      const size = await getAppInstallSize(game.appid);
      if (Number.isFinite(size) && size > 0) {
        totalBytes += size;
        counted += 1;
      } else {
        missing += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (!counted) {
    return interaction.editReply('I could not retrieve size data for any games in that library. The profile may be private or the games do not expose install sizes.');
  }

  const totalGames = games.length;
  const summary = `Estimated install size for **${steamId}**: **${formatBytes(totalBytes)}** across ${counted}/${totalGames} games.`;
  const caveat = missing ? ' Some titles did not expose size data, so the real total is likely higher.' : '';

  log.tag('CMD:librarysize').info(`steam=${steamId} games=${totalGames} counted=${counted} missing=${missing} totalBytes=${totalBytes}`);
  return interaction.editReply(summary + caveat);
}

const steamHandlers = {
  linksteam: handleLinkSteam,
  unlinksteam: handleUnlinkSteam,
  pingsteam: handlePingSteam,
  librarysize: handleLibrarySize,
};

module.exports = {
  builders: steamBuilders,
  handlers: steamHandlers,
};
