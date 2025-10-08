const {
  Colors,
  EmbedBuilder,
  Events,
  channelMention,
  roleMention,
  userMention,
  time: formatDiscordTime,
  ChannelType,
  PermissionsBitField,
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

function boolLabel(value) {
  return value ? 'Enabled' : 'Disabled';
}

function formatChannelReference(channel, channelId) {
  if (channel?.toString) return channel.toString();
  if (channelId) return channelMention(channelId);
  return '*Unknown channel*';
}

function formatChannelType(type) {
  switch (type) {
    case ChannelType.GuildText:
      return 'Text';
    case ChannelType.GuildVoice:
      return 'Voice';
    case ChannelType.GuildCategory:
      return 'Category';
    case ChannelType.GuildAnnouncement:
      return 'Announcement';
    case ChannelType.AnnouncementThread:
      return 'Announcement Thread';
    case ChannelType.GuildStageVoice:
      return 'Stage';
    case ChannelType.GuildForum:
      return 'Forum';
    case ChannelType.PublicThread:
      return 'Public Thread';
    case ChannelType.PrivateThread:
      return 'Private Thread';
    case ChannelType.GuildDirectory:
      return 'Directory';
    case ChannelType.GuildMedia:
      return 'Media';
    default:
      return 'Unknown';
  }
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
  if (user?.bot) return;
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
  if (user?.bot) return;
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
  const embedCount = Array.isArray(message.embeds) ? message.embeds.length : 0;

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

    const contentFieldValue = content
      ? trimFieldValue(content)
      : embedCount
        ? `*No cached text content. ${embedCount} embed${embedCount === 1 ? '' : 's'} were present.*`
        : '*No cached text content.*';
    embed.addFields({ name: 'Content', value: contentFieldValue });

    if (attachments.length) {
      const value = attachments
        .map(att => `[${att.name || 'attachment'}](${att.url})`)
        .join('\n');
      embed.addFields({ name: 'Attachments', value: trimFieldValue(value) });
    } else {
      embed.addFields({ name: 'Attachments', value: '*None*' });
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

async function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const member = newState.member ?? oldState.member ?? null;
  const user = member?.user ?? null;
  if (user?.bot) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;
  const channelChanged = oldChannelId !== newChannelId;
  const joined = !oldChannelId && newChannelId;
  const left = oldChannelId && !newChannelId;
  const moved = oldChannelId && newChannelId && channelChanged;

  const toggleDefs = [
    ['serverMute', 'Server Mute'],
    ['serverDeaf', 'Server Deaf'],
    ['selfMute', 'Self Mute'],
    ['selfDeaf', 'Self Deaf'],
    ['selfVideo', 'Camera'],
    ['streaming', 'Streaming'],
    ['suppress', 'Suppressed'],
  ];

  const stateChanges = toggleDefs
    .map(([key, label]) => ({
      key,
      label,
      before: oldState[key],
      after: newState[key],
    }))
    .filter(item => item.before !== item.after)
    .map(item => `**${item.label}:** ${boolLabel(item.before)} → ${boolLabel(item.after)}`);

  if (oldState.requestToSpeakTimestamp !== newState.requestToSpeakTimestamp) {
    const before = oldState.requestToSpeakTimestamp
      ? formatDiscordTime(new Date(oldState.requestToSpeakTimestamp), 'R')
      : 'None';
    const after = newState.requestToSpeakTimestamp
      ? formatDiscordTime(new Date(newState.requestToSpeakTimestamp), 'R')
      : 'None';
    stateChanges.push(`**Request to Speak:** ${before} → ${after}`);
  }

  if (!joined && !left && !moved && stateChanges.length === 0) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Blue)
      .setAuthor({
        name: user?.tag || 'Voice State Updated',
        iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      });

    if (joined) {
      embed.setDescription(
        `${userMention(user.id)} joined voice channel ${formatChannelReference(newState.channel, newChannelId)}.`
      );
    } else if (left) {
      embed.setDescription(
        `${userMention(user.id)} left voice channel ${formatChannelReference(oldState.channel, oldChannelId)}.`
      );
    } else if (moved) {
      embed.setDescription(
        `${userMention(user.id)} moved from ${formatChannelReference(oldState.channel, oldChannelId)} to ${formatChannelReference(newState.channel, newChannelId)}.`
      );
    } else {
      const channelRef = formatChannelReference(newState.channel ?? oldState.channel, newChannelId ?? oldChannelId);
      embed.setDescription(`${userMention(user.id)} updated voice state in ${channelRef}.`);
    }

    if (stateChanges.length) {
      embed.addFields({
        name: 'State Changes',
        value: trimFieldValue(stateChanges.join('\n')),
      });
    }

    if (newChannelId || oldChannelId) {
      const ref = newChannelId ? newChannelId : oldChannelId;
      embed.addFields({ name: 'Channel ID', value: `${ref}` });
    }

    const footer = buildUserFooter(user, null, member?.id || newState.id || oldState.id);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

async function handleGuildMemberUpdate(oldMember, newMember) {
  if (!newMember.guild) return;

  const user = newMember.user ?? oldMember.user ?? null;
  if (user?.bot) return;

  const changes = [];

  if (oldMember.displayName !== newMember.displayName) {
    changes.push({
      name: 'Display Name',
      value: `${trimFieldValue(oldMember.displayName || '*None*')} → ${trimFieldValue(newMember.displayName || '*None*')}`,
    });
  }

  const oldRoleCache = oldMember.roles?.cache;
  const newRoleCache = newMember.roles?.cache;
  const oldRoles = new Set(oldRoleCache ? oldRoleCache.keys() : []);
  const newRoles = new Set(newRoleCache ? newRoleCache.keys() : []);

  const addedRoles = Array.from(newRoles).filter(roleId => !oldRoles.has(roleId));
  const removedRoles = Array.from(oldRoles).filter(roleId => !newRoles.has(roleId));

  if (addedRoles.length) {
    const value = addedRoles
      .map(roleId => {
        const role = newMember.guild.roles.cache.get(roleId);
        return role ? roleMention(role.id) : roleId;
      })
      .join(', ');
    changes.push({ name: 'Roles Added', value: trimFieldValue(value) });
  }

  if (removedRoles.length) {
    const value = removedRoles
      .map(roleId => {
        const role = newMember.guild.roles.cache.get(roleId);
        return role ? roleMention(role.id) : roleId;
      })
      .join(', ');
    changes.push({ name: 'Roles Removed', value: trimFieldValue(value) });
  }

  const oldTimeout = oldMember.communicationDisabledUntilTimestamp || null;
  const newTimeout = newMember.communicationDisabledUntilTimestamp || null;
  if (oldTimeout !== newTimeout) {
    const before = oldTimeout
      ? `${formatDiscordTime(new Date(oldTimeout), 'F')} (${formatDiscordTime(new Date(oldTimeout), 'R')})`
      : 'None';
    const after = newTimeout
      ? `${formatDiscordTime(new Date(newTimeout), 'F')} (${formatDiscordTime(new Date(newTimeout), 'R')})`
      : 'None';
    changes.push({ name: 'Timeout', value: `${before} → ${after}` });
  }

  if (!changes.length) return;

  await dispatchLog(newMember.guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Blurple)
      .setAuthor({
        name: user?.tag || 'Member Updated',
        iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`${userMention(user.id)} had member settings updated.`);

    for (const change of changes) {
      embed.addFields(change);
    }

    const footer = buildUserFooter(user, null, newMember.id);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

async function handleChannelCreate(channel) {
  const guild = channel.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Green)
      .setAuthor({ name: 'Channel Created' })
      .setDescription(`Created ${formatChannelReference(channel, channel.id)} (${formatChannelType(channel.type)})`)
      .addFields({ name: 'Channel ID', value: `${channel.id}` });

    if (channel.parent) {
      embed.addFields({ name: 'Parent', value: `${formatChannelReference(channel.parent, channel.parentId)}`, inline: true });
    }

    if (typeof channel.nsfw === 'boolean') {
      embed.addFields({ name: 'NSFW', value: boolLabel(channel.nsfw), inline: true });
    }

    if (typeof channel.rateLimitPerUser === 'number' && channel.rateLimitPerUser > 0) {
      embed.addFields({ name: 'Slowmode', value: `${channel.rateLimitPerUser}s`, inline: true });
    }

    if (typeof channel.bitrate === 'number') {
      embed.addFields({ name: 'Bitrate', value: `${channel.bitrate}bps`, inline: true });
    }

    if (typeof channel.userLimit === 'number' && channel.userLimit > 0) {
      embed.addFields({ name: 'User Limit', value: `${channel.userLimit}`, inline: true });
    }

    if (channel.topic) {
      embed.addFields({ name: 'Topic', value: trimFieldValue(channel.topic) });
    }

    embed.setFooter({ text: `Channel ID: ${channel.id}` });

    return { embeds: [embed] };
  });
}

async function handleChannelDelete(channel) {
  const guild = channel.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Red)
      .setAuthor({ name: 'Channel Deleted' })
      .setDescription(`Deleted ${channel.name ? `#${channel.name}` : channel.id} (${formatChannelType(channel.type)})`)
      .addFields({ name: 'Channel ID', value: `${channel.id}` });

    if (channel.parentId) {
      embed.addFields({ name: 'Parent ID', value: `${channel.parentId}`, inline: true });
    }

    return { embeds: [embed] };
  });
}

async function handleChannelUpdate(oldChannel, newChannel) {
  const guild = newChannel.guild ?? oldChannel.guild;
  if (!guild) return;

  const diffs = [];

  if (oldChannel.name !== newChannel.name) {
    diffs.push(`**Name:** ${oldChannel.name || 'None'} → ${newChannel.name || 'None'}`);
  }

  if (oldChannel.parentId !== newChannel.parentId) {
    const before = oldChannel.parent ? formatChannelReference(oldChannel.parent, oldChannel.parentId) : 'None';
    const after = newChannel.parent ? formatChannelReference(newChannel.parent, newChannel.parentId) : 'None';
    diffs.push(`**Parent:** ${before} → ${after}`);
  }

  if (oldChannel.type !== newChannel.type) {
    diffs.push(`**Type:** ${formatChannelType(oldChannel.type)} → ${formatChannelType(newChannel.type)}`);
  }

  if ('topic' in oldChannel && oldChannel.topic !== newChannel.topic) {
    const before = oldChannel.topic || '*None*';
    const after = newChannel.topic || '*None*';
    diffs.push(`**Topic:** ${trimFieldValue(before)} → ${trimFieldValue(after)}`);
  }

  if ('nsfw' in oldChannel && oldChannel.nsfw !== newChannel.nsfw) {
    diffs.push(`**NSFW:** ${boolLabel(oldChannel.nsfw)} → ${boolLabel(newChannel.nsfw)}`);
  }

  if ('rateLimitPerUser' in oldChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
    const before = oldChannel.rateLimitPerUser ? `${oldChannel.rateLimitPerUser}s` : 'Off';
    const after = newChannel.rateLimitPerUser ? `${newChannel.rateLimitPerUser}s` : 'Off';
    diffs.push(`**Slowmode:** ${before} → ${after}`);
  }

  if ('bitrate' in oldChannel && oldChannel.bitrate !== newChannel.bitrate) {
    diffs.push(`**Bitrate:** ${oldChannel.bitrate || 0} → ${newChannel.bitrate || 0}`);
  }

  if ('userLimit' in oldChannel && oldChannel.userLimit !== newChannel.userLimit) {
    const before = oldChannel.userLimit && oldChannel.userLimit > 0 ? oldChannel.userLimit : 'Unlimited';
    const after = newChannel.userLimit && newChannel.userLimit > 0 ? newChannel.userLimit : 'Unlimited';
    diffs.push(`**User Limit:** ${before} → ${after}`);
  }

  if (oldChannel.permissionOverwrites?.cache?.size !== newChannel.permissionOverwrites?.cache?.size) {
    const before = oldChannel.permissionOverwrites?.cache?.size ?? 0;
    const after = newChannel.permissionOverwrites?.cache?.size ?? 0;
    diffs.push(`**Permission Overwrites:** ${before} → ${after}`);
  }

  if (!diffs.length) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Blurple)
      .setAuthor({ name: 'Channel Updated' })
      .setDescription(
        `Updated ${formatChannelReference(newChannel, newChannel.id ?? oldChannel.id)} (${formatChannelType(newChannel.type)})`
      )
      .addFields({ name: 'Changes', value: trimFieldValue(diffs.join('\n')) })
      .setFooter({ text: `Channel ID: ${newChannel.id || oldChannel.id}` });

    return { embeds: [embed] };
  });
}

async function handleRoleCreate(role) {
  const guild = role.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Green)
      .setAuthor({ name: 'Role Created' })
      .setDescription(`Created ${roleMention(role.id)} (${role.name})`)
      .addFields({ name: 'Role ID', value: `${role.id}` })
      .addFields({ name: 'Color', value: role.hexColor || 'Default', inline: true })
      .addFields({ name: 'Mentionable', value: boolLabel(role.mentionable), inline: true })
      .addFields({ name: 'Hoisted', value: boolLabel(role.hoist), inline: true });

    return { embeds: [embed] };
  });
}

async function handleRoleDelete(role) {
  const guild = role.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Red)
      .setAuthor({ name: 'Role Deleted' })
      .setDescription(`Deleted ${role.name} (${role.id})`)
      .addFields({ name: 'Role ID', value: `${role.id}` });

    return { embeds: [embed] };
  });
}

async function handleRoleUpdate(oldRole, newRole) {
  const guild = newRole.guild ?? oldRole.guild;
  if (!guild) return;

  const diffs = [];

  if (oldRole.name !== newRole.name) {
    diffs.push(`**Name:** ${oldRole.name} → ${newRole.name}`);
  }

  if (oldRole.hexColor !== newRole.hexColor) {
    diffs.push(`**Color:** ${oldRole.hexColor || 'Default'} → ${newRole.hexColor || 'Default'}`);
  }

  if (oldRole.hoist !== newRole.hoist) {
    diffs.push(`**Hoisted:** ${boolLabel(oldRole.hoist)} → ${boolLabel(newRole.hoist)}`);
  }

  if (oldRole.mentionable !== newRole.mentionable) {
    diffs.push(`**Mentionable:** ${boolLabel(oldRole.mentionable)} → ${boolLabel(newRole.mentionable)}`);
  }

  const oldPerms = new PermissionsBitField(oldRole.permissions.bitfield ?? oldRole.permissions);
  const newPerms = new PermissionsBitField(newRole.permissions.bitfield ?? newRole.permissions);
  const oldList = oldPerms.toArray();
  const newList = newPerms.toArray();
  const added = newList.filter(perm => !oldList.includes(perm));
  const removed = oldList.filter(perm => !newList.includes(perm));

  if (added.length) {
    diffs.push(`**Permissions Added:** ${added.map(perm => `\`${perm}\``).join(', ')}`);
  }

  if (removed.length) {
    diffs.push(`**Permissions Removed:** ${removed.map(perm => `\`${perm}\``).join(', ')}`);
  }

  if (!diffs.length) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Blurple)
      .setAuthor({ name: 'Role Updated' })
      .setDescription(`Updated ${roleMention(newRole.id)} (${newRole.name})`)
      .addFields({ name: 'Changes', value: trimFieldValue(diffs.join('\n')) })
      .setFooter({ text: `Role ID: ${newRole.id}` });

    return { embeds: [embed] };
  });
}

async function handleGuildBanAdd(ban) {
  const { guild, user, reason } = ban;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.DarkRed)
      .setAuthor({
        name: user?.tag || 'User Banned',
        iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`${user ? userMention(user.id) : ban.userId} was banned from the server.`);

    if (reason) {
      embed.addFields({ name: 'Reason', value: trimFieldValue(reason) });
    }

    const footer = buildUserFooter(user, null, ban.userId || user?.id);
    if (footer) embed.setFooter(footer);

    return { embeds: [embed] };
  });
}

async function handleGuildBanRemove(ban) {
  const { guild, user, reason } = ban;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = baseEmbed()
      .setColor(Colors.Green)
      .setAuthor({
        name: user?.tag || 'User Unbanned',
        iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      })
      .setDescription(`${user ? userMention(user.id) : ban.userId} was unbanned from the server.`);

    if (reason) {
      embed.addFields({ name: 'Previous Reason', value: trimFieldValue(reason) });
    }

    const footer = buildUserFooter(user, null, ban.userId || user?.id);
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

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState).catch(err => logger.error('Failed to log voice state update:', err?.stack || err));
  });

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    handleGuildMemberUpdate(oldMember, newMember).catch(err => logger.error('Failed to log member update:', err?.stack || err));
  });

  client.on(Events.ChannelCreate, (channel) => {
    handleChannelCreate(channel).catch(err => logger.error('Failed to log channel create:', err?.stack || err));
  });

  client.on(Events.ChannelDelete, (channel) => {
    handleChannelDelete(channel).catch(err => logger.error('Failed to log channel delete:', err?.stack || err));
  });

  client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
    handleChannelUpdate(oldChannel, newChannel).catch(err => logger.error('Failed to log channel update:', err?.stack || err));
  });

  client.on(Events.GuildRoleCreate, (role) => {
    handleRoleCreate(role).catch(err => logger.error('Failed to log role create:', err?.stack || err));
  });

  client.on(Events.GuildRoleDelete, (role) => {
    handleRoleDelete(role).catch(err => logger.error('Failed to log role delete:', err?.stack || err));
  });

  client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
    handleRoleUpdate(oldRole, newRole).catch(err => logger.error('Failed to log role update:', err?.stack || err));
  });

  client.on(Events.GuildBanAdd, (ban) => {
    handleGuildBanAdd(ban).catch(err => logger.error('Failed to log guild ban add:', err?.stack || err));
  });

  client.on(Events.GuildBanRemove, (ban) => {
    handleGuildBanRemove(ban).catch(err => logger.error('Failed to log guild ban remove:', err?.stack || err));
  });

  logger.info('Logging listeners registered.');
}

module.exports = { registerLogging };
