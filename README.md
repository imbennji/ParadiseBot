# Paradise Discord Bot

Private automation bot built for the Paradise Discord server. It links member Steam accounts, watches for Steam activity, curates leaderboards and sales boards, adds moderation tooling, and mirrors GitHub activity into Discord – all while persisting state in MySQL so it survives restarts.

> **License:** Private / proprietary – do not redistribute. See [License](#-license) for details.

---

## ✨ Highlights
- **Steam-aware announcements** – achievements, game library additions/removals, “now playing” sessions, and running leaderboards all stay in sync with linked Steam accounts.
- **Persistent sales board** – a single embed with button-based pagination that keeps the latest discounted Steam titles cached and refreshed on a schedule.
- **Discord-native utilities** – slash commands for configuration, Steam linking, XP tracking, moderation, and link permits tailored to Paradise staff workflows.
- **Safety net moderation** – automatic hate-speech filtering, link deletion unless a permit is active, and XP awards with level-up pings in the configured channel.
- **GitHub commit mirroring** – poll or receive webhooks for repository updates, then post rich embeds into a chosen channel.

---

## 🚦 Feature tour

### Steam integration
- **Account linking (`/linksteam`)** ties a Discord user to a Steam ID (vanity URL, profile URL, or numeric ID) and locks the account to prevent duplicate claims. `/unlinksteam` clears cached data, marks, and locks for that member.
- **Achievement feed** polls each linked account’s recent games, compares unlock watermarks, and posts embeds with rarity call-outs and milestone summaries. The bot seeds watermarks on first run to prevent backfill spam and updates leaderboard stats as achievements roll in.
- **Library tracking** detects new purchases and removals (with a configurable grace period) so channels only see actionable changes. Updates feed into leaderboard stats for “new games added.”
- **Now playing + session recaps** waits for a configurable confirmation window before announcing a session start, tracks idle timeouts, and posts wrap-ups with total session length once the player leaves.
- **Steam leaderboards** maintain a single embed per guild showing lifetime playtime, two-week playtime, total achievements, and 30-day new games – refreshed on a timer and recreated if moved.
- **Steam sales board** keeps a permanent embed with pagination buttons. Results are cached with warmers, TTL extension on hit, configurable sort order, and rate-limited navigation to avoid API abuse.

### Discord automation
- **Slash command suite** covers channel mapping, Steam account management, health checks, leaderboard/sales initialization, XP ranks, moderation (kick/ban/timeout/purge/clearchat/warn), and timed link permits. Commands check permissions before acting and provide audit reasons for moderation actions.
- **XP progression** awards 15–25 XP per eligible message with a cooldown, tracks total XP/levels in MySQL, and announces level-ups in the configured channel (`/rank` exposes stats).
- **Link enforcement** automatically deletes messages containing URLs unless the author is staff or has a current permit issued by `/permit`. Deleted users receive a DM explaining the policy.
- **Content moderation** normalizes message content, embeds, and attachment filenames before checking against a hate-speech list plus optional terms from `MODERATION_BANNED_TERMS`. Matching messages are deleted and the author is notified.
- **Logging hooks** capture joins, leaves, edits, deletions, role changes, and other guild events into the configured logging channel when `/setchannel type:logging` is used.

### GitHub integration
- **Poller** watches a configured repository/branch on an interval, caching the last announced SHA so only new commits become embeds. Rich embeds include author info, stats, and file summaries.
- **Webhook receiver** optionally exposes an HTTP endpoint that verifies payload signatures and pushes commits immediately alongside the poller (which remains as a safety net).
- **Standalone announcer script** (`github-announcer.js`) is provided for lightweight deployments that only need GitHub → Discord mirroring without the full Paradise bot runtime.

---

## 🛠️ Slash commands
| Command | Required permission | Purpose |
| --- | --- | --- |
| `/setchannel type:<...> [channel]` | Manage Server | Map announcement/logging targets for achievements, new games, now playing, milestones, removals, leaderboards, sales, XP, logging, and GitHub commits. Creates leaderboard/sales embeds when pointed to new channels. |
| `/linksteam profile:<id|url>` | Everyone | Link a Steam account (vanity name, profile URL, or 64-bit ID) to the invoking user. Locks the Steam ID to prevent duplicate claims. |
| `/unlinksteam` | Everyone | Remove your Steam link and clear cached stats, watermarks, and permits in this guild. |
| `/pingsteam [profile]` | Staff | Health check that pings MySQL and the Steam Web API, with optional profile resolution & recently-played fetch test. |
| `/leaderboard init` | Manage Server | Create or move the persistent leaderboard embed to the current channel and ensure it stays updated. |
| `/sales init` | Manage Server | Create or move the Steam sales embed to the current channel, enabling button-based browsing. |
| `/rank [user]` | Everyone | Display Paradise XP level and progress for yourself or another member. |
| `/permit user:<member>` | Manage Messages | Allow a member to post links for one hour without automatic deletion. |
| `/kick user:<member> [reason]` | Kick Members | Kick a member with optional audit-log reason and DM notification. |
| `/ban user:<member> [delete_messages] [reason]` | Ban Members | Ban a user, optionally pruning up to 7 days of messages, and DM them the reason. |
| `/timeout user:<member> duration:<choice> [reason]` | Moderate Members | Apply Discord timeouts from 5 minutes up to 7 days with audit logging and DM notification. |
| `/purge count:<1-100> [user]` | Manage Messages | Bulk delete recent messages (optionally limited to a user) with retries for stubborn messages. |
| `/clearchat lines:<1-200>` | Manage Messages | Pushes blank messages to visually clear a channel for quick incident response. |
| `/warn user:<member> reason:<text>` | Manage Messages | Send a DM warning to a member and log the action. |

> Commands register globally by default; set `DEV_GUILD_ID` in development for instant guild-scoped updates.

---

## 🔁 Background jobs
- **Achievements loop:** polls recent games per linked member, announces unlocks, and records milestones & rarity summaries.
- **Owned games loop:** tracks library additions/removals, seeds on first run, and updates leaderboard statistics.
- **Now playing loop:** confirms sessions, watches for idle timeouts, and posts start/end embeds.
- **Leaderboard refresher:** ensures the embed exists in the mapped channel and rewrites it with aggregated stats on a schedule.
- **Sales crawler:** fetches specials, maintains multi-page caches, and updates the permanent sales embed & buttons.
- **GitHub announcer:** polls the configured repository for new commits and posts Discord embeds; optionally processes webhook pushes immediately.

All loops obey concurrency limits, seeding/backfill guards, and poll intervals defined in configuration to prevent first-run floods or API abuse.

---

## 🧰 Requirements
- Node.js 18+ (20 recommended).
- MySQL 8+ accessible from the bot runtime.
- Steam Web API key.
- Discord application with a bot token and permission to manage slash commands in your guild.

Optional: GitHub personal access token (for higher rate limits) and network access for webhook delivery if you enable the listener.

---

## 🚀 Setup
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Copy the environment template**
   ```bash
   cp example.env .env
   ```
   Fill in Discord, Steam, database, and optional GitHub values. Every supported option is documented inline in `example.env`.
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
   Set `DEV_GUILD_ID` during development for instant slash command registration and keep `.env` loaded in the shell.
5. **Deploy** behind a supervisor (systemd, PM2, Docker, etc.) that restarts on crash and loads the same `.env` secrets. Expose the GitHub webhook port if you enable it.

---

## ⚙️ Configuration reference
All configuration is sourced from environment variables. Highlights:

| Area | Keys | Notes |
| --- | --- | --- |
| Discord auth | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEV_GUILD_ID` | Bot token and application ID are required. `DEV_GUILD_ID` limits command registration to a single guild for development. |
| Database | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` | Connection info for the MySQL schema; defaults to `127.0.0.1:3306` and database `steam_discord_bot`. |
| Steam polling | `POLL_SECONDS`, `OWNED_POLL_SECONDS`, `NOWPLAYING_POLL_SECONDS`, `LEADERBOARD_POLL_SECONDS`, `SALES_POLL_SECONDS`, `MAX_CONCURRENCY` | Control poll frequency (seconds) and concurrent Steam API calls across loops. |
| Sales board | `SALES_SORT_BY`, `SALES_REGION_CC`, `SALES_PAGE_SIZE`, `SALES_PAGE_TTL_MS`, `SALES_PRECACHE_PAGES`, `SALES_PRECACHE_PREV_PAGES`, `SALES_PREWARM_SPACING_MS`, `SALES_EXTEND_TTL_ON_HIT`, `SALES_FULL_WARMER_*`, `SALES_MAX_PAGES_CACHE`, `SALES_NAV_COOLDOWN_MS` | Tune Steam store queries, caching behaviour, warmers, and button cooldowns. |
| Milestones & rarity | `PLAYTIME_MARKS`, `ACHIEVEMENT_MARKS`, `RARE_PCT`, `RARITY_TTL_HOURS` | Controls milestone thresholds and rarity cache refreshes. |
| Now playing | `NOWPLAYING_CONFIRM_SECONDS`, `NOWPLAYING_IDLE_TIMEOUT_SECONDS`, `SESSION_MIN_MINUTES` | Configures session confirmation delays and idle detection for recaps. |
| GitHub announcer | `GITHUB_ANNOUNCER_ENABLED`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_TOKEN`, `GITHUB_POLL_SECONDS`, `GITHUB_MAX_CATCHUP`, `GITHUB_ANNOUNCE_ON_START`, `GITHUB_EMBED_COLOR`, `GITHUB_WEBHOOK_ENABLED`, `GITHUB_WEBHOOK_PORT`, `GITHUB_WEBHOOK_PATH`, `GITHUB_WEBHOOK_SECRET` | Toggle polling/webhooks and point at the repository to mirror. Optional token boosts rate limits and enables private repo access. |
| Moderation | `MODERATION_BANNED_TERMS` | Comma-separated list of extra phrases to block in addition to the default hate-speech list. |
| Logging | `DEBUG_LEVEL`, `DEBUG_HTTP`, `DEBUG_SQL`, `STEAM_EMBED_COLOR` | Adjust log verbosity and embed colours; HTTP/SQL tracing aids debugging. |

Restart the process after changing `.env`; configuration is read at boot.

---

## 🗄️ Persistence & schema
Tables are created or migrated automatically on startup (requires MySQL privileges for `CREATE TABLE` and `ALTER TABLE`). Key tables include:
- `links`, `steam_account_locks` for Steam ↔ Discord associations.
- `watermarks`, `owned_seen`, `nowplaying_state`, `user_game_stats` for Steam tracking and leaderboard stats.
- `leaderboard_msgs`, `sales_msgs`, `github_announcements` for persistent embeds & commit state.
- `link_permits`, `xp_progress` for moderation utilities and XP progression.

Keep regular database backups – the tables store long-term progress, cached Steam schemas, and bot configuration.

---

## 🚢 Deployment tips
- Run the bot with a supervisor that restarts on crash and captures stdout/stderr logs.
- Keep `.env` secrets out of source control; inject them via your process manager or secrets store.
- Monitor Steam API usage and adjust polling/concurrency if you hit rate limits.
- When enabling GitHub webhooks, ensure firewalls/proxies expose `GITHUB_WEBHOOK_PORT` and forward the configured path.

---

## 🔐 License
Copyright © Paradise. All rights reserved.

- Private/internal use only for the Paradise Discord server.
- No redistribution, resale, sublicensing, or public hosting without written permission.
- Modification for internal use is permitted; do not share modified copies.
- Provided “as is” without warranty.

---
