const { EmbedBuilder } = require('discord.js');
const { log, time } = require('../logger');
const { dbAll, dbRun } = require('../db');
const { client } = require('../discord/client');
const {
  NOWPLAYING_POLL_MS,
  NOWPLAYING_CONFIRM_SECONDS,
  NOWPLAYING_IDLE_TIMEOUT_SECONDS,
  SESSION_MIN_MINUTES,
  NOWPLAYING_SEED_ON_FIRST_RUN,
  STEAM_COLOR,
} = require('../config');
const { CHANNEL_KINDS, getAnnouncementChannel, getConfiguredGuildIds, hasBotPerms } = require('../discord/channels');
const { getCurrentGame, getAppNameCached } = require('../steam/api');
const { fmtDuration } = require('../utils/text');

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

module.exports = {
  scheduleNowPlayingLoop,
  monitorNowPlaying,
};
