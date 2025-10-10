/**
 * XP system for rewarding active chat participation. XP accrues based on message activity with a
 * cooldown to discourage spam. When a user levels up we post a celebratory message in the configured
 * channel (or the current channel as a fallback).
 */
const { log } = require('../logger');
const { dbGet, dbRun } = require('../db');
const { CHANNEL_KINDS, getAnnouncementChannel, hasBotPerms } = require('./channels');

const XP_COOLDOWN_SECONDS = 60;
const XP_MIN_PER_MESSAGE = 15;
const XP_MAX_PER_MESSAGE = 25;
const MIN_MESSAGE_LENGTH = 5;

/**
 * Picks a random XP value between the configured min/max bounds. This small variance keeps the
 * system feeling organic without introducing large swings.
 */
function randomXpGain() {
  return XP_MIN_PER_MESSAGE + Math.floor(Math.random() * (XP_MAX_PER_MESSAGE - XP_MIN_PER_MESSAGE + 1));
}

/**
 * Calculates the XP required to progress from the given level to the next. The formula mirrors the
 * classic quadratic curve used by many games.
 */
function xpToLevelUp(level) {
  return 5 * level * level + 50 * level + 100;
}

/**
 * Computes the cumulative XP required to reach a specific level.
 */
function totalXpForLevel(level) {
  let total = 0;
  for (let i = 0; i < level; i += 1) {
    total += xpToLevelUp(i);
  }
  return total;
}

/**
 * Retrieves the XP progress row for a guild/user pair.
 */
async function getXpRow(guildId, userId) {
  return dbGet('SELECT xp, level, last_message_at FROM xp_progress WHERE guild_id=? AND user_id=?', [guildId, userId]);
}

/**
 * Filters out trivial or empty messages. Attachments and stickers still count to reward rich media.
 */
function hasEarnableContent(message) {
  if (message.content && message.content.trim().length >= MIN_MESSAGE_LENGTH) return true;
  if (message.attachments?.size) return true;
  if (message.stickers?.size) return true;
  return false;
}

/**
 * Primary XP accrual routine invoked for every message. It enforces cooldowns, persists the new XP
 * total, and posts a level-up announcement when appropriate.
 */
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
    let announceChannel = message.channel;

    if (message.guild) {
      try {
        const configured = await getAnnouncementChannel(message.guild, CHANNEL_KINDS.XP);
        if (configured) {
          const perms = hasBotPerms(configured);
          if (perms.ok) {
            announceChannel = configured;
          } else {
            log.tag('XP').warn(
              `Missing permissions in configured XP channel ${configured.id} for guild=${message.guildId}: ${perms.missing.join(', ')}`
            );
          }
        }
      } catch (err) {
        log.tag('XP').warn('Failed to resolve XP announcement channel', err);
      }
    }

    try {
      await announceChannel.send({ content: `🎉 Congrats ${message.author}, you reached level **${level}**!` });
    } catch (err) {
      log.tag('XP').warn('Failed to announce level up', err);
    }
  }
}

/**
 * Aggregates XP metrics for presentation in the `/rank` command. Returns `null` when the user has no
 * progress yet so the caller can show a friendly hint.
 */
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
