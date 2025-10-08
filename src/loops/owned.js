const { EmbedBuilder } = require('discord.js');
const { log, time } = require('../logger');
const { dbAll, dbRun, dbGet } = require('../db');
const { client } = require('../discord/client');
const {
  OWNED_POLL_MS,
  OWNED_SEED_ON_FIRST,
  OWNED_REMOVAL_GRACE_MIN,
  OWNED_ANNOUNCE_LIMIT,
  STEAM_COLOR,
} = require('../config');
const { CHANNEL_KINDS, getAnnouncementChannel, getConfiguredGuildIds, hasBotPerms } = require('../discord/channels');
const { getOwnedGames, getRecentlyPlayed, getAppNameCached } = require('../steam/api');
const { upsertPlaytimeStats } = require('./leaderboard');
const { appIconUrl } = require('../utils/steam');

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

module.exports = {
  retroMarkSeededBursts,
  scheduleOwnedLoop,
  monitorOwnedAdds,
};
