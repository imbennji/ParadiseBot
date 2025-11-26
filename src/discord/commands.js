/**
 * Slash command registry and dispatcher. This module defines every public interaction supported by
 * ParadiseBot along with the imperative handlers that execute each command. Documentation is kept
 * close to the code to make maintenance approachable—moderation commands, Steam integration, and
 * music playback all live here.
 */
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
const { handleMusicCommand } = require('../music/commands');
const { ensureLeaderboardMessage } = require('../loops/leaderboard');
const { ensureSalesMessage } = require('../sales/index');
const {
  resolveSteamId,
  getRecentlyPlayed,
  getOwnedGames,
  getAppInstallSize,
} = require('../steam/api');
const { getRankStats } = require('./xp');
const { grantLinkPermit, PERMIT_DURATION_MS } = require('./permits');

/**
 * Raw slash command definitions. These builders are transformed into JSON during startup and sent to
 * Discord using the REST API. When adding new commands remember to document the corresponding
 * handler below so future contributors understand the guardrails and side-effects.
 */
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
          { name: 'music',                  value: CHANNEL_KINDS.MUSIC },
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
    .setName('librarysize')
    .setDescription('Estimate a Steam user\'s total install size across their library')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('profile')
        .setDescription('Steam vanity/profile URL/steamid64 to inspect')
        .setRequired(true)
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
    .setName('music')
    .setDescription('Music playback controls')
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('join').setDescription('Summon the bot to your voice channel'))
    .addSubcommand(sc =>
      sc.setName('play')
        .setDescription('Queue a song by URL or search term')
        .addStringOption(opt =>
          opt.setName('query')
            .setDescription('YouTube URL or search keywords')
            .setRequired(true)
        )
    )
    .addSubcommand(sc => sc.setName('skip').setDescription('Skip the current track'))
    .addSubcommand(sc => sc.setName('queue').setDescription('Show the current queue'))
    .addSubcommand(sc => sc.setName('leave').setDescription('Clear the queue and leave the voice channel')),
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

/**
 * REST client used solely for slash-command registration. The runtime interactions go through the
 * gateway connection provided by the shared client but registration must use the HTTP API.
 */
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

/**
 * Discord only allows bulk-deleting messages younger than 14 days. Anything older has to be deleted
 * individually which is why `handleClearChat` maintains both bulk and manual queues.
 */
const BULK_DELETE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Formats a byte count into a human-friendly string. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / (1024 ** idx);
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[idx]}`;
}

/**
 * Registers (or updates) the slash command definitions with Discord. The function targets either a
 * single development guild for faster iteration or the global command registry when no override is
 * provided.
 */
async function registerCommandsOnStartup() {
  const t = time('CMD:register');
  const payload = commandBuilders.map(c => c.toJSON());
  try {
    if (DEV_GUILD_ID) {
      log.tag('CMD').info(`Registering ${payload.length} commands → guild ${DEV_GUILD_ID}`);
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DEV_GUILD_ID), { body: payload });
      log.tag('CMD').info('Guild commands registered.');
    }

    log.tag('CMD').info(`Registering ${payload.length} commands → GLOBAL`);
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: payload });
    log.tag('CMD').info('Global commands registered (may take a bit to propagate).');
  } catch (err) {
    log.tag('CMD').error('Registration failed:', err?.stack || err);
  } finally { t.end(); }
}

/**
 * Persists the mapping between a semantic announcement kind and a concrete text channel.
 * Moderators must grant the bot minimal permissions before the mapping is stored to prevent silent
 * failures later when announcements attempt to send embeds.
 */
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

/**
 * Links the invoking Discord user to a Steam profile. We validate the mapping, respect account
 * locks so a single Steam account cannot be shared, and seed future polling via the `links` table.
 */
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

/**
 * Removes all traces of the user's Steam data from the guild, including cached progress tables and
 * ownership information. This command is intentionally aggressive so privacy requests are honoured
 * immediately.
 */
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

/**
 * Comprehensive health check that exercises the database, the Steam Web API, and optionally a
 * user-supplied profile resolution. Returning granular errors helps moderators differentiate between
 * networking issues and misconfiguration.
 */
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

/**
 * Estimates the total install size of a Steam user's library by summing depot sizes exposed via the
 * public SteamCMD metadata endpoint. Some titles do not publish size information; those are skipped
 * so the total reflects a best-effort floor rather than an overestimate.
 */
async function handleLibrarySize(interaction) {
  const profile = interaction.options.getString('profile', true).trim();
  await interaction.deferReply({ ephemeral: true });

  const steamId = await resolveSteamId(profile);
  if (!steamId) {
    return interaction.editReply('❌ Could not resolve that Steam profile. Please double-check the vanity name or SteamID64.');
  }

  let games;
  try {
    games = await getOwnedGames(steamId);
  } catch (err) {
    log.tag('CMD:librarysize').warn(`owned fetch failed steam=${steamId}:`, err?.stack || err);
    return interaction.editReply('I could not fetch that library. The profile may be private or Steam is unreachable.');
  }

  if (!games.length) {
    return interaction.editReply('That library appears to be empty or private.');
  }

  let cursor = 0;
  let totalBytes = 0;
  let counted = 0;
  let missing = 0;
  const concurrency = 8;

  async function worker() {
    while (cursor < games.length) {
      const idx = cursor++;
      const game = games[idx];
      const size = await getAppInstallSize(game.appid);
      if (Number.isFinite(size) && size > 0) {
        totalBytes += size;
        counted += 1;
      } else {
        missing += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (!counted) {
    return interaction.editReply('I could not retrieve size data for any games in that library. The profile may be private or the games do not expose install sizes.');
  }

  const totalGames = games.length;
  const summary = `Estimated install size for **${steamId}**: **${formatBytes(totalBytes)}** across ${counted}/${totalGames} games.`;
  const caveat = missing ? ' Some titles did not expose size data, so the real total is likely higher.' : '';

  log.tag('CMD:librarysize').info(`steam=${steamId} games=${totalGames} counted=${counted} missing=${missing} totalBytes=${totalBytes}`);
  return interaction.editReply(summary + caveat);
}

/**
 * Ensures the static leaderboard embed exists in the invoking channel. The heavy lifting lives in
 * `ensureLeaderboardMessage`, this wrapper simply validates permissions and provides user feedback.
 */
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

/**
 * Creates or moves the Steam Game Sales embed. Similar to the leaderboard command this is mostly a
 * permissions guard that delegates the actual embed management to the sales module.
 */
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

/**
 * Constructs an audit-log friendly reason string that contains both the moderator identity and the
 * provided rationale. Discord caps audit log reasons at 512 characters, so we enforce the limit
 * defensively.
 */
function getAuditReason(interaction, reason) {
  const base = reason?.trim() ? reason.trim() : 'No reason provided';
  const actor = `${interaction.user.tag ?? interaction.user.username} (${interaction.user.id})`;
  return `${actor}: ${base}`.slice(0, 512);
}

/**
 * Performs a series of safety checks before moderators act on a guild member: it prevents
 * self-targeting, protects the server owner and the bot, and validates role hierarchy so that only
 * higher ranked moderators can escalate actions.
 */
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

/**
 * Kicks a member from the guild after confirming the moderator outranks the target and the bot has
 * sufficient permissions. A courtesy DM is sent to the user when possible.
 */
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

/**
 * Discord accepts message deletion durations in seconds; this constant converts the user facing day
 * selector into the unit expected by the API.
 */
const BAN_DELETE_SECONDS = 24 * 60 * 60;

/**
 * Bans a user (or guild member) and optionally deletes up to seven days of message history. The
 * handler guards against moderators banning themselves or the bot while respecting role hierarchy.
 */
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

/**
 * Mapping of slash-command option values to millisecond durations. Keeping the conversion table
 * local makes it easy to audit which timeout lengths we support without scanning Discord's docs.
 */
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

/**
 * Applies Discord's native timeout feature to a member for a pre-defined duration. The function
 * shares permission checks with the other moderation commands so behaviour is consistent.
 */
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

/**
 * Removes a small number of recent messages (optionally filtered by author) using Discord's bulk
 * deletion API. This is designed for quick cleanup jobs where the messages are recent enough to be
 * purged in a single request.
 */
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

/**
 * Iteratively clears up to 200 messages from a channel, gracefully degrading to manual deletions for
 * messages older than 14 days. The implementation favours predictable progress reporting so
 * moderators understand what happened.
 */
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

        const withinBulkWindow = now - message.createdTimestamp < BULK_DELETE_WINDOW_MS;

        if (!message.deletable) {
          if (!withinBulkWindow) {
            scheduled += 1;
            manualCandidates.push(message);
          }

          continue;
        }

        scheduled += 1;

        if (withinBulkWindow) {
          bulkCandidates.set(message.id, message);
        } else {
          manualCandidates.push(message);
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

/**
 * Sends a DM warning to a member and records the action to the logs. Because DMs can fail (user has
 * DMs disabled) we surface the result back to the moderator.
 */
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

/**
 * Grants a temporary link posting permit to a user by inserting a record into the permit cache. The
 * sales module reads these permits to exempt trusted users from automatic deletions.
 */
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

/**
 * Displays Paradise XP stats for the invoking user (or an optional target). The response is concise
 * enough to post in-channel which encourages friendly competition.
 */
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

/**
 * Primary dispatcher invoked by `interactionCreate`. Each case delegates to the appropriately
 * documented handler above so the switch statement acts as a map between slash command names and
 * business logic.
 */
async function handleChatCommand(interaction) {
  switch (interaction.commandName) {
    case 'setchannel':   await handleSetChannel(interaction);  break;
    case 'linksteam':    await handleLinkSteam(interaction);   break;
    case 'unlinksteam':  await handleUnlinkSteam(interaction); break;
    case 'pingsteam':    await handlePingSteam(interaction);   break;
    case 'librarysize':  await handleLibrarySize(interaction); break;
    case 'leaderboard':  await handleLeaderboard(interaction); break;
    case 'sales':        await handleSalesCmd(interaction);    break;
    case 'music':        await handleMusicCommand(interaction); break;
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
