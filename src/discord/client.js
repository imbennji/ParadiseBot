/**
 * Shared Discord.js client configured with the intents and partials required by the rest of the
 * application. Exporting a singleton ensures every feature operates on the same gateway connection
 * and avoids the complexity of juggling multiple shards or reconnect logic.
 */
const { Client, GatewayIntentBits, Partials } = require('discord.js');

/**
 * Lazily instantiated Discord client. We only request the intents required for the features we
 * support which keeps the bot compliant with Discord's privileged intent policy and reduces the
 * amount of traffic delivered to the process.
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel],
});

module.exports = { client };
