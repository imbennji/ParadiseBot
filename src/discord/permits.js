const { PermissionsBitField } = require('discord.js');
const { dbRun, dbGet } = require('../db');
const { log } = require('../logger');

const LINK_REGEX = /(https?:\/\/|www\.)[^\s<]+/i;
const PERMIT_DURATION_MS = 60 * 60 * 1000; // 1 hour

function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  return member.permissions?.has(PermissionsBitField.Flags.ManageMessages);
}

function messageHasLink(message) {
  if (!message || !message.content) return false;
  return LINK_REGEX.test(message.content);
}

async function grantLinkPermit(guildId, userId, grantedBy, durationMs = PERMIT_DURATION_MS) {
  const expiresAt = Date.now() + durationMs;
  await dbRun(
    'INSERT INTO link_permits (guild_id, user_id, granted_by, expires_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE granted_by=VALUES(granted_by), expires_at=VALUES(expires_at)',
    [guildId, userId, grantedBy, expiresAt]
  );
  log.tag('PERMIT').info(`guild=${guildId} user=${userId} grantedBy=${grantedBy} expiresAt=${expiresAt}`);
  return expiresAt;
}

async function hasActivePermit(guildId, userId) {
  if (!guildId || !userId) return false;
  const row = await dbGet('SELECT expires_at FROM link_permits WHERE guild_id=? AND user_id=?', [guildId, userId]);
  if (!row) return false;
  if (Number(row.expires_at) > Date.now()) return true;
  await dbRun('DELETE FROM link_permits WHERE guild_id=? AND user_id=?', [guildId, userId]);
  return false;
}

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
