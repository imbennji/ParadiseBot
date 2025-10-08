// file: github-announcer.js
/**
 * Discord GitHub Announcer Bot
 *
 * Polls a GitHub repository for new commits and posts rich embeds to a
 * configured Discord channel. Designed for hosted/bare-metal environments
 * where GitHub webhooks are not available.
 *
 * Requirements:
 *  - Node.js 18+
 *  - npm i discord.js axios dotenv
 *  - .env (or process env vars) containing the variables listed below
 *
 * Environment variables:
 *  DISCORD_TOKEN           - Discord bot token
 *  DISCORD_CHANNEL_ID      - Snowflake of the channel that should receive commit embeds
 *  GITHUB_OWNER            - Repository owner/org
 *  GITHUB_REPO             - Repository name
 *  GITHUB_BRANCH           - Optional. Branch to monitor (default: default branch)
 *  GITHUB_TOKEN            - Optional. Personal access token for higher rate limits
 *  POLL_INTERVAL_SECONDS   - Optional. How often to poll for commits (default: 60)
 *  ANNOUNCE_ON_START       - Optional. If "true", announce the most recent commits on boot
 *  STATE_FILE              - Optional. Path to persist the last announced commit SHA
 */

require('dotenv').config();

const { Client, GatewayIntentBits, Events, EmbedBuilder, time: discordTime } = require('discord.js');
const axios = require('axios').default;
const fs = require('fs/promises');
const path = require('path');

/* =========================
 * Configuration helpers
 * ========================= */
const cfg = {
  discordToken: process.env.DISCORD_TOKEN,
  discordChannelId: process.env.DISCORD_CHANNEL_ID,
  githubOwner: process.env.GITHUB_OWNER,
  githubRepo: process.env.GITHUB_REPO,
  githubBranch: process.env.GITHUB_BRANCH || undefined,
  githubToken: process.env.GITHUB_TOKEN || undefined,
  pollIntervalMs: Math.max(30, parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10)) * 1000,
  announceOnStart: (process.env.ANNOUNCE_ON_START || 'false').toLowerCase() === 'true',
  stateFile: process.env.STATE_FILE || path.join(__dirname, '.github-announcer-state.json'),
};

for (const [key, value] of Object.entries({
  DISCORD_TOKEN: cfg.discordToken,
  DISCORD_CHANNEL_ID: cfg.discordChannelId,
  GITHUB_OWNER: cfg.githubOwner,
  GITHUB_REPO: cfg.githubRepo,
})) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

/* =========================
 * Persistent state management
 * ========================= */
class StateStore {
  constructor(file) {
    this.file = file;
    this.state = { lastSha: null };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && typeof json.lastSha === 'string') {
        this.state.lastSha = json.lastSha;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[State] Failed to read state file: ${err.message}`);
      }
    }
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[State] Failed to persist state: ${err.message}`);
    }
  }

  get lastSha() {
    return this.state.lastSha || null;
  }

  async setLastSha(sha) {
    this.state.lastSha = sha || null;
    await this.save();
  }
}

const store = new StateStore(cfg.stateFile);

/* =========================
 * GitHub client helpers
 * ========================= */
const github = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'User-Agent': 'ParadiseBot-GitHubAnnouncer/1.0',
    Accept: 'application/vnd.github+json',
    ...(cfg.githubToken ? { Authorization: `Bearer ${cfg.githubToken}` } : {}),
  },
  timeout: 10_000,
});

async function fetchLatestCommits(limit = 10) {
  const params = new URLSearchParams({ per_page: String(limit) });
  if (cfg.githubBranch) params.set('sha', cfg.githubBranch);
  const { data } = await github.get(`/repos/${cfg.githubOwner}/${cfg.githubRepo}/commits?${params.toString()}`);
  return Array.isArray(data) ? data : [];
}

async function fetchCommitDetail(sha) {
  const { data } = await github.get(`/repos/${cfg.githubOwner}/${cfg.githubRepo}/commits/${sha}`);
  return data;
}

function shortSha(sha) {
  return sha ? sha.substring(0, 7) : '';
}

function firstLine(text) {
  if (!text) return 'No commit message';
  return String(text).split(/\r?\n/, 1)[0];
}

function summarizeFiles(files = []) {
  if (!Array.isArray(files) || files.length === 0) return 'No file changes listed.';
  const snippets = files.slice(0, 5).map((file) => {
    const indicator = file.status === 'removed' ? '➖' : file.status === 'added' ? '➕' : '✏️';
    return `${indicator} ${file.filename}`;
  });
  if (files.length > 5) snippets.push(`…and ${files.length - 5} more`);
  return snippets.join('\n');
}

function buildEmbed(detail) {
  const commit = detail.commit;
  const author = commit?.author || {};
  const stats = detail.stats || {};
  const commitDate = commit?.author?.date || commit?.committer?.date || null;
  const embed = new EmbedBuilder()
    .setColor(0x24292e)
    .setTitle(`${firstLine(commit?.message)} (${shortSha(detail.sha)})`)
    .setURL(detail.html_url)
    .setDescription(commit?.message || '—');

  embed.setTimestamp(commitDate ? new Date(commitDate) : new Date());

  if (author.name) embed.addFields({ name: 'Author', value: author.name, inline: true });
  if (commitDate) embed.addFields({ name: 'Committed', value: discordTime(new Date(commitDate), 'R'), inline: true });
  embed.addFields(
    { name: 'Additions', value: String(stats.additions ?? 0), inline: true },
    { name: 'Deletions', value: String(stats.deletions ?? 0), inline: true },
    { name: 'Files Changed', value: String(stats.total ?? detail.files?.length ?? 0), inline: true },
  );

  const summary = summarizeFiles(detail.files);
  if (summary) embed.addFields({ name: 'Files', value: summary });

  if (detail.author?.avatar_url) embed.setThumbnail(detail.author.avatar_url);

  return embed;
}

/* =========================
 * Discord client and poller
 * ========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let pollTimer = null;
let shuttingDown = false;

async function announceCommits(channel, commits) {
  for (const commit of commits) {
    try {
      const detail = await fetchCommitDetail(commit.sha);
      const embed = buildEmbed(detail);
      await channel.send({ embeds: [embed] });
      await store.setLastSha(detail.sha);
      console.log(`[Announcer] Posted ${shortSha(detail.sha)} to ${channel.id}`);
    } catch (err) {
      console.error(`[Announcer] Failed to announce commit ${commit.sha}:`, err.message);
    }
  }
}

async function poll(channel) {
  if (shuttingDown) return;
  try {
    const commits = await fetchLatestCommits();
    if (!commits.length) return;

    const newestSha = commits[0].sha;
    if (!store.lastSha) {
      if (cfg.announceOnStart) {
        await announceCommits(channel, [...commits].reverse());
      }
      await store.setLastSha(newestSha);
      return;
    }

    if (store.lastSha === newestSha) return;

    const fresh = [];
    for (const commit of commits) {
      if (commit.sha === store.lastSha) break;
      fresh.push(commit);
    }
    if (fresh.length) {
      await announceCommits(channel, fresh.reverse());
      await store.setLastSha(newestSha);
    }
  } catch (err) {
    console.error('[Poller] Failed to fetch commits:', err.message);
  }
}

function schedulePoll(channel) {
  pollTimer = setTimeout(async () => {
    await poll(channel);
    schedulePoll(channel);
  }, cfg.pollIntervalMs);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Discord] Logged in as ${readyClient.user.tag}`);
  await store.load();

  try {
    const channel = await readyClient.channels.fetch(cfg.discordChannelId);
    if (!channel?.isTextBased?.()) {
      throw new Error('Configured channel is not text-based or accessible');
    }

    await poll(channel);
    schedulePoll(channel);
  } catch (err) {
    console.error('[Discord] Failed to start announcer:', err.message);
    await client.destroy();
    process.exit(1);
  }
});

client.on('error', (err) => console.error('[Discord] Client error:', err));
client.on('shardError', (err) => console.error('[Discord] Shard error:', err));

function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Process] Received ${signal}, shutting down…`);
  if (pollTimer) clearTimeout(pollTimer);
  client.destroy().finally(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => handleShutdown(signal));
}

client.login(cfg.discordToken).catch((err) => {
  console.error('[Discord] Login failed:', err.message);
  process.exit(1);
});

