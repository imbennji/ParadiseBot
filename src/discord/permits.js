/**
 * Link permit utilities. Moderators can temporarily authorise members to share URLs which prevents
 * the automatic moderation system from deleting their messages. Persisting the permits in MySQL makes
 * the feature resilient to restarts.
 */
const { PermissionsBitField } = require('discord.js');
const { dbRun, dbGet } = require('../db');
const { log } = require('../logger');

const LINK_REGEX = /(https?:\/\/|www\.)[^\s<]+/i;
const PERMIT_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Determines whether a guild member should bypass link moderation. Administrators and members with
 * the Manage Messages permission are treated as staff.
 */
function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  return member.permissions?.has(PermissionsBitField.Flags.ManageMessages);
}

/**
 * Lightweight URL detector. We intentionally use a simple regex because Discord already sanitises
 * links and we only need to know that a URL-like token exists.
 */
function messageHasLink(message) {
  if (!message || !message.content) return false;
  return LINK_REGEX.test(message.content);
}

/**
 * Grants (or refreshes) a link permit for the specified user. The caller can override the duration
 * which simplifies unit testing and niche moderation flows.
 */
async function grantLinkPermit(guildId, userId, grantedBy, durationMs = PERMIT_DURATION_MS) {
  const expiresAt = Date.now() + durationMs;
  await dbRun(
    'INSERT INTO link_permits (guild_id, user_id, granted_by, expires_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE granted_by=VALUES(granted_by), expires_at=VALUES(expires_at)',
    [guildId, userId, grantedBy, expiresAt]
  );
  log.tag('PERMIT').info(`guild=${guildId} user=${userId} grantedBy=${grantedBy} expiresAt=${expiresAt}`);
  return expiresAt;
}

/**
 * Checks whether a user currently holds a non-expired permit. Expired records are cleaned up lazily
 * to keep the table small without requiring a background job.
 */
async function hasActivePermit(guildId, userId) {
  if (!guildId || !userId) return false;
  const row = await dbGet('SELECT expires_at FROM link_permits WHERE guild_id=? AND user_id=?', [guildId, userId]);
  if (!row) return false;
  if (Number(row.expires_at) > Date.now()) return true;
  await dbRun('DELETE FROM link_permits WHERE guild_id=? AND user_id=?', [guildId, userId]);
  return false;
}

/**
 * Revokes a permit ahead of its natural expiration.
 */
async function revokePermit(guildId, userId) {
  await dbRun('DELETE FROM link_permits WHERE guild_id=? AND user_id=?', [guildId, userId]);
}

module.exports = {
  grantLinkPermit,
  hasActivePermit,
  isStaff,
  messageHasLink,
  revokePermit,
  PERMIT_DURATION_MS,
};
