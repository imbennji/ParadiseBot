/**
 * Aggregated slash command registry that pulls in domain-specific builders and handlers.
 * This file wires registration and dispatch while individual modules own their command logic.
 */
const { REST, Routes } = require('discord.js');
const { log, time } = require('../../logger');
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DEV_GUILD_ID,
} = require('../../config');

const domains = [
  require('./steam'),
  require('./moderation'),
  require('./music'),
  require('./xp'),
];

const commandBuilders = domains.flatMap(domain => domain.builders);
const commandHandlers = Object.assign({}, ...domains.map(domain => domain.handlers));

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommandsOnStartup() {
  const t = time('CMD:register');
  const payload = commandBuilders.map(c => c.toJSON());
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  async function putWithRetry(label, route, body) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await rest.put(route, { body });
        log
          .tag('CMD')
          .info(`${label}${attempt > 1 ? ` after ${attempt} attempts` : ''}.`);
        return;
      } catch (err) {
        const resp = err?.rawError || err?.response?.data || err?.message || err;
        log.tag('CMD').error(`${label} attempt ${attempt} failed:`, resp);
        if (attempt < 3) await sleep(1000 * attempt);
      }
    }
  }

  try {
    if (DEV_GUILD_ID) {
      const route = Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DEV_GUILD_ID);
      log.tag('CMD').info('Clearing guild commands before registration.');
      await putWithRetry('Guild command purge', route, []);
      log.tag('CMD').info(`Registering ${payload.length} commands → guild ${DEV_GUILD_ID}`);
      await putWithRetry('Guild commands registered', route, payload);
      log.tag('CMD').info('DEV_GUILD_ID set; skipping global registration to avoid duplicate commands.');
    } else {
      const route = Routes.applicationCommands(DISCORD_CLIENT_ID);
      log.tag('CMD').info('Clearing global commands before registration.');
      await putWithRetry('Global command purge', route, []);
      log.tag('CMD').info(`Registering ${payload.length} commands → GLOBAL`);
      await putWithRetry('Global commands registered', route, payload);
    }
  } catch (err) {
    log.tag('CMD').error('Registration failed:', err?.stack || err);
  } finally { t.end(); }
}

async function handleChatCommand(interaction) {
  const handler = commandHandlers[interaction.commandName];
  if (!handler) return;
  await handler(interaction);
}

module.exports = {
  commandBuilders,
  registerCommandsOnStartup,
  handleChatCommand,
};
