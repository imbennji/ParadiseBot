const { EmbedBuilder, time: discordTime } = require('discord.js');
const axios = require('axios').default;
const { log, time } = require('../logger');
const { client } = require('../discord/client');
const { dbAll, dbGet, dbRun } = require('../db');
const { CHANNEL_KINDS, hasBotPerms } = require('../discord/channels');
const {
  GITHUB_ANNOUNCER_ENABLED,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GITHUB_TOKEN,
  GITHUB_POLL_MS,
  GITHUB_ANNOUNCE_ON_START,
  GITHUB_MAX_CATCHUP,
  GITHUB_EMBED_COLOR,
} = require('../config');

function deriveRepoSlug(owner, repo) {
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const trimmedOwner = trim(owner);
  const trimmedRepo = trim(repo);

  if (!trimmedOwner && !trimmedRepo) return null;

  const extractSlug = (input) => {
    if (!input) return null;
    const cleaned = String(input).trim();
    if (!cleaned) return null;

    const urlMatch = cleaned.match(/github\.com[:/]+(.+)/i);
    if (urlMatch && urlMatch[1]) {
      const slug = urlMatch[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
      if (slug.includes('/')) return slug;
    }

    if (cleaned.includes('/')) {
      const slug = cleaned.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
      if (slug.includes('/')) return slug;
    }

    return null;
  };

  const slugFromRepo = extractSlug(trimmedRepo);
  if (slugFromRepo) return slugFromRepo;

  if (trimmedOwner && trimmedRepo) {
    return `${trimmedOwner}/${trimmedRepo.replace(/\.git$/i, '')}`;
  }

  return null;
}

const repoSlug = deriveRepoSlug(GITHUB_OWNER, GITHUB_REPO);
const github = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    'User-Agent': 'ParadiseBot-GitHubAnnouncer/1.0',
    Accept: 'application/vnd.github+json',
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  },
  timeout: 10_000,
});

async function fetchLatestCommits(limit = 10) {
  const params = new URLSearchParams({ per_page: String(limit) });
  if (GITHUB_BRANCH) params.set('sha', GITHUB_BRANCH);
  const { data } = await github.get(`/repos/${repoSlug}/commits?${params.toString()}`);
  return Array.isArray(data) ? data : [];
}

async function fetchCommitDetail(sha) {
  const { data } = await github.get(`/repos/${repoSlug}/commits/${sha}`);
  return data;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

function firstLine(text) {
  if (!text) return 'No commit message';
  return String(text).split(/\r?\n/, 1)[0];
}

function formatCommitMessage(message) {
  if (!message) return null;
  const cleaned = String(message).replace(/\r\n/g, '\n').trim();
  if (!cleaned) return null;
  if (cleaned.length <= 1024) return cleaned;
  return `${cleaned.slice(0, 1021)}…`;
}

function buildEmbed(detail) {
  const commit = detail.commit || {};
  const author = commit.author || {};
  const commitDate = commit?.author?.date || commit?.committer?.date || null;
  const embed = new EmbedBuilder()
    .setColor(GITHUB_EMBED_COLOR)
    .setTitle(firstLine(commit.message))
    .setURL(detail.html_url)
    .setTimestamp(commitDate ? new Date(commitDate) : new Date());

  if (repoSlug) {
    embed.setAuthor({ name: repoSlug, url: `https://github.com/${repoSlug}` });
  }

  const descriptionParts = [];

  const shaLink = detail.html_url ? `[${shortSha(detail.sha)}](${detail.html_url})` : shortSha(detail.sha);
  if (shaLink) descriptionParts.push(shaLink);

  if (commitDate) descriptionParts.push(discordTime(new Date(commitDate), 'R'));

  const displayAuthor = detail.author?.login || author.name || author.email || null;
  if (displayAuthor) {
    const authorLink = detail.author?.html_url ? `[${displayAuthor}](${detail.author.html_url})` : displayAuthor;
    descriptionParts.push(`by ${authorLink}`);
  }

  if (descriptionParts.length) {
    embed.setDescription(descriptionParts.join(' • '));
  }

  if (detail.author?.avatar_url) embed.setThumbnail(detail.author.avatar_url);

  const messageBody = formatCommitMessage(commit.message);
  if (messageBody) {
    embed.addFields({ name: 'Message', value: messageBody });
  }

  embed.setFooter({ text: 'GitHub' });
  return embed;
}

async function loadLastSha() {
  if (!repoSlug) return null;
  const row = await dbGet('SELECT last_sha FROM github_announcements WHERE repo=?', [repoSlug]);
  return row?.last_sha || null;
}

async function saveLastSha(sha) {
  if (!repoSlug || !sha) return;
  await dbRun(
    'INSERT INTO github_announcements (repo, last_sha, announced_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_sha=VALUES(last_sha), announced_at=VALUES(announced_at)',
    [repoSlug, sha, Math.floor(Date.now() / 1000)],
  );
}

async function resolveGithubChannels() {
  const rows = await dbAll('SELECT guild_id, channel_id FROM guild_channels WHERE kind=?', [CHANNEL_KINDS.GITHUB]);
  if (!rows.length) return [];

  const channels = [];
  for (const row of rows) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) {
      log.tag('GITHUB').warn(`Guild missing from cache: ${row.guild_id}`);
      continue;
    }
    let channel = guild.channels.cache.get(row.channel_id);
    if (!channel) {
      channel = await guild.channels.fetch(row.channel_id).catch(() => null);
    }
    if (!channel) {
      log.tag('GITHUB').warn(`Channel ${row.channel_id} missing in guild=${guild.id}`);
      continue;
    }
    const perms = hasBotPerms(channel);
    if (!perms.ok) {
      log.tag('GITHUB').warn(`Missing perms in channel=${channel.id} guild=${guild.id}`);
      continue;
    }
    channels.push({ guildId: guild.id, channel });
  }
  return channels;
}

async function announceCommits(commits, targets) {
  if (!targets.length) return;

  for (const commit of commits) {
    try {
      const detail = await fetchCommitDetail(commit.sha);
      const embed = buildEmbed(detail);
      await Promise.all(targets.map(({ channel, guildId }) =>
        channel.send({ embeds: [embed] }).catch((err) => {
          log.tag('GITHUB').error(`Failed to send commit ${shortSha(commit.sha)} to guild=${guildId}: ${err?.message || err}`);
        })
      ));
      await saveLastSha(detail.sha);
      log.tag('GITHUB').info(`Announced commit ${shortSha(detail.sha)} to ${targets.length} channels`);
    } catch (err) {
      log.tag('GITHUB').error(`Failed to announce commit ${commit.sha}: ${err?.message || err}`);
    }
  }
}

async function handlePushWebhook(payload) {
  if (!GITHUB_ANNOUNCER_ENABLED) {
    log.tag('GITHUB').debug('Ignoring GitHub webhook because announcer is disabled.');
    return;
  }
  if (!repoSlug) {
    log.tag('GITHUB').warn('Received GitHub webhook but repository is not configured.');
    return;
  }
  if (!payload || typeof payload !== 'object') {
    log.tag('GITHUB').warn('Received empty GitHub webhook payload.');
    return;
  }

  const repoName = payload.repository?.full_name;
  if (repoName && repoName.toLowerCase() !== repoSlug.toLowerCase()) {
    log.tag('GITHUB').debug(`Ignoring webhook for repo=${repoName}; configured repo=${repoSlug}.`);
    return;
  }

  if (GITHUB_BRANCH) {
    const expectedRef = `refs/heads/${GITHUB_BRANCH}`;
    if (payload.ref && payload.ref !== expectedRef) {
      log.tag('GITHUB').debug(`Ignoring webhook for ref=${payload.ref}; expected ${expectedRef}.`);
      return;
    }
  }

  const rawCommits = Array.isArray(payload.commits) ? payload.commits : [];
  if (!rawCommits.length) {
    log.tag('GITHUB').info('GitHub webhook received with no commits to announce.');
    return;
  }

  const commits = rawCommits
    .slice()
    .sort((a, b) => {
      const at = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
      const bt = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
      return at - bt;
    })
    .map((commit) => ({ sha: commit.id || commit.sha || null }))
    .filter((commit) => typeof commit.sha === 'string' && commit.sha.length);

  if (!commits.length) {
    log.tag('GITHUB').warn('GitHub webhook commits missing SHA identifiers; nothing to announce.');
    return;
  }

  const targets = await resolveGithubChannels();
  if (!targets.length) {
    log.tag('GITHUB').debug('GitHub webhook received but no Discord channels are configured.');
    return;
  }

  await announceCommits(commits, targets);
}

async function pollGithub() {
  const t = time('POLL:github');
  try {
    const targets = await resolveGithubChannels();
    if (!targets.length) return;

    const commits = await fetchLatestCommits(Math.max(GITHUB_MAX_CATCHUP, 5));
    if (!commits.length) return;

    const lastSha = await loadLastSha();
    const newCommits = [];
    for (const commit of commits) {
      if (lastSha && commit.sha === lastSha) break;
      newCommits.push(commit);
    }

    if (!lastSha && !GITHUB_ANNOUNCE_ON_START) {
      await saveLastSha(commits[0].sha);
      log.tag('GITHUB').info('Stored latest commit without announcing (announce_on_start disabled).');
      return;
    }

    if (!newCommits.length) return;

    const toAnnounce = newCommits.slice(-GITHUB_MAX_CATCHUP).reverse();
    await announceCommits(toAnnounce, targets);
  } catch (err) {
    log.tag('GITHUB').error('pollGithub failed:', err?.message || err);
  } finally {
    t.end();
  }
}

function scheduleGithubLoop(runNow = false) {
  if (!GITHUB_ANNOUNCER_ENABLED) {
    log.tag('GITHUB').info('GitHub announcer disabled via config.');
    return;
  }
  if (!repoSlug) {
    log.tag('GITHUB').warn('GitHub announcer enabled but GITHUB_OWNER/GITHUB_REPO not set.');
    return;
  }

  const run = async () => {
    try { await pollGithub(); }
    catch (err) { log.tag('GITHUB').error('pollGithub errored:', err?.stack || err); }
    finally { setTimeout(run, GITHUB_POLL_MS); };
  };

  log.tag('GITHUB').info(`GitHub announcer watching ${repoSlug} every ${Math.round(GITHUB_POLL_MS / 1000)}s`);
  if (runNow) {
    run();
  } else {
    setTimeout(run, GITHUB_POLL_MS);
  }
}

module.exports = { scheduleGithubLoop, handlePushWebhook };
