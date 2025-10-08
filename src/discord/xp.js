const { log } = require('../logger');
const { dbGet, dbRun } = require('../db');

const XP_COOLDOWN_SECONDS = 60;
const XP_MIN_PER_MESSAGE = 15;
const XP_MAX_PER_MESSAGE = 25;
const MIN_MESSAGE_LENGTH = 5;

function randomXpGain() {
  return XP_MIN_PER_MESSAGE + Math.floor(Math.random() * (XP_MAX_PER_MESSAGE - XP_MIN_PER_MESSAGE + 1));
}

function xpToLevelUp(level) {
  return 5 * level * level + 50 * level + 100;
}

function totalXpForLevel(level) {
  let total = 0;
  for (let i = 0; i < level; i += 1) {
    total += xpToLevelUp(i);
  }
  return total;
}

async function getXpRow(guildId, userId) {
  return dbGet('SELECT xp, level, last_message_at FROM xp_progress WHERE guild_id=? AND user_id=?', [guildId, userId]);
}

function hasEarnableContent(message) {
  if (message.content && message.content.trim().length >= MIN_MESSAGE_LENGTH) return true;
  if (message.attachments?.size) return true;
  if (message.stickers?.size) return true;
  return false;
}

async function awardMessageXp(message) {
  if (!message?.guildId) return;
  if (message.author?.bot) return;
  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      log.tag('XP').warn('Failed to fetch partial message for XP', err);
      return;
    }
  }

  if (!hasEarnableContent(message)) return;

  const now = Math.floor(Date.now() / 1000);
  const row = await getXpRow(message.guildId, message.author.id);

  if (row && now - row.last_message_at < XP_COOLDOWN_SECONDS) {
    return;
  }

  const gained = randomXpGain();
  const previousXp = row?.xp ?? 0;
  const newTotalXp = previousXp + gained;
  let level = row?.level ?? 0;
  let leveledUp = false;

  while (newTotalXp >= totalXpForLevel(level + 1)) {
    level += 1;
    leveledUp = true;
  }

  await dbRun(
    `INSERT INTO xp_progress (guild_id, user_id, xp, level, last_message_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE xp=VALUES(xp), level=VALUES(level), last_message_at=VALUES(last_message_at)` ,
    [message.guildId, message.author.id, newTotalXp, level, now]
  );

  log.tag('XP').debug(
    `Awarded ${gained}xp to user=${message.author.id} guild=${message.guildId} total=${newTotalXp} level=${level}`
  );

  if (leveledUp) {
    try {
      await message.channel.send({ content: `🎉 Congrats ${message.author}, you reached level **${level}**!` });
    } catch (err) {
      log.tag('XP').warn('Failed to announce level up', err);
    }
  }
}

async function getRankStats(guildId, userId) {
  const row = await dbGet('SELECT xp, level FROM xp_progress WHERE guild_id=? AND user_id=?', [guildId, userId]);
  if (!row) return null;

  const level = row.level || 0;
  const totalXp = row.xp || 0;
  const currentLevelFloor = totalXpForLevel(level);
  const nextLevelTotal = totalXpForLevel(level + 1);
  const xpIntoLevel = totalXp - currentLevelFloor;
  const xpForNextLevel = nextLevelTotal - currentLevelFloor;
  const xpToNextLevel = nextLevelTotal - totalXp;

  return {
    level,
    totalXp,
    xpIntoLevel,
    xpForNextLevel,
    xpToNextLevel,
  };
}

module.exports = {
  awardMessageXp,
  getRankStats,
  totalXpForLevel,
  xpToLevelUp,
};
