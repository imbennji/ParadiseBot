const {
  Colors,
  EmbedBuilder,
  Events,
  channelMention,
  userMention,
  time: formatDiscordTime,
} = require('discord.js');
const { client } = require('./client');
const { CHANNEL_KINDS, getAnnouncementChannel, hasBotPerms } = require('./channels');
const { log } = require('../logger');

const logger = log.tag('LOG');
let registered = false;

function trimFieldValue(value) {
  if (!value) return '*No content*';
  const str = String(value);
  if (str.length <= 1024) return str;
  return `${str.slice(0, 1021)}...`;
}

async function dispatchLog(guild, payloadBuilder) {
  try {
    const channel = await getAnnouncementChannel(guild, CHANNEL_KINDS.LOGGING);
    if (!channel) return false;

    const perms = hasBotPerms(channel);
    if (!perms.ok) {
      logger.warn(
        `Missing permissions for logging channel guild=${guild.id} channel=${channel.id}: ${perms.missing.join(', ')}`
      );
      return false;
    }

    const payload = payloadBuilder(channel);
    if (!payload) return false;
    await channel.send(payload);
    return true;
  } catch (err) {
    logger.error('Failed to send logging payload:', err?.stack || err);
    return false;
  }
}

function baseEmbed() {
  return new EmbedBuilder().setTimestamp(new Date());
}

function buildUserFooter(user, extra, fallbackId) {
  const idPart = user?.id
    ? `User ID: ${user.id}`
    : fallbackId
      ? `User ID: ${fallbackId}`
      : null;
  const extras = [idPart, extra].filter(Boolean);
  return extras.length ? { text: extras.join(' • ') } : null;
}

async function handleMemberAdd(member) {
  const user = member.user ?? null;
  await dispatchLog(member.guild, () => {
    const joinedAt = member.joinedAt ? new Date(member.joinedAt) : new Date();
    const embed = baseEmbed()
      .setColor(Colors.Green)
      .setAuthor({
        name: user?.tag || `Member Joined (${member.id})`,
        iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`${user ? userMention(user.id) : member.id} joined the server.`)
      .addFields({
        name: 'Joined Server',
        value: `${formatDiscordTime(joinedAt, 'F')} (${formatDiscordTime(joinedAt, 'R')})`,
        inline: true,
      });

    if (user?.createdAt) {
      embed.addFields({
        name: 'Account Created',
        value: `${formatDiscordTime(user.createdAt, 'F')} (${formatDiscordTime(user.createdAt, 'R')})`,
        inline: true,
      });
    }

    if (typeof member.guild.memberCount === 'number') {
      embed.addFields({
        name: 'Member Count',
        value: `${member.guild.memberCount}`,
        inline: true,
      });
    }

    const footer = buildUserFooter(user, null, member.id);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

async function handleMemberRemove(member) {
  const user = member.user ?? null;
  await dispatchLog(member.guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Red)
      .setAuthor({
        name: user?.tag || `Member Left (${member.id})`,
        iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`${user ? userMention(user.id) : member.id} left the server.`);

    if (user?.createdAt) {
      embed.addFields({
        name: 'Account Created',
        value: `${formatDiscordTime(user.createdAt, 'F')} (${formatDiscordTime(user.createdAt, 'R')})`,
        inline: true,
      });
    }

    if (typeof member.joinedAt === 'object' || typeof member.joinedAt === 'number') {
      const joinedAt = member.joinedAt ? new Date(member.joinedAt) : null;
      if (joinedAt) {
        embed.addFields({
          name: 'Joined Server',
          value: `${formatDiscordTime(joinedAt, 'F')} (${formatDiscordTime(joinedAt, 'R')})`,
          inline: true,
        });
      }
    }

    const footer = buildUserFooter(user, null, member.id);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

async function handleMessageDelete(message) {
  if (!message.guild) return;
  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      logger.debug('Unable to fetch partial message for delete log:', err?.message || err);
    }
  }

  const author = message.author ?? null;
  const authorId = author?.id || message.authorId || null;
  const content = message.content?.trim();
  const attachments = message.attachments && message.attachments.size
    ? Array.from(message.attachments.values())
    : [];

  if (!content && attachments.length === 0) {
    // If we have no details, still log the deletion with minimal info.
  }

  await dispatchLog(message.guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.DarkRed)
      .setAuthor({
        name: author?.tag || 'Message Deleted',
        iconURL: author?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`Message deleted in ${channelMention(message.channelId)}.`)
      .addFields({
        name: 'Author',
        value: author ? `${userMention(author.id)} (${author.tag})` : `Unknown (${authorId || 'unknown'})`,
        inline: true,
      });

    if (message.id) {
      embed.addFields({ name: 'Message ID', value: `${message.id}`, inline: true });
    }

    if (content) {
      embed.addFields({ name: 'Content', value: trimFieldValue(content) });
    }

    if (attachments.length) {
      const value = attachments
        .map(att => `[${att.name || 'attachment'}](${att.url})`)
        .join('\n');
      embed.addFields({ name: 'Attachments', value: trimFieldValue(value) });
    }

    const footer = buildUserFooter(author, message.id ? `Message ID: ${message.id}` : null, authorId);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

async function handleMessageUpdate(oldMessage, newMessage) {
  if (!newMessage.guild) return;
  if (newMessage.partial) {
    try {
      await newMessage.fetch();
    } catch (err) {
      logger.debug('Unable to fetch partial message for edit log:', err?.message || err);
      return;
    }
  }

  const author = newMessage.author ?? oldMessage.author ?? null;
  const authorId = author?.id
    || oldMessage.author?.id
    || oldMessage.authorId
    || newMessage.authorId
    || null;
  if (author?.bot) return;

  const beforeContent = oldMessage.content ?? '';
  const afterContent = newMessage.content ?? '';
  const beforeAttachments = oldMessage.attachments?.size ?? 0;
  const afterAttachments = newMessage.attachments?.size ?? 0;

  if (beforeContent === afterContent && beforeAttachments === afterAttachments) return;

  await dispatchLog(newMessage.guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Orange)
      .setAuthor({
        name: author?.tag || 'Message Edited',
        iconURL: author?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`Message edited in ${channelMention(newMessage.channelId)}. [Jump to message](${newMessage.url})`)
      .addFields({
        name: 'Author',
        value: author ? `${userMention(author.id)} (${author.tag})` : `Unknown (${authorId || 'unknown'})`,
        inline: true,
      });

    if (newMessage.id) {
      embed.addFields({ name: 'Message ID', value: `${newMessage.id}`, inline: true });
    }

    embed.addFields({
      name: 'Before',
      value: trimFieldValue(beforeContent || '*No previous content cached*'),
    });

    embed.addFields({
      name: 'After',
      value: trimFieldValue(afterContent || '*No current content*'),
    });

    if (afterAttachments) {
      const value = Array.from(newMessage.attachments.values())
        .map(att => `[${att.name || 'attachment'}](${att.url})`)
        .join('\n');
      embed.addFields({ name: 'Attachments', value: trimFieldValue(value) });
    }

    const footer = buildUserFooter(author, newMessage.id ? `Message ID: ${newMessage.id}` : null, authorId);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

function registerLogging() {
  if (registered) return;
  registered = true;

  client.on(Events.GuildMemberAdd, (member) => {
    handleMemberAdd(member).catch(err => logger.error('Failed to log member join:', err?.stack || err));
  });

  client.on(Events.GuildMemberRemove, (member) => {
    handleMemberRemove(member).catch(err => logger.error('Failed to log member leave:', err?.stack || err));
  });

  client.on(Events.MessageDelete, (message) => {
    handleMessageDelete(message).catch(err => logger.error('Failed to log message delete:', err?.stack || err));
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    handleMessageUpdate(oldMessage, newMessage).catch(err => logger.error('Failed to log message edit:', err?.stack || err));
  });

  logger.info('Logging listeners registered.');
}

module.exports = { registerLogging };
