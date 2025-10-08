# Paradise Discord Bot

Private automation bot for the Paradise Discord server. It connects member Steam accounts, announces activity from Steam, keeps long-lived leaderboards, tracks sales, and adds a layer of moderation tools, XP progression, and logging built around how we run the community.

> **License:** Private / proprietary – do not redistribute. See [License](#-license) for details.

---

## ✨ What it does

### Steam integration
- **Account linking (`/linksteam`)** ties Discord users to Steam IDs with duplicate-account locks.
- **Achievement feed** posts unlocked achievements, rarity call-outs, and milestone summaries using cached Steam schemas.
- **Library tracking** detects newly purchased / removed games with batching, icon thumbnails, and grace periods for removals.
- **Now playing + session recaps** announces when a run starts (after a confirmation delay) and posts a wrap-up once the player goes idle for long enough.
- **Steam leaderboards** maintains a single embed with lifetime playtime, 2-week playtime, total achievements, and 30-day new-game counts.
- **Steam sales board** maintains a permanent, button-driven embed for discounted titles with cached search results and background warmers.

### Discord-side automation
- **Slash command suite** for Paradise staff: `/setchannel`, `/leaderboard init`, `/sales init`, `/permit`, `/kick`, `/ban`, `/timeout`, `/purge`, `/clearchat`, `/warn`.
- **XP system** awards message XP (with cooldowns) and announces level-ups in a configurable channel (`/rank` exposes stats).
- **Content moderation** autodeletes slurs / hate speech using a normalized term list (extend via `MODERATION_BANNED_TERMS`).
- **Link permits** automatically delete non-staff links unless a timed permit is granted (`/permit`).
- **Audit logging** captures joins/leaves, message deletes/edits, bans/unbans, channel updates, and more into a configured log channel.
- **GitHub commit announcements** poll a repository or receive GitHub webhooks for new commits and post embeds into a configured `/setchannel type:github_commits` target.

### Reliability & data
- **MySQL 8+** persistence with automatic table creation & column migrations on boot.
- **Configurable polling** loops for Steam APIs with concurrency limits and seeding/backfill guards to avoid spam on first run.
- **Structured logging** (per-tag) with optional HTTP/SQL tracing.

---

## 🧰 Requirements
- Node.js 18+ (20+ recommended).
- MySQL 8+ reachable from where the bot runs.
- Steam Web API key.
- Discord application with a bot token and permission to manage slash commands in your guild.

---

## 🚀 Setup
1. **Clone & install**
   ```bash
   npm install
   ```
2. **Copy the environment template**
   ```bash
   cp example.env .env
   ```
   Fill in Discord, Steam, and database credentials plus any tuning overrides (see below).
3. **Provision MySQL** (example)
   ```sql
   CREATE DATABASE paradise_bot CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
   GRANT ALL ON paradise_bot.* TO 'paradise'@'%' IDENTIFIED BY 'supersecret';
   FLUSH PRIVILEGES;
   ```
   Update `DB_NAME`, `DB_USER`, `DB_PASS`, and `DB_HOST` in `.env` to match.
4. **Run locally**
   ```bash
   node index.js
   ```
   Set `DEV_GUILD_ID` during development for instant command registration.
5. **Deploy** using a process manager (systemd, PM2, Docker, etc.) that loads the same `.env` values and restarts on crash.

---

## ⚙️ Environment flags
All configuration lives in `.env`. The `example.env` file documents every supported option. Highlights:

| Area | Key flags | Possible values / format |
| --- | --- | --- |
| Discord auth | `DISCORD_TOKEN`<br>`DISCORD_CLIENT_ID`<br>`DEV_GUILD_ID` | Discord bot token string.<br>Discord application (client) ID snowflake.<br>Optional guild snowflake for dev-only command registration. |
| Database | `DB_HOST`<br>`DB_PORT`<br>`DB_USER`<br>`DB_PASS`<br>`DB_NAME` | Hostname or IP (e.g., `127.0.0.1`).<br>Port number (default `3306`).<br>Database username.<br>Database password.<br>Database/schema name. |
| Steam polling | `POLL_SECONDS`<br>`OWNED_POLL_SECONDS`<br>`NOWPLAYING_POLL_SECONDS`<br>`LEADERBOARD_POLL_SECONDS`<br>`SALES_POLL_SECONDS`<br>`MAX_CONCURRENCY` | Integer seconds between polls (defaults: `300`, `3600`, `120`, `300`, `86400`).<br>Maximum concurrent Steam API calls (integer, default `4`). |
| Sales board | `SALES_SORT_BY`<br>`SALES_REGION_CC`<br>`SALES_PAGE_SIZE`<br>`SALES_PAGE_TTL_MS`<br>`SALES_EXTEND_TTL_ON_HIT`<br>`SALES_PRECACHE_PAGES`<br>`SALES_PRECACHE_PREV_PAGES`<br>`SALES_PREWARM_SPACING_MS`<br>`SALES_FULL_WARMER_ENABLED`<br>`SALES_FULL_WARMER_DELAY_MS`<br>`SALES_FULL_WARMER_SPACING_MS`<br>`SALES_MAX_PAGES_CACHE` | Steam sort key (e.g., `Discount_DESC`).<br>ISO 3166-1 alpha-2 country code (e.g., `US`).<br>Results per page (integer, default `10`).<br>Cache TTL in milliseconds (default `1200000`).<br>`true`/`false` toggle for TTL extension.<br>Number of future pages to cache (integer, default `3`).<br>Number of previous pages to cache (integer, default `1`).<br>Delay between prewarm requests in ms (integer, default `200`).<br>`true`/`false` toggle to warm every page.<br>Delay before full warmer in ms (integer, default `15000`).<br>Spacing between full warmer requests in ms (integer, default `1200`).<br>Maximum cached pages (integer, default `600`). |
| GitHub announcer | `GITHUB_ANNOUNCER_ENABLED`<br>`GITHUB_OWNER`<br>`GITHUB_REPO`<br>`GITHUB_BRANCH`<br>`GITHUB_TOKEN`<br>`GITHUB_POLL_SECONDS`<br>`GITHUB_MAX_CATCHUP`<br>`GITHUB_ANNOUNCE_ON_START`<br>`GITHUB_EMBED_COLOR`<br>`GITHUB_WEBHOOK_ENABLED`<br>`GITHUB_WEBHOOK_PORT`<br>`GITHUB_WEBHOOK_PATH`<br>`GITHUB_WEBHOOK_SECRET` | `true`/`false` toggle.<br>Repository owner/org name.<br>Repository name.<br>Branch name (e.g., `main`).<br>GitHub token (optional, supports fine-grained PATs).<br>Integer seconds between polls (default `60`).<br>Maximum missed commits to announce per poll (integer, default `5`).<br>`true`/`false` toggle to post immediately on boot.<br>Hex color string (e.g., `#24292E`).<br>`true`/`false` to run the built-in webhook listener.<br>TCP port for the webhook HTTP server.<br>Path component for the webhook endpoint (default `/github-webhook`).<br>Optional shared secret used to verify `x-hub-signature-256`. |
| Milestones & rarity | `PLAYTIME_MARKS`<br>`ACHIEVEMENT_MARKS`<br>`RARE_PCT`<br>`RARITY_TTL_HOURS` | Comma-separated minute thresholds (e.g., `10,25,50,100`).<br>Comma-separated achievement counts (e.g., `25,50,75,100`).<br>Percent threshold for rarity callouts (floating number, default `1.0`).<br>Hours before rarity cache refresh (integer, default `24`). |
| Moderation | `MODERATION_BANNED_TERMS` | Comma-separated additional phrases to block (case-insensitive). |
| Logging & embeds | `DEBUG_LEVEL`<br>`DEBUG_HTTP`<br>`DEBUG_SQL`<br>`STEAM_EMBED_COLOR` | One of `silent`, `error`, `warn`, `info`, `debug`, `trace` (default `info`).<br>`0`/`1` integers to toggle HTTP tracing.<br>`0`/`1` integers to toggle SQL tracing.<br>Hex color string (e.g., `#171A21`). |

Restart the bot whenever you change `.env`; modules read configuration at boot.

### GitHub webhook mode

The announcer can supplement or replace polling by accepting GitHub webhooks directly.

1. **Expose the listener** – set `GITHUB_WEBHOOK_ENABLED=true`, choose an open `GITHUB_WEBHOOK_PORT`, and (optionally) tweak `GITHUB_WEBHOOK_PATH`/`GITHUB_WEBHOOK_SECRET`. Ensure the process is reachable from GitHub (public IP, reverse proxy, or tunnel).
2. **Restart the bot** so the lightweight HTTP listener starts. Successful startup logs `Listening for GitHub webhooks on port …`.
3. **Add a webhook in GitHub** – repository **Settings → Webhooks → Add webhook**.
   - Payload URL: `https://your-host:${GITHUB_WEBHOOK_PORT}${GITHUB_WEBHOOK_PATH}` (adjust for TLS/proxy).
   - Content type: `application/json`.
   - Events: select **Just the push event** (others are ignored) plus optional **Ping** for testing.
   - Secret: use the same value as `GITHUB_WEBHOOK_SECRET` if you enabled it.
4. The bot resolves configured `/setchannel type:github_commits` targets and posts the same rich commit embeds used by the poller. Missed events are still caught by the periodic poll if you keep it enabled.

---

## 🛠️ Slash commands
| Command | Who | Purpose |
| --- | --- | --- |
| `/setchannel type:<...> [channel]` | Manage Server | Map announcement/log targets for achievements, library events, GitHub commits, sales board, XP, logs, etc. Triggers leaderboard / sales embed creation when pointed at new channels. |
| `/linksteam profile:<id|url>` | Members | Link your Steam account. Prevents duplicate claims across users. |
| `/unlinksteam` | Members | Remove your Steam link and clear cached stats/watermarks. |
| `/pingsteam [profile]` | Staff | Health check for DB + Steam API (optional profile test). |
| `/leaderboard init` | Manage Server | Create or move the persistent leaderboard embed in the current channel. |
| `/sales init` | Manage Server | Create or move the Steam sales embed in the current channel. |
| `/rank [user]` | Everyone | Show Paradise XP level/XP progress. |
| `/permit user:<member>` | Manage Messages | Allow a member to post links for 1 hour (default) without deletion. |
| `/kick`, `/ban`, `/timeout` | Kick/Ban/Moderate Members | Moderation tools with audit logging + DM notifications. |
| `/purge count:<n> [user]` | Manage Messages | Bulk delete up to 100 recent messages (optionally scoped to a user). |
| `/clearchat lines:<n>` | Manage Messages | Flood channel with blank lines to visually clear history. |
| `/warn user:<member> reason:<text>` | Manage Messages | DM a formal warning message. |

---

## 🔁 Background jobs
- **Achievements loop**: polls recent games per linked member, caches Steam schemas/rarity, posts unlocks & milestones, updates leaderboard stats.
- **Owned games loop**: detects new purchases, removal after a grace period, and keeps playtime stats fresh.
- **Now playing loop**: tracks current sessions, confirms starts, and posts end summaries after idle timeout.
- **Leaderboard refresher**: rewrites the persistent embed on a schedule with aggregated stats.
- **Sales crawler**: fetches Steam store specials, maintains cache shards, and refreshes the permanent embed & button pagination.
- **GitHub announcer**: polls the configured repository for new commits and posts Discord embeds with stats and file summaries.

All loops respect concurrency settings, seeding rules, and backfill limits to avoid overwhelming channels during first runs.

---

## 🧾 Logging & moderation
- **Structured logs** with tags such as `ACH`, `OWNED`, `SALES`, `CMD:*`, `XP`, etc. Enable verbose output via `DEBUG_LEVEL=debug` and optional HTTP/SQL tracing.
- **Discord logging channel** collects join/leave, message edits/deletes, role changes, channel events, member updates, and moderation actions (if `/setchannel type:logging` is configured).
- **Hate speech filter** normalizes text (including embed content & attachment filenames) before matching.
- **Link enforcement** automatically deletes link posts from non-staff unless they have an active permit.

---

## 🗄️ Database schema
Tables are created automatically on startup. Key tables include `links`, `steam_account_locks`, `watermarks`, `owned_seen`, `nowplaying_state`, `user_game_stats`, `leaderboard_msgs`, `sales_msgs`, `github_announcements`, `link_permits`, and `xp_progress`. Additional schema upgrades run via helper `ensureColumn` checks, so keep the bot running with a user that can issue `ALTER TABLE` when deploying updates.

---

## 🚢 Deployment tips
- Use a process supervisor that restarts on crash and captures stdout/stderr logs.
- Keep `.env` secrets out of the repo; mount or inject them in production.
- Schedule regular MySQL backups – the DB stores link state, XP, cached stats, and Steam cache data.
- Monitor Steam store scraping: adjust `STORE_UA`, region, or warmers if you hit 403s.

---

## 🔐 License
Copyright © Paradise. All rights reserved.

- Private/internal use only for the Paradise Discord server.
- No redistribution, resale, sublicensing, or public hosting without written permission.
- Modify as needed for internal use; do not share modified copies.
- Provided "as is" without warranty.

---
