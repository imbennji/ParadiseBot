/**
 * Rich logging subsystem responsible for mirroring notable Discord events (member joins, message
 * deletions, moderation actions, etc.) into a dedicated channel. The goal is to provide moderators
 * with a searchable audit trail without needing to sift through raw audit logs.
 */
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

/**
 * Ensures embed field values stay within Discord's 1024 character limit while retaining enough
 * context to be useful.
 *
 * @param {unknown} value - Any value that will be rendered inside an embed field.
 * @returns {string} Sanitised field content.
 */
function trimFieldValue(value) {
  if (!value) return '*No content*';
  const str = String(value);
  if (str.length <= 1024) return str;
  return `${str.slice(0, 1021)}...`;
}

/**
 * Helper used throughout the module to convert booleans into a human friendly "Enabled/Disabled"
 * label. Reusing a single helper keeps the terminology consistent across embeds.
 */
function boolLabel(value) {
  return value ? 'Enabled' : 'Disabled';
}

/**
 * Resolves a channel mention string. When a cached channel instance is not available we fall back to
 * a mention using the raw ID so the logs still communicate which channel was affected.
 */
function formatChannelReference(channel, channelId) {
  if (channel?.toString) return channel.toString();
  if (channelId) return channelMention(channelId);
  return '*Unknown channel*';
}

/**
 * Maps Discord's numeric channel types to descriptive labels. Logging raw integers is unhelpful for
 * moderators reading the embed after the fact.
 */
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

/**
 * Sends a message to the configured logging channel, gracefully handling missing configuration or
 * insufficient permissions. The `payloadBuilder` allows each handler to construct embeds lazily so
 * expensive formatting is skipped when logging is disabled.
 *
 * @param {import('discord.js').Guild} guild - Guild to dispatch to.
 * @param {(channel: import('discord.js').GuildTextBasedChannel) => import('discord.js').MessageCreateOptions|false} payloadBuilder
 *   - Function returning the payload to send.
 * @returns {Promise<boolean>} Whether a message was sent.
 */
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

const LOG_BRAND = 'Paradise Logging';

/**
 * Returns a timestamped embed pre-configured with the logging brand. Centralising this logic keeps
 * all log messages visually consistent.
 */
function baseEmbed() {
  return new EmbedBuilder().setTimestamp(new Date());
}

/**
 * Constructs an embed footer that always includes the logging brand but may append contextual
 * details such as message IDs or user IDs.
 */
function buildFooter(...parts) {
  const footerParts = [LOG_BRAND, ...parts.filter(Boolean)];
  return { text: footerParts.join(' • ') };
}

/**
 * Convenience factory used by every log handler to standardise accent colours, emojis, and author
 * headers. The optional thumbnail ensures avatars appear consistently sized across embeds.
 */
function createLogEmbed({ accentColor, emoji, label, iconURL, thumbnailURL } = {}) {
  const embed = baseEmbed();
  if (accentColor) {
    embed.setColor(accentColor);
  }
  const authorName = [emoji, label].filter(Boolean).join(' ');
  if (authorName || iconURL) {
    embed.setAuthor({
      name: authorName || undefined,
      iconURL: iconURL || undefined,
    });
  }
  if (thumbnailURL) {
    embed.setThumbnail(thumbnailURL);
  }
  return embed;
}

/**
 * Formats a user mention with an additional line showing the tag or fallback ID. Including both
 * pieces of data makes the logs readable even if the user changes their username later.
 */
function formatUserReference(user, fallbackId) {
  if (user?.id) {
    const mention = userMention(user.id);
    const tag = user.tag || user.username || user.id;
    return `${mention}\n${tag}`;
  }
  return fallbackId ? `ID: ${fallbackId}` : '*Unknown user*';
}

/**
 * Footer helper tailored to user-centric logs. Many embeds append the acting user's ID so moderators
 * can cross-reference audit log entries.
 */
function buildUserFooter(user, extra, fallbackId) {
  const idPart = user?.id
    ? `User ID: ${user.id}`
    : fallbackId
      ? `User ID: ${fallbackId}`
      : null;
  return buildFooter(idPart, extra);
}

/**
 * Logs when a new human member joins the guild. Bots are excluded because they often flood the
 * logging channel during deployments.
 */
async function handleMemberAdd(member) {
  const user = member.user ?? null;
  if (user?.bot) return;
  await dispatchLog(member.guild, () => {
    const joinedAt = member.joinedAt ? new Date(member.joinedAt) : new Date();
    const avatarUrl = user?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.Green,
      emoji: '🟢',
      label: 'Member Joined',
      iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(`${user ? userMention(user.id) : `ID: ${member.id}`} joined the server.`)
      .addFields({
        name: 'Member',
        value: formatUserReference(user, member.id),
        inline: true,
      })
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

    embed.setFooter(buildUserFooter(user, null, member.id));

    return { embeds: [embed] };
  });
}

/**
 * Logs voluntary leaves and moderation removals. We intentionally do not attempt to guess the cause;
 * moderators can cross-reference audit logs if they need additional context.
 */
async function handleMemberRemove(member) {
  const user = member.user ?? null;
  if (user?.bot) return;
  await dispatchLog(member.guild, () => {
    const avatarUrl = user?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.Red,
      emoji: '🔻',
      label: 'Member Left',
      iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(`${user ? userMention(user.id) : `ID: ${member.id}`} left the server.`)
      .addFields({
        name: 'Member',
        value: formatUserReference(user, member.id),
        inline: true,
      });

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

    embed.setFooter(buildUserFooter(user, null, member.id));

    return { embeds: [embed] };
  });
}

/**
 * Captures the best-effort snapshot of a deleted message including attachments. Partial messages are
 * fetched when possible so ephemeral caches do not prevent auditing.
 */
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
  const cachedAuthor = authorId && !author ? client.users.cache.get(authorId) : null;
  const isBotAuthor = Boolean(
    author?.bot
      || message.author?.bot
      || message.member?.user?.bot
      || cachedAuthor?.bot
      || (authorId && client.user?.id && authorId === client.user.id)
  );
  if (isBotAuthor) return;

  const content = message.content?.trim();
  const attachments = message.attachments && message.attachments.size
    ? Array.from(message.attachments.values())
    : [];
  const embedCount = Array.isArray(message.embeds) ? message.embeds.length : 0;

  if (!content && attachments.length === 0) {
    // If we have no details, still log the deletion with minimal info.
  }

  await dispatchLog(message.guild, () => {
    const avatarUrl = author?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.DarkRed,
      emoji: '🗑️',
      label: 'Message Deleted',
      iconURL: author?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(`Message deleted in ${channelMention(message.channelId)}.`)
      .addFields({
        name: 'Author',
        value: formatUserReference(author, authorId || message.authorId || 'unknown'),
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
        .map(att => `• [${att.name || 'attachment'}](${att.url})`)
        .join('\n');
      embed.addFields({ name: 'Attachments', value: trimFieldValue(value) });
    } else {
      embed.addFields({ name: 'Attachments', value: '*None*' });
    }

    embed.setFooter(buildUserFooter(author, message.id ? `Message ID: ${message.id}` : null, authorId));

    return { embeds: [embed] };
  });
}

/**
 * Logs message edits when the content or attachment set changes. Linking back to the message allows
 * moderators to jump directly into context when reviewing the log entry.
 */
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
    const avatarUrl = author?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.Orange,
      emoji: '✏️',
      label: 'Message Edited',
      iconURL: author?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(
        `Message edited in ${channelMention(newMessage.channelId)}. [Jump to message](${newMessage.url})`
      )
      .addFields({
        name: 'Author',
        value: formatUserReference(author, authorId || newMessage.authorId || oldMessage.authorId || 'unknown'),
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
        .map(att => `• [${att.name || 'attachment'}](${att.url})`)
        .join('\n');
      embed.addFields({ name: 'Attachments', value: trimFieldValue(value) });
    }

    embed.setFooter(buildUserFooter(author, newMessage.id ? `Message ID: ${newMessage.id}` : null, authorId));

    return { embeds: [embed] };
  });
}

/**
 * Summarises changes to a member's voice state including joins, disconnects, moves, and mute/deafen
 * toggles. The embed focuses on describing the session in human terms rather than exposing raw
 * gateway events.
 */
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
    const accentColor = joined ? Colors.Green : left ? Colors.Red : moved ? Colors.Orange : Colors.Blurple;
    const avatarUrl = user?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor,
      emoji: '🔊',
      label: 'Voice Activity',
      iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    });

    const descriptionLines = [];
    if (joined) {
      descriptionLines.push(
        `🎧 ${userMention(user.id)} **joined** ${formatChannelReference(newState.channel, newChannelId)}.`
      );
    } else if (left) {
      descriptionLines.push(
        `🚪 ${userMention(user.id)} **left** ${formatChannelReference(oldState.channel, oldChannelId)}.`
      );
    } else if (moved) {
      descriptionLines.push(
        `🔁 ${userMention(user.id)} **moved channels**.`
      );
    } else {
      const channelRef = formatChannelReference(newState.channel ?? oldState.channel, newChannelId ?? oldChannelId);
      descriptionLines.push(`🎛️ ${userMention(user.id)} updated voice state in ${channelRef}.`);
    }

    if (moved) {
      descriptionLines.push(`› From ${formatChannelReference(oldState.channel, oldChannelId)}`);
      descriptionLines.push(`› To ${formatChannelReference(newState.channel, newChannelId)}`);
    }

    if (descriptionLines.length) {
      embed.setDescription(descriptionLines.join('\n'));
    }

    const sessionDetails = [];
    if (newChannelId) {
      sessionDetails.push(`• **Current:** ${formatChannelReference(newState.channel, newChannelId)}`);
    }
    if (oldChannelId) {
      sessionDetails.push(`• **Previous:** ${formatChannelReference(oldState.channel, oldChannelId)}`);
    }
    if (sessionDetails.length) {
      embed.addFields({
        name: 'Voice Session',
        value: trimFieldValue(sessionDetails.join('\n')),
        inline: true,
      });
    }

    if (stateChanges.length) {
      embed.addFields({
        name: 'State Changes',
        value: trimFieldValue(stateChanges.join('\n')),
        inline: true,
      });
    }

    const referenceDetails = [];
    if (newChannelId || oldChannelId) {
      const ref = newChannelId ? newChannelId : oldChannelId;
      referenceDetails.push(`• **Channel ID:** ${ref}`);
    }
    const identifier = member?.id || newState.id || oldState.id;
    if (identifier) {
      referenceDetails.push(`• **User ID:** ${identifier}`);
    }
    if (referenceDetails.length) {
      embed.addFields({
        name: 'Reference',
        value: trimFieldValue(referenceDetails.join('\n')),
        inline: true,
      });
    }

    embed.addFields({
      name: 'Member',
      value: formatUserReference(user, identifier),
      inline: true,
    });

    embed.setFooter(buildUserFooter(user, null, identifier));

    return { embeds: [embed] };
  });
}

/**
 * Tracks role assignments, display name changes, and timeout adjustments. This acts as an early
 * warning system for compromised accounts or accidental moderator actions.
 */
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
    const avatarUrl = user?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.Blurple,
      emoji: '🛠️',
      label: 'Member Updated',
      iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(
        `${user ? userMention(user.id) : `ID: ${newMember.id}`} had member settings updated.`
      );

    embed.addFields({
      name: 'Member',
      value: formatUserReference(user, newMember.id),
      inline: true,
    });

    for (const change of changes) {
      embed.addFields(change);
    }

    embed.setFooter(buildUserFooter(user, null, newMember.id));

    return { embeds: [embed] };
  });
}

/**
 * Emits a summary when a new channel is created, including key properties such as NSFW status or
 * slowmode timers so staff can immediately review the configuration.
 */
async function handleChannelCreate(channel) {
  const guild = channel.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = createLogEmbed({
      accentColor: Colors.Green,
      emoji: '🆕',
      label: 'Channel Created',
      iconURL: guild.iconURL?.({ size: 128 }) || undefined,
    })
      .setDescription(`Created ${formatChannelReference(channel, channel.id)} (${formatChannelType(channel.type)})`)
      .addFields({ name: 'Channel', value: formatChannelReference(channel, channel.id), inline: true })
      .addFields({ name: 'Type', value: formatChannelType(channel.type), inline: true });

    if (channel.parent) {
      embed.addFields({ name: 'Category', value: `${formatChannelReference(channel.parent, channel.parentId)}`, inline: true });
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

    embed.setFooter(buildFooter(`Channel ID: ${channel.id}`));

    return { embeds: [embed] };
  });
}

/**
 * Records when a channel is deleted. We keep the payload intentionally small because Discord removes
 * most metadata once the channel disappears.
 */
async function handleChannelDelete(channel) {
  const guild = channel.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = createLogEmbed({
      accentColor: Colors.Red,
      emoji: '🗑️',
      label: 'Channel Deleted',
      iconURL: guild.iconURL?.({ size: 128 }) || undefined,
    })
      .setDescription(`Deleted ${channel.name ? `#${channel.name}` : channel.id} (${formatChannelType(channel.type)})`)
      .addFields({ name: 'Type', value: formatChannelType(channel.type), inline: true });

    if (channel.parentId) {
      embed.addFields({ name: 'Parent ID', value: `${channel.parentId}`, inline: true });
    }

    embed.setFooter(buildFooter(`Channel ID: ${channel.id}`));

    return { embeds: [embed] };
  });
}

/**
 * Diffs high-value channel properties (name, parent, slowmode, etc.) and logs the changes in a single
 * embed. Skipping unchanged channels avoids spamming the log during routine operations.
 */
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
    const embed = createLogEmbed({
      accentColor: Colors.Blurple,
      emoji: '🔧',
      label: 'Channel Updated',
      iconURL: guild.iconURL?.({ size: 128 }) || undefined,
    })
      .setDescription(
        `Updated ${formatChannelReference(newChannel, newChannel.id ?? oldChannel.id)} (${formatChannelType(newChannel.type)})`
      )
      .addFields({ name: 'Changes', value: trimFieldValue(diffs.join('\n')) })
      .addFields({ name: 'Type', value: formatChannelType(newChannel.type), inline: true });

    embed.setFooter(buildFooter(`Channel ID: ${newChannel.id || oldChannel.id}`));

    return { embeds: [embed] };
  });
}

/**
 * Logs the creation of new roles, including whether they are mentionable or hoisted. Knowing when new
 * privilege-bearing roles appear is important for security audits.
 */
async function handleRoleCreate(role) {
  const guild = role.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = createLogEmbed({
      accentColor: Colors.Green,
      emoji: '🛡️',
      label: 'Role Created',
      iconURL: guild.iconURL?.({ size: 128 }) || undefined,
    })
      .setDescription(`Created ${roleMention(role.id)} (${role.name})`)
      .addFields({ name: 'Role', value: roleMention(role.id), inline: true })
      .addFields({ name: 'Color', value: role.hexColor || 'Default', inline: true })
      .addFields({ name: 'Mentionable', value: boolLabel(role.mentionable), inline: true })
      .addFields({ name: 'Hoisted', value: boolLabel(role.hoist), inline: true });

    embed.setFooter(buildFooter(`Role ID: ${role.id}`));

    return { embeds: [embed] };
  });
}

/**
 * Mirrors role deletions into the log. Even though the role no longer exists we still include the ID
 * so moderators can cross-check other systems.
 */
async function handleRoleDelete(role) {
  const guild = role.guild;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const embed = createLogEmbed({
      accentColor: Colors.Red,
      emoji: '🗑️',
      label: 'Role Deleted',
      iconURL: guild.iconURL?.({ size: 128 }) || undefined,
    })
      .setDescription(`Deleted ${role.name} (${role.id})`)
      .addFields({ name: 'Color', value: role.hexColor || 'Default', inline: true })
      .addFields({ name: 'Hoisted', value: boolLabel(role.hoist), inline: true })
      .addFields({ name: 'Mentionable', value: boolLabel(role.mentionable), inline: true });

    embed.setFooter(buildFooter(`Role ID: ${role.id}`));

    return { embeds: [embed] };
  });
}

/**
 * Reports modifications to existing roles, highlighting permission changes and other impactful
 * fields. Permission diffs are wrapped in backticks to improve readability.
 */
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
    const embed = createLogEmbed({
      accentColor: Colors.Blurple,
      emoji: '🛠️',
      label: 'Role Updated',
      iconURL: guild.iconURL?.({ size: 128 }) || undefined,
    })
      .setDescription(`Updated ${roleMention(newRole.id)} (${newRole.name})`)
      .addFields({ name: 'Role', value: roleMention(newRole.id), inline: true })
      .addFields({ name: 'Changes', value: trimFieldValue(diffs.join('\n')) });

    embed.setFooter(buildFooter(`Role ID: ${newRole.id}`));

    return { embeds: [embed] };
  });
}

/**
 * Announces when a user is banned. The embed includes the reason when provided so staff can review
 * moderation consistency later.
 */
async function handleGuildBanAdd(ban) {
  const { guild, user, reason } = ban;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const avatarUrl = user?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.DarkRed,
      emoji: '⛔',
      label: 'User Banned',
      iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(`${user ? userMention(user.id) : ban.userId} was banned from the server.`)
      .addFields({
        name: 'Member',
        value: formatUserReference(user, ban.userId || user?.id),
        inline: true,
      });

    if (reason) {
      embed.addFields({ name: 'Reason', value: trimFieldValue(reason) });
    }

    embed.setFooter(buildUserFooter(user, null, ban.userId || user?.id));

    return { embeds: [embed] };
  });
}

/**
 * Announces when a user is unbanned. Including the previous reason gives context about why the ban
 * may have been reversed.
 */
async function handleGuildBanRemove(ban) {
  const { guild, user, reason } = ban;
  if (!guild) return;

  await dispatchLog(guild, () => {
    const avatarUrl = user?.displayAvatarURL?.({ size: 256 }) || null;
    const embed = createLogEmbed({
      accentColor: Colors.Green,
      emoji: '✅',
      label: 'User Unbanned',
      iconURL: user?.displayAvatarURL?.({ size: 128 }) || undefined,
      thumbnailURL: avatarUrl || undefined,
    })
      .setDescription(`${user ? userMention(user.id) : ban.userId} was unbanned from the server.`)
      .addFields({
        name: 'Member',
        value: formatUserReference(user, ban.userId || user?.id),
        inline: true,
      });

    if (reason) {
      embed.addFields({ name: 'Previous Reason', value: trimFieldValue(reason) });
    }

    embed.setFooter(buildUserFooter(user, null, ban.userId || user?.id));

    return { embeds: [embed] };
  });
}

/**
 * Installs event listeners on the shared Discord client. The guard against double-registration makes
 * the function safe to call multiple times (useful in tests or hot reload scenarios).
 */
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
