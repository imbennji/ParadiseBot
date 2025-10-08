const pLimitImport = require('p-limit');
const { EmbedBuilder } = require('discord.js');
const { log, time } = require('../logger');
const { client } = require('../discord/client');
const { dbAll, dbRun, dbGet } = require('../db');
const {
  POLL_MS,
  CONCURRENCY,
  RECENT_LIMIT,
  SEED_ON_FIRST_RUN,
  SEED_IF_ZERO,
  BACKFILL_LIMIT,
  DEFAULT_ACH_MARKS,
  RARE_PCT,
  STEAM_COLOR,
} = require('../config');
const { CHANNEL_KINDS, getAnnouncementChannel, getConfiguredGuildIds, hasBotPerms } = require('../discord/channels');
const {
  getRecentlyPlayed,
  getPlayerAchievements,
  getSchema,
  getAppNameCached,
  getGlobalRarity,
} = require('../steam/api');
const { upsertAchievementStats } = require('./leaderboard');
const { makeProgressBar } = require('../utils/text');

const pLimit = typeof pLimitImport === 'function' ? pLimitImport : pLimitImport.default;
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

module.exports = {
  scheduleAchievementsLoop,
  monitorAchievements,
};
