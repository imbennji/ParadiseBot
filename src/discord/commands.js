const {
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
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

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel for Steam announcements')
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
    .setName('rank')
    .setDescription('Check Paradise XP levels')
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Who to inspect (defaults to yourself)')
        .setRequired(false)
    ),
];

const commands = commandBuilders.map(c => c.toJSON());
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

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
  }
}

module.exports = {
  commandBuilders,
  registerCommandsOnStartup,
  handleChatCommand,
};
