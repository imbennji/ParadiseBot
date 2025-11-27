/**
 * XP and social commands: lightweight stats surfaces built on the XP subsystem.
 * Keep replies concise so they remain chat-friendly without extra embeds.
 */
const { SlashCommandBuilder } = require('discord.js');
const { getRankStats } = require('../xp');

const xpBuilders = [
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

const xpHandlers = {
  rank: handleRank,
};

module.exports = {
  builders: xpBuilders,
  handlers: xpHandlers,
};
