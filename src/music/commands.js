/**
 * Slash command handlers for the music subsystem. The commands interact with the shared player
 * singleton exposed by `player.js` and support queueing tracks, skipping, and displaying the queue.
 */
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { resolveTrack } = require('./sources');
const { ensureGuildSubscription, getSubscription, destroySubscription } = require('./player');
const { CHANNEL_KINDS, getAnnouncementChannel } = require('../discord/channels');
const { log } = require('../logger');

/**
 * Formats a millisecond duration into `H:MM:SS` or `MM:SS` depending on the length. Live streams are
 * labelled accordingly.
 */
function formatDuration(ms) {
  if (!ms) return 'Live';
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const parts = [];
  if (hours) parts.push(String(hours));
  parts.push(String(hours ? minutes.toString().padStart(2, '0') : minutes));
  parts.push(seconds.toString().padStart(2, '0'));
  return parts.join(':');
}

/**
 * Binds to the player events so every time a new track starts we announce it in the configured music
 * channel. The handler is idempotent to avoid double-registration.
 */
function attachAnnouncements(subscription, guild) {
  if (subscription.__musicAnnouncementBound) return;
  const handler = async (track) => {
    try {
      const channel = await getAnnouncementChannel(guild, CHANNEL_KINDS.MUSIC);
      if (!channel) return;
      const embed = new EmbedBuilder()
        .setTitle('Now Playing')
        .setDescription(`[${track.title}](${track.url})`)
        .setColor(0x5865f2)
        .setTimestamp(new Date())
        .addFields(
          { name: 'Requested by', value: track.requestedById ? `<@${track.requestedById}>` : track.requestedByTag || 'Unknown', inline: true },
          { name: 'Duration', value: formatDuration(track.durationMs), inline: true },
        );
      if (track.thumbnail) {
        embed.setThumbnail(track.thumbnail);
      }
      const queueState = subscription.getQueue();
      if (queueState.upcoming.length) {
        embed.addFields({
          name: 'Up Next',
          value: queueState.upcoming.slice(0, 5).map((t, idx) => `${idx + 1}. [${t.title}](${t.url})`).join('\n'),
        });
      }
      await channel.send({ embeds: [embed] });
    } catch (err) {
      log.tag('MUSIC').warn(`Failed to announce track in guild=${guild.id}:`, err?.stack || err);
    }
  };

  const cleanup = () => {
    subscription.off('trackStart', handler);
    subscription.off('destroyed', cleanup);
    subscription.__musicAnnouncementBound = false;
  };

  subscription.on('trackStart', handler);
  subscription.once('destroyed', cleanup);
  subscription.__musicAnnouncementBound = true;
}

/**
 * Ensures the invoking member is in a voice channel and that the bot has permission to join. The
 * returned subscription represents the active audio connection.
 */
async function ensureMemberSubscription(interaction) {
  if (!interaction.guild) {
    throw new Error('This command can only be used in a server.');
  }

  const guild = interaction.guild;
  const member = interaction.member ?? await guild.members.fetch(interaction.user.id);
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    throw new Error('Join a voice channel first.');
  }

  const me = guild.members.me ?? await guild.members.fetch(interaction.client.user.id);
  const perms = voiceChannel.permissionsFor(me);
  if (!perms || !perms.has(PermissionsBitField.Flags.Connect) || !perms.has(PermissionsBitField.Flags.Speak)) {
    throw new Error(`I need the **Connect** and **Speak** permissions in ${voiceChannel}.`);
  }

  const { subscription, isNew } = await ensureGuildSubscription(guild, voiceChannel);
  attachAnnouncements(subscription, guild);
  return { subscription, voiceChannel, isNew };
}

/**
 * Implements `/music join`. The command connects the bot to the caller's voice channel or confirms
 * that it is already present.
 */
async function handleJoin(interaction) {
  try {
    const { subscription, voiceChannel, isNew } = await ensureMemberSubscription(interaction);
    const already = !isNew && subscription.voiceChannelId === voiceChannel.id;
    const content = already
      ? `🔊 I’m already in ${voiceChannel}.`
      : `✅ Joined ${voiceChannel}.`;
    await interaction.reply({ content });
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message || err}`, ephemeral: true });
  }
}

/**
 * Implements `/music play`. Resolves the provided query into a playable track and enqueues it.
 */
async function handlePlay(interaction) {
  const query = interaction.options.getString('query', true);
  let context;
  try {
    context = await ensureMemberSubscription(interaction);
  } catch (err) {
    return interaction.reply({ content: `❌ ${err.message || err}`, ephemeral: true });
  }

  await interaction.deferReply();

  try {
    const track = await resolveTrack(query, interaction.user);
    await context.subscription.enqueue(track);
    await interaction.editReply(`▶️ Queued **${track.title}** (${formatDuration(track.durationMs)})`);
  } catch (err) {
    log.tag('MUSIC').warn(`Failed to queue track in guild=${interaction.guildId}:`, err?.stack || err);
    await interaction.editReply(`❌ ${err.message || 'Failed to queue that track.'}`);
  }
}

/**
 * Implements `/music skip` by skipping the current track if one is active.
 */
async function handleSkip(interaction) {
  const sub = getSubscription(interaction.guildId);
  if (!sub || !sub.current) {
    return interaction.reply({ content: 'There is nothing playing right now.', ephemeral: true });
  }
  const skipped = sub.skip();
  await interaction.reply({ content: skipped ? '⏭️ Skipping the current track…' : 'I was not playing anything.' });
}

/**
 * Implements `/music queue`. Displays the current and upcoming tracks to the user.
 */
async function handleQueue(interaction) {
  const sub = getSubscription(interaction.guildId);
  if (!sub || (!sub.current && sub.queue.length === 0)) {
    return interaction.reply({ content: 'The queue is currently empty.', ephemeral: true });
  }

  const { current, upcoming } = sub.getQueue();
  const embed = new EmbedBuilder()
    .setTitle('Music Queue')
    .setColor(0x5865f2)
    .setTimestamp(new Date());

  if (current) {
    embed.addFields({
      name: 'Now Playing',
      value: `[${current.title}](${current.url}) • ${formatDuration(current.durationMs)} • Requested by ${current.requestedById ? `<@${current.requestedById}>` : current.requestedByTag || 'Unknown'}`,
    });
  }

  if (upcoming.length) {
    const lines = upcoming.slice(0, 10).map((track, idx) => `${idx + 1}. [${track.title}](${track.url}) • ${formatDuration(track.durationMs)}`);
    embed.addFields({ name: 'Up Next', value: lines.join('\n') });
    if (upcoming.length > 10) {
      embed.setFooter({ text: `${upcoming.length} tracks in queue` });
    }
  }

  await interaction.reply({ embeds: [embed] });
}

/**
 * Implements `/music leave`. Disconnects the audio player and clears the queue.
 */
async function handleLeave(interaction) {
  const destroyed = destroySubscription(interaction.guildId);
  if (destroyed) {
    await interaction.reply({ content: '👋 Disconnected and cleared the queue.' });
  } else {
    await interaction.reply({ content: 'I am not connected to a voice channel.', ephemeral: true });
  }
}

/**
 * Dispatches music subcommands. The outer slash command handler in `commands.js` forwards requests
 * here.
 */
async function handleMusicCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'join':
      await handleJoin(interaction);
      break;
    case 'play':
      await handlePlay(interaction);
      break;
    case 'skip':
      await handleSkip(interaction);
      break;
    case 'queue':
      await handleQueue(interaction);
      break;
    case 'leave':
      await handleLeave(interaction);
      break;
    default:
      await interaction.reply({ content: 'Unknown music subcommand.', ephemeral: true });
  }
}

module.exports = {
  handleMusicCommand,
};
