const {
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  Collection,
} = require('discord.js');
const axios = require('axios').default;
const { log, time } = require('../logger');
const { dbRun, dbGet } = require('../db');
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DEV_GUILD_ID,
  STEAM_API_KEY,
  STEAM_HOST,
} = require('../config');
const {
  CHANNEL_KINDS,
  normalizeKind,
  hasBotPerms,
} = require('./channels');
const { ensureLeaderboardMessage } = require('../loops/leaderboard');
const { ensureSalesMessage } = require('../sales/index');
const {
  resolveSteamId,
  getRecentlyPlayed,
} = require('../steam/api');
const { getRankStats } = require('./xp');
const { grantLinkPermit, PERMIT_DURATION_MS } = require('./permits');

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel for Paradise Bot announcements')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('type')
        .setDescription('Which announcements should go to this channel')
        .setRequired(true)
        .addChoices(
          { name: 'steam_achievements',     value: CHANNEL_KINDS.ACHIEVEMENTS },
          { name: 'new_game_notifications', value: CHANNEL_KINDS.NEW_GAMES },
          { name: 'now_playing',            value: CHANNEL_KINDS.NOW_PLAYING },
          { name: 'milestones',             value: CHANNEL_KINDS.MILESTONES },
          { name: 'library_removals',       value: CHANNEL_KINDS.LIBRARY },
          { name: 'leaderboard',            value: CHANNEL_KINDS.LEADERBOARD },
          { name: 'steam_game_sales',       value: CHANNEL_KINDS.SALES },
          { name: 'xp_levelups',            value: CHANNEL_KINDS.XP },
          { name: 'logging',                value: CHANNEL_KINDS.LOGGING },
          { name: 'github_commits',         value: CHANNEL_KINDS.GITHUB },
        )
    )
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('Defaults to the current channel if omitted')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('linksteam')
    .setDescription('Link your Steam account (vanity, profile URL, or 64-bit SteamID)')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('profile')
        .setDescription('e.g. mysteamname OR https://steamcommunity.com/id/mysteamname OR 7656119...')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('unlinksteam')
    .setDescription('Unlink your Steam account in this server')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('pingsteam')
    .setDescription('Quick health check: DB + Steam API (optional: test a profile)')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('profile')
        .setDescription('Optional vanity/profile URL/steamid64 to test resolution & a simple call')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Manage the permanent leaderboard message')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('init').setDescription('Create or move the leaderboard to this channel')),
  new SlashCommandBuilder()
    .setName('sales')
    .setDescription('Manage the Steam Game Sales permanent embed')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('init').setDescription('Create/move the Steam Game Sales embed to this channel')),
  new SlashCommandBuilder()
    .setName('permit')
    .setDescription('Temporarily allow a member to post links')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to permit')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Check Paradise XP levels')
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to inspect (defaults to yourself)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers)
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to kick')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason')
        .setDescription('Optional reason (shown in audit log & DM)')
        .setMaxLength(350)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to ban')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('delete_messages')
        .setDescription('Delete message history (0-7 days)')
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('reason')
        .setDescription('Optional reason (shown in audit log & DM)')
        .setMaxLength(350)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Temporarily timeout a member')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to timeout')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('duration')
        .setDescription('How long should the timeout last?')
        .setRequired(true)
        .addChoices(
          { name: '5 minutes',  value: '5m' },
          { name: '10 minutes', value: '10m' },
          { name: '1 hour',     value: '1h' },
          { name: '6 hours',    value: '6h' },
          { name: '12 hours',   value: '12h' },
          { name: '1 day',      value: '1d' },
          { name: '3 days',     value: '3d' },
          { name: '1 week',     value: '7d' }
        )
    )
    .addStringOption(opt =>
      opt.setName('reason')
        .setDescription('Optional reason (shown in audit log & DM)')
        .setMaxLength(350)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk delete recent messages in this channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .setDMPermission(false)
    .addIntegerOption(opt =>
      opt.setName('count')
        .setDescription('How many messages to delete (max 100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Only delete messages from this user')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('clearchat')
    .setDescription('Delete recent messages to quickly clear the chat view')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .setDMPermission(false)
    .addIntegerOption(opt =>
      opt.setName('lines')
        .setDescription('How many recent messages to delete (max 200)')
        .setMinValue(1)
        .setMaxValue(200)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Send a warning DM to a member')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to warn')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason')
        .setDescription('Why are they being warned?')
        .setMaxLength(350)
        .setRequired(true)
    ),
];

const commands = commandBuilders.map(c => c.toJSON());
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const BULK_DELETE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

async function registerCommandsOnStartup() {
  const t = time('CMD:register');
  try {
    if (DEV_GUILD_ID) {
      log.tag('CMD').info(`Registering ${commands.length} commands → guild ${DEV_GUILD_ID}`);
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DEV_GUILD_ID), { body: commands });
      log.tag('CMD').info('Guild commands registered.');
    } else {
      log.tag('CMD').info(`Registering ${commands.length} commands → GLOBAL`);
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
      log.tag('CMD').info('Global commands registered (may take a bit to propagate).');
    }
  } catch (err) {
    log.tag('CMD').error('Registration failed:', err?.stack || err);
  } finally { t.end(); }
}

async function handleSetChannel(interaction) {
  const kind = normalizeKind(interaction.options.getString('type', true));
  if (!kind) return interaction.reply({ content: 'Unknown type.', ephemeral: true });

  const target = interaction.options.getChannel('channel') || interaction.channel;
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({ content: 'You need **Manage Server** to do this.', ephemeral: true });
  }
  if (target.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
  }
  const perms = hasBotPerms(target);
  if (!perms.ok) {
    return interaction.reply({
      content: `I’m missing permissions in ${target}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`,
      ephemeral: true
    });
  }

  await dbRun(
    'INSERT INTO guild_channels (guild_id, kind, channel_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)',
    [interaction.guildId, kind, target.id]
  );
  await dbRun('INSERT INTO guilds (guild_id, channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)',
    [interaction.guildId, target.id]);

  if (kind === CHANNEL_KINDS.LEADERBOARD) {
    await ensureLeaderboardMessage(interaction.guild, target);
  } else if (kind === CHANNEL_KINDS.SALES) {
    await ensureSalesMessage(interaction.guild, target);
  }

  log.tag('CMD:setchannel').info(`guild=${interaction.guildId} kind=${kind} channel=${target.id}`);
  return interaction.reply({ content: `✅ Channel set for **${kind.replaceAll('_',' ')}** → ${target}.`, ephemeral: true });
}

async function handleLinkSteam(interaction) {
  const input = interaction.options.getString('profile', true).trim();
  await interaction.deferReply({ ephemeral: true });

  const already = await dbGet('SELECT steam_id FROM links WHERE guild_id=? AND user_id=?', [interaction.guildId, interaction.user.id]);
  if (already) {
    return interaction.editReply(`You already linked **${already.steam_id}** here. Use \`/unlinksteam\` first (this also clears your cached data).`);
  }

  const steamId = await resolveSteamId(input);
  if (!steamId) throw new Error('Could not resolve that Steam profile. Make sure the URL/name/ID is valid.');

  const lock = await dbGet('SELECT user_id FROM steam_account_locks WHERE steam_id=?', [steamId]);
  if (lock && lock.user_id !== interaction.user.id) {
    return interaction.editReply(`❌ That Steam account is already linked by another Discord user.`);
  }

  await dbRun('INSERT INTO links (guild_id, user_id, steam_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE steam_id=VALUES(steam_id)', [interaction.guildId, interaction.user.id, steamId]);
  await dbRun('INSERT INTO steam_account_locks (steam_id, user_id, linked_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), linked_at=VALUES(linked_at)', [steamId, interaction.user.id, Math.floor(Date.now()/1000)]);

  log.tag('CMD:linksteam').info(`guild=${interaction.guildId} user=${interaction.user.id} steamId=${steamId}`);
  return interaction.editReply(`✅ Linked <@${interaction.user.id}> → **${steamId}**.`);
}

async function handleUnlinkSteam(interaction) {
  const g = interaction.guildId, u = interaction.user.id;
  const link = await dbGet('SELECT steam_id FROM links WHERE guild_id=? AND user_id=?', [g, u]);
  const steamId = link?.steam_id || null;

  await dbRun('DELETE FROM links WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM watermarks WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM owned_seen WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM ach_progress_marks WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM playtime_marks WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM nowplaying_state WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM owned_presence WHERE guild_id = ? AND user_id = ?', [g, u]);
  await dbRun('DELETE FROM user_game_stats WHERE guild_id = ? AND user_id = ?', [g, u]);

  if (steamId) {
    const lock = await dbGet('SELECT user_id FROM steam_account_locks WHERE steam_id=?', [steamId]);
    if (lock && lock.user_id === u) await dbRun('DELETE FROM steam_account_locks WHERE steam_id=?', [steamId]);
  }

  log.tag('CMD:unlinksteam').info(`guild=${g} user=${u} -> cleared & unlocked`);
  return interaction.reply({ content: '✅ Unlinked and all cached data cleared.', ephemeral: true });
}

async function handlePingSteam(interaction) {
  const profile = interaction.options.getString('profile', false)?.trim();
  await interaction.deferReply({ ephemeral: true });

  try { await dbGet('SELECT 1 AS ok'); } catch (e) { return interaction.editReply(`❌ DB check failed: ${e.message || e}`); }
  try {
    const t = time('HTTP:ServerInfo');
    await axios.get(`${STEAM_HOST}/ISteamWebAPIUtil/GetServerInfo/v1/?key=${encodeURIComponent(STEAM_API_KEY)}`, { timeout: 10000 });
    t.end();
  } catch (e) { return interaction.editReply(`❌ Steam API base check failed: ${e.message || e}`); }

  if (profile) {
    try {
      const steamId = await resolveSteamId(profile);
      if (!steamId) throw new Error('profile could not be resolved');
      await getRecentlyPlayed(steamId);
      return interaction.editReply(`✅ Health OK. DB ✅, Steam API ✅, Profile **${steamId}** ✅`);
    } catch (e) {
      return interaction.editReply(`⚠️ Basic OK (DB ✅ Steam ✅) but profile test failed: ${e.message || e}`);
    }
  }
  return interaction.editReply(`✅ Health OK. DB ✅, Steam API ✅`);
}

async function handleLeaderboard(interaction) {
  if (interaction.options.getSubcommand() === 'init') {
    const channel = interaction.channel;
    const perms = hasBotPerms(channel);
    if (!perms.ok) {
      return interaction.reply({ content: `I’m missing permissions in ${channel}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    await ensureLeaderboardMessage(interaction.guild, channel);
    await interaction.editReply('✅ Leaderboard initialized/moved here. I’ll keep this message updated.');
  }
}

async function handleSalesCmd(interaction) {
  if (interaction.options.getSubcommand() === 'init') {
    const channel = interaction.channel;
    const perms = hasBotPerms(channel);
    if (!perms.ok) {
      return interaction.reply({ content: `I’m missing permissions in ${channel}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    await ensureSalesMessage(interaction.guild, channel);
    await interaction.editReply('✅ Steam Game Sales embed initialized/moved here. Use the buttons to page through discounted games.');
  }
}

function getAuditReason(interaction, reason) {
  const base = reason?.trim() ? reason.trim() : 'No reason provided';
  const actor = `${interaction.user.tag ?? interaction.user.username} (${interaction.user.id})`;
  return `${actor}: ${base}`.slice(0, 512);
}

function ensureCanActOn(interaction, member) {
  if (!member) return true;
  if (member.id === interaction.user.id) return false;
  if (member.id === interaction.client.user.id) return false;
  if (member.id === interaction.guild.ownerId) return false;

  const moderator = interaction.member;
  if (!moderator || !moderator.roles || !member.roles) return true;
  if (interaction.user.id === interaction.guild.ownerId) return true;

  try {
    return moderator.roles.highest.comparePositionTo(member.roles.highest) > 0;
  } catch (err) {
    log.tag('CMD:mod').warn('Role comparison failed:', err?.stack || err);
    return true;
  }
}

async function handleKick(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (!member) {
    return interaction.editReply('That user is not in this server.');
  }
  if (!ensureCanActOn(interaction, member)) {
    return interaction.editReply('You cannot take action on that member.');
  }
  if (!member.kickable) {
    return interaction.editReply('I do not have permission to kick that member.');
  }

  await member.kick(getAuditReason(interaction, reason));
  log.tag('CMD:kick').info(`guild=${interaction.guildId} target=${member.id} moderator=${interaction.user.id}`);

  await interaction.editReply(`👢 Kicked ${member.user.tag}. Reason: ${reason}`);

  await member.user.send(`You have been kicked from **${interaction.guild.name}**. Reason: ${reason}`).catch(() => {});
}

const BAN_DELETE_SECONDS = 24 * 60 * 60;

async function handleBan(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
  const deleteDays = interaction.options.getInteger('delete_messages') ?? 0;

  if (user.id === interaction.user.id) {
    return interaction.editReply('You cannot ban yourself.');
  }
  if (user.id === interaction.client.user.id) {
    return interaction.editReply('Nice try, but I cannot ban myself.');
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member) {
    if (!ensureCanActOn(interaction, member)) {
      return interaction.editReply('You cannot take action on that member.');
    }
    if (!member.bannable) {
      return interaction.editReply('I do not have permission to ban that member.');
    }
  }

  const deleteMessageSeconds = Math.max(0, Math.min(deleteDays, 7)) * BAN_DELETE_SECONDS;

  await interaction.guild.members.ban(user.id, {
    reason: getAuditReason(interaction, reason),
    deleteMessageSeconds,
  });

  log.tag('CMD:ban').info(`guild=${interaction.guildId} target=${user.id} moderator=${interaction.user.id} deleteDays=${deleteDays}`);

  await interaction.editReply(`🔨 Banned ${user.tag}. Reason: ${reason}. Deleted ${deleteDays} day(s) of messages.`);

  await user.send(`You have been banned from **${interaction.guild.name}**. Reason: ${reason}`).catch(() => {});
}

const TIMEOUT_DURATIONS = {
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

async function handleTimeout(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);
  const durationKey = interaction.options.getString('duration', true);
  const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
  const duration = TIMEOUT_DURATIONS[durationKey];

  if (!duration) {
    return interaction.editReply('Unknown timeout duration.');
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply('That user is not in this server.');
  }
  if (!ensureCanActOn(interaction, member)) {
    return interaction.editReply('You cannot take action on that member.');
  }
  if (!member.moderatable) {
    return interaction.editReply('I do not have permission to timeout that member.');
  }

  await member.timeout(duration, getAuditReason(interaction, reason));
  log.tag('CMD:timeout').info(`guild=${interaction.guildId} target=${member.id} moderator=${interaction.user.id} duration=${durationKey}`);

  await interaction.editReply(`⏱️ Timed out ${member.user.tag} for ${durationKey}. Reason: ${reason}`);

  await member.user.send(`You have been timed out in **${interaction.guild.name}** for ${durationKey}. Reason: ${reason}`).catch(() => {});
}

async function handlePurge(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'This command can only be used in text channels.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const count = interaction.options.getInteger('count', true);
  const targetUser = interaction.options.getUser('user');

  const fetched = await channel.messages.fetch({ limit: Math.min(Math.max(count, 1), 100) });
  const filtered = targetUser ? fetched.filter(msg => msg.author.id === targetUser.id) : fetched;
  const first = filtered.first(count);
  const messagesToDelete = Array.isArray(first) ? first : first ? [first] : [];

  if (messagesToDelete.length === 0) {
    return interaction.editReply('No messages matched the criteria.');
  }

  const deleted = await channel.bulkDelete(messagesToDelete, true);
  log.tag('CMD:purge').info(`guild=${interaction.guildId} moderator=${interaction.user.id} channel=${channel.id} deleted=${deleted.size}`);

  const scope = targetUser ? ` from ${targetUser.tag}` : '';
  await interaction.editReply(`🧹 Deleted ${deleted.size} message(s)${scope}.`);
}

async function handleClearChat(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: 'This command can only be used in text channels.', ephemeral: true });
  }

  const perms = hasBotPerms(channel);
  if (!perms.ok) {
    return interaction.reply({ content: `I’m missing permissions in ${channel}: **ViewChannel**, **SendMessages**, **EmbedLinks**.`, ephemeral: true });
  }

  const requestedLines = interaction.options.getInteger('lines', true);
  const lines = Math.min(Math.max(requestedLines, 1), 200);
  const limited = lines !== requestedLines;

  await interaction.deferReply({ ephemeral: true });

  let remaining = lines;
  let deletedCount = 0;
  let cursor;

  try {
    while (remaining > 0) {
      const fetchSize = Math.min(remaining, 100);
      const fetchOptions = { limit: fetchSize };
      if (cursor) {
        fetchOptions.before = cursor;
      }

      const fetched = await channel.messages.fetch(fetchOptions).catch(err => {
        log.tag('CMD:clearchat').warn(`guild=${interaction.guildId} channel=${channel.id} fetch failed:`, err?.stack || err);
        throw err;
      });

      if (fetched.size === 0) {
        break;
      }

      const bulkCandidates = new Collection();
      const manualCandidates = [];
      let scheduled = 0;
      let progress = 0;
      const now = Date.now();

      for (const message of fetched.values()) {
        if (scheduled >= remaining) {
          break;
        }

        if (!message.deletable) {
          continue;
        }

        scheduled += 1;

        if (now - message.createdTimestamp >= BULK_DELETE_WINDOW_MS) {
          manualCandidates.push(message);
        } else {
          bulkCandidates.set(message.id, message);
        }
      }

      if (bulkCandidates.size > 0) {
        const bulkResult = await channel.bulkDelete(bulkCandidates, true).catch(err => {
          log.tag('CMD:clearchat').warn(`guild=${interaction.guildId} channel=${channel.id} bulk delete failed:`, err?.stack || err);
          return null;
        });

        if (bulkResult) {
          if (bulkResult.size > 0) {
            progress += bulkResult.size;
            deletedCount += bulkResult.size;
            remaining -= bulkResult.size;
          }

          if (bulkResult.size < bulkCandidates.size) {
            for (const [id, message] of bulkCandidates.entries()) {
              if (!bulkResult.has(id)) {
                manualCandidates.push(message);
              }
            }
          }
        } else {
          manualCandidates.push(...bulkCandidates.values());
        }
      }

      for (const message of manualCandidates) {
        if (remaining <= 0) {
          break;
        }

        const success = await message.delete().then(() => true).catch(err => {
          log.tag('CMD:clearchat').warn(`guild=${interaction.guildId} channel=${channel.id} delete failed message=${message.id}:`, err?.stack || err);
          return false;
        });

        if (success) {
          remaining -= 1;
          deletedCount += 1;
          progress += 1;
        }
      }

      cursor = fetched.lastKey();

      if (!cursor || progress === 0) {
        break;
      }
    }
  } catch (err) {
    return interaction.editReply('I ran into an error while removing messages. Please try again later.');
  }

  if (deletedCount === 0) {
    return interaction.editReply('I could not remove any messages. They might be too old or not deletable.');
  }

  log.tag('CMD:clearchat').info(`guild=${interaction.guildId} moderator=${interaction.user.id} channel=${channel.id} requested=${lines} deleted=${deletedCount}`);

  const suffix = limited ? ` Requested ${requestedLines}, but I can only delete up to 200 at once.` : '';
  const short = deletedCount < lines ? ' Some messages may be too old or not deletable.' : '';
  await interaction.editReply(`🧼 Deleted ${deletedCount} message(s).${suffix}${short}`);
}

async function handleWarn(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true).trim();
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (!member) {
    return interaction.editReply('That user is not in this server.');
  }

  if (!ensureCanActOn(interaction, member)) {
    return interaction.editReply('You cannot take action on that member.');
  }

  const dmMessage = `You have been warned in **${interaction.guild.name}**. Reason: ${reason}`;
  const dmResult = await user.send(dmMessage).then(() => true).catch(() => false);

  log.tag('CMD:warn').info(`guild=${interaction.guildId} target=${user.id} moderator=${interaction.user.id} dm=${dmResult}`);

  await interaction.editReply(`⚠️ Warned ${user.tag}.${dmResult ? ' They were notified via DM.' : ' I could not DM them.'}`);
}

async function handlePermit(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: 'This command can only be used in servers.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser('user', true);
  if (target.bot) {
    return interaction.editReply('Bots do not need permits.');
  }

  const expiresAt = await grantLinkPermit(interaction.guildId, target.id, interaction.user.id, PERMIT_DURATION_MS);
  const expiresIn = new Date(expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const minutes = Math.round(PERMIT_DURATION_MS / 60000);

  await interaction.editReply(`✅ ${target} can post links for the next ${minutes} minutes (until ~${expiresIn}).`);
}

async function handleRank(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const stats = await getRankStats(interaction.guildId, target.id);

  if (!stats) {
    const content = target.id === interaction.user.id
      ? 'You have not earned any Paradise XP yet. Start chatting to level up!'
      : `${target} has not earned any Paradise XP yet.`;
    return interaction.reply({ content, ephemeral: true });
  }

  const { level, totalXp, xpIntoLevel, xpForNextLevel, xpToNextLevel } = stats;
  const subject = target.id === interaction.user.id ? 'You are' : `${target} is`;
  const progress = `${xpIntoLevel}/${xpForNextLevel} XP (${xpToNextLevel} XP to go)`;

  return interaction.reply({
    content: `${subject} level **${level}** with **${totalXp}** XP. Progress to next level: ${progress}.`,
  });
}

async function handleChatCommand(interaction) {
  switch (interaction.commandName) {
    case 'setchannel':   await handleSetChannel(interaction);  break;
    case 'linksteam':    await handleLinkSteam(interaction);   break;
    case 'unlinksteam':  await handleUnlinkSteam(interaction); break;
    case 'pingsteam':    await handlePingSteam(interaction);   break;
    case 'leaderboard':  await handleLeaderboard(interaction); break;
    case 'sales':        await handleSalesCmd(interaction);    break;
    case 'rank':         await handleRank(interaction);        break;
    case 'kick':         await handleKick(interaction);        break;
    case 'ban':          await handleBan(interaction);         break;
    case 'timeout':      await handleTimeout(interaction);     break;
    case 'purge':        await handlePurge(interaction);       break;
    case 'clearchat':    await handleClearChat(interaction);   break;
    case 'warn':         await handleWarn(interaction);        break;
    case 'permit':       await handlePermit(interaction);      break;
  }
}

module.exports = {
  commandBuilders,
  registerCommandsOnStartup,
  handleChatCommand,
};
