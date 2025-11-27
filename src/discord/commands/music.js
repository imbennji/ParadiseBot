/**
 * Music playback slash commands that delegate to the shared music command router.
 * Builders live alongside the dispatcher glue so Discord registration stays localized.
 */
const { SlashCommandBuilder } = require('discord.js');
const { handleMusicCommand } = require('../../music/commands');

const musicBuilders = [
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
];

const musicHandlers = {
  music: handleMusicCommand,
};

module.exports = {
  builders: musicBuilders,
  handlers: musicHandlers,
};
