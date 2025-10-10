# Adding a Music Player

This guide explains how to bolt a guild-scoped music player onto the existing Paradise bot codebase. It highlights the moving pieces in the current repo, shows where to plug in new slash commands, and sketches the voice connection lifecycle that Discord requires. The implementation described here now lives under `src/music` with reusable helpers for commands, queue management, and source resolution.

## 1. Install voice dependencies

Paradise already requests the `GuildVoiceStates` intent, so you only need playback helpers. Add the official voice stack and an Opus encoder:

```bash
npm install @discordjs/voice play-dl prism-media
```

- `@discordjs/voice` handles joins, audio resources, and dispatcher state.
- `play-dl` finds and demuxes streams from YouTube/Spotify/SoundCloud without API keys.
- `prism-media` exposes a native Opus encoder when system libraries exist; it falls back to JS if needed.

Ship these modules with your deployment so `npm ci` in production stays deterministic.

## 2. Extend the slash-command registry

New chat commands have to be added to the shared `commandBuilders` array. Follow the existing patterns around validation, permission checks, and subcommands:

1. Import the helpers you need at the top of `src/discord/commands.js` (for example, your music queue module).
2. Push builders for `/music join`, `/music play`, `/music skip`, `/music queue`, and `/music leave` into the array that starts around line 33.【F:src/discord/commands.js†L1-L120】
3. Wire the handlers inside `handleChatCommand` by switching on `interaction.commandName` and `interaction.options.getSubcommand()`. The handler currently resolves Steam utilities, leaderboard bootstrap, moderation tools, and XP queries in one place, so mirror that structure when calling into your new module.【F:src/discord/commands.js†L200-L430】
4. Keep `setDMPermission(false)` because voice playback only works in guilds.

After editing the builder list, restart the bot (or run `node index.js`) so the global registration call in `registerCommandsOnStartup` pushes the new definitions to Discord.【F:src/discord/commands.js†L432-L510】 During development set `DEV_GUILD_ID` to avoid the 1-hour global cache.

## 3. Build a dedicated music module

Create a folder such as `src/music` with three collaborators (Paradise ships this structure by default):

- `player.js`: wraps `@discordjs/voice` to manage a per-guild `VoiceConnection`, `AudioPlayer`, queue array, and state transitions.
- `sources.js`: resolves URLs/search terms through `play-dl` and normalises metadata.
- `commands.js`: exposes functions like `handleJoin`, `handlePlay`, etc., called from the global command router.

Use a `Map` keyed by guild ID to cache the queue + player state. Example skeleton:

```js
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, VoiceConnectionStatus } = require('@discordjs/voice');

const players = new Map();

function getOrCreatePlayer(interaction) {
  // join voice channel, subscribe, return queue helpers
}

async function enqueue(interaction, query) {
  const player = await getOrCreatePlayer(interaction);
  const track = await resolveTrack(query); // call play-dl
  player.queue.push(track);
  if (!player.current) player.playNext();
  return track;
}

module.exports = { enqueue, skip, showQueue, leave };
```

Listen for dispatcher state changes (`AudioPlayerStatus.Idle`) to automatically advance the queue, and tear down idle connections with a timeout to avoid ghost sessions.

## 4. Update interaction handling

Inside `handleChatCommand`, branch into your music module. For example:

```js
case 'music': {
  const sub = interaction.options.getSubcommand();
  if (sub === 'play') {
    const query = interaction.options.getString('query', true);
    const track = await music.enqueue(interaction, query);
    return interaction.reply({ content: `▶️ Queued **${track.title}**`, ephemeral: false });
  }
  // handle other subcommands...
}
```

Remember to defer replies when lookups may take >3 seconds, and send ephemeral errors for permission problems so staff see debugging context without spamming the channel.

## 5. Respect permits and moderation

The bot currently removes links from non-permitted members inside the `MessageCreate` listener.【F:index.js†L156-L193】 Because most music queues rely on URLs, keep the workflow slash-command-only so messages never include raw links. Validate that the invoker is in a voice channel, and optionally restrict playback to staff by checking `hasBotPerms` or a role gate.

## 6. Persistence (optional)

If you want queues to survive restarts, reuse the MySQL helpers under `src/db.js` and `dbRun/dbGet`. The schema migrator already runs during boot before the Discord login.【F:index.js†L195-L205】 A simple `music_queues` table keyed by guild can store JSON blobs, but remember to prune expired tracks.

## 7. Testing checklist

1. Run `npm test` or your linter suite if you add one.
2. Invite the bot to a staging guild with `GuildVoiceStates` enabled (already requested in `src/discord/client.js`).【F:src/discord/client.js†L1-L12】
3. Verify `/music join` joins the caller’s voice channel, `/music play` streams audio, `/music skip` advances, `/music queue` prints upcoming tracks, and `/music leave` disconnects.

Following these steps keeps the new feature aligned with the project’s structure while leveraging Discord’s maintained voice stack instead of ad-hoc ffmpeg calls.
