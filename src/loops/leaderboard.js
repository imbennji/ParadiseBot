/**
 * Maintains a persistent leaderboard message per guild that highlights top playtime, achievements,
 * and new game additions. Stats are aggregated from the shared `user_game_stats` table which is fed
 * by other loops (achievements, owned games, etc.).
 */
const { EmbedBuilder } = require('discord.js');
const { dbRun, dbGet, dbAll } = require('../db');
const { log, time } = require('../logger');
const { client } = require('../discord/client');
const { STEAM_COLOR, LEADERBOARD_POLL_MS } = require('../config');
const { CHANNEL_KINDS, getAnnouncementChannel, getConfiguredGuildIds } = require('../discord/channels');
const { hours } = require('../utils/text');

/**
 * Persists playtime statistics for a given user/app combination. Values are clamped to zero to avoid
 * negative data from upstream APIs.
 */
async function upsertPlaytimeStats(gid, uid, appid, totalMin, twoWMin) {
  const now = Math.floor(Date.now()/1000);
  await dbRun(
    `INSERT INTO user_game_stats (guild_id, user_id, appid, playtime_total_min, playtime_2w_min, ach_unlocked, ach_total, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)
     ON DUPLICATE KEY UPDATE playtime_total_min=VALUES(playtime_total_min), playtime_2w_min=VALUES(playtime_2w_min), updated_at=VALUES(updated_at)`,
    [gid, uid, appid, Math.max(0, totalMin|0), Math.max(0, twoWMin|0), now]
  );
}

/**
 * Persists achievement totals for a given user/app pair.
 */
async function upsertAchievementStats(gid, uid, appid, unlocked, total) {
  const now = Math.floor(Date.now()/1000);
  await dbRun(
    `INSERT INTO user_game_stats (guild_id, user_id, appid, playtime_total_min, playtime_2w_min, ach_unlocked, ach_total, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ach_unlocked=VALUES(ach_unlocked), ach_total=VALUES(ach_total), updated_at=VALUES(updated_at)`,
    [gid, uid, appid, Math.max(0, unlocked|0), Math.max(0, total|0), now]
  );
}

/**
 * Makes sure the guild has a canonical leaderboard message. When the target channel changes the old
 * message is deleted and a fresh placeholder is created in the new location.
 */
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
      if (oldCh) {
        const oldMsg = await oldCh.messages.fetch(row.message_id).catch(()=>null);
        if (oldMsg) await oldMsg.delete().catch(()=>{});
      }
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

/**
 * Rebuilds the leaderboard embeds for every configured guild by aggregating stats from the database.
 */
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

/**
 * Schedules the recurring leaderboard refresh loop. Set `runNow` to true to avoid waiting for the
 * first interval after startup.
 */
function scheduleLeaderboardLoop(runNow = false) {
  const run = async () => {
    try { await refreshLeaderboards(); }
    catch (err) { log.tag('LB').error('refreshLeaderboards error:', err?.stack || err); }
    finally { setTimeout(run, LEADERBOARD_POLL_MS); }
  };
  log.tag('LB').info(`Leaderboard refresh every ${Math.round(LEADERBOARD_POLL_MS / 1000)}s`);
  if (runNow) run();
}

module.exports = {
  upsertPlaytimeStats,
  upsertAchievementStats,
  ensureLeaderboardMessage,
  refreshLeaderboards,
  scheduleLeaderboardLoop,
};
