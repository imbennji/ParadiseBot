# Paradise Discord Bot

Private automation bot built for the Paradise Discord server. It links member Steam accounts, watches for Steam activity, curates leaderboards and sales boards, adds moderation tooling, and mirrors GitHub activity into Discord – all while persisting state in MySQL so it survives restarts.【F:index.js†L3-L94】【F:src/db.js†L8-L179】

> **License:** Private / proprietary – do not redistribute. See [License](#-license) for details.

---

## ✨ Highlights
- **Steam-aware announcements** – achievements, game library additions/removals, “now playing” sessions, and running leaderboards all stay in sync with linked Steam accounts.【F:src/loops/achievements.js†L33-L143】【F:src/loops/owned.js†L23-L191】【F:src/loops/nowPlaying.js†L27-L205】【F:src/loops/leaderboard.js†L53-L133】
- **Persistent sales board** – a single embed with button-based pagination that keeps the latest discounted Steam titles cached and refreshed on a schedule.【F:src/sales/index.js†L29-L275】
- **Discord-native utilities** – slash commands for configuration, Steam linking, XP tracking, moderation, and link permits tailored to Paradise staff workflows.【F:src/discord/commands.js†L30-L254】【F:src/discord/commands.js†L320-L410】
- **Safety net moderation** – automatic hate-speech filtering, link deletion unless a permit is active, and XP awards with level-up pings in the configured channel.【F:src/discord/moderation.js†L1-L118】【F:src/discord/permits.js†L6-L57】【F:src/discord/xp.js†L1-L101】
- **GitHub commit mirroring** – poll or receive webhooks for repository updates, then post rich embeds into a chosen channel.【F:src/github/announcer.js†L1-L123】【F:src/github/webhook.js†L10-L166】

---

## 🚦 Feature tour

### Steam integration
- **Account linking (`/linksteam`)** ties a Discord user to a Steam ID (vanity URL, profile URL, or numeric ID) and locks the account to prevent duplicate claims. `/unlinksteam` clears cached data, marks, and locks for that member.【F:src/discord/commands.js†L61-L133】
- **Achievement feed** polls each linked account’s recent games, compares unlock watermarks, and posts embeds with rarity call-outs and milestone summaries. The bot seeds watermarks on first run to prevent backfill spam and updates leaderboard stats as achievements roll in.【F:src/loops/achievements.js†L33-L210】
- **Library tracking** detects new purchases and removals (with a configurable grace period) so channels only see actionable changes. Updates feed into leaderboard stats for “new games added.”【F:src/loops/owned.js†L27-L200】【F:src/config.js†L76-L107】
- **Now playing + session recaps** waits for a configurable confirmation window before announcing a session start, tracks idle timeouts, and posts wrap-ups with total session length once the player leaves.【F:src/loops/nowPlaying.js†L27-L205】【F:src/config.js†L110-L126】
- **Steam leaderboards** maintain a single embed per guild showing lifetime playtime, two-week playtime, total achievements, and 30-day new games – refreshed on a timer and recreated if moved.【F:src/loops/leaderboard.js†L53-L170】
- **Steam sales board** keeps a permanent embed with pagination buttons. Results are cached with warmers, TTL extension on hit, configurable sort order, and rate-limited navigation to avoid API abuse.【F:src/sales/index.js†L29-L332】【F:src/config.js†L56-L90】

### Discord automation
- **Slash command suite** covers channel mapping, Steam account management, health checks, leaderboard/sales initialization, XP ranks, moderation (kick/ban/timeout/purge/clearchat/warn), and timed link permits. Commands check permissions before acting and provide audit reasons for moderation actions.【F:src/discord/commands.js†L30-L407】
- **XP progression** awards 15–25 XP per eligible message with a cooldown, tracks total XP/levels in MySQL, and announces level-ups in the configured channel (`/rank` exposes stats).【F:src/discord/xp.js†L1-L101】
- **Link enforcement** automatically deletes messages containing URLs unless the author is staff or has a current permit issued by `/permit`. Deleted users receive a DM explaining the policy.【F:index.js†L102-L153】【F:src/discord/permits.js†L6-L57】
- **Content moderation** normalizes message content, embeds, and attachment filenames before checking against a hate-speech list plus optional terms from `MODERATION_BANNED_TERMS`. Matching messages are deleted and the author is notified.【F:src/discord/moderation.js†L1-L118】
- **Logging hooks** capture joins, leaves, edits, deletions, role changes, and other guild events into the configured logging channel when `/setchannel type:logging` is used.【F:src/discord/logging.js†L7-L199】

### GitHub integration
- **Poller** watches a configured repository/branch on an interval, caching the last announced SHA so only new commits become embeds. Rich embeds include author info, stats, and file summaries.【F:src/github/announcer.js†L32-L227】
- **Webhook receiver** optionally exposes an HTTP endpoint that verifies payload signatures and pushes commits immediately alongside the poller (which remains as a safety net).【F:src/github/webhook.js†L10-L166】【F:src/config.js†L30-L55】
- **Standalone announcer script** (`github-announcer.js`) is provided for lightweight deployments that only need GitHub → Discord mirroring without the full Paradise bot runtime.【F:github-announcer.js†L1-L120】

---

## 🛠️ Slash commands
| Command | Required permission | Purpose |
| --- | --- | --- |
| `/setchannel type:<...> [channel]` | Manage Server | Map announcement/logging targets for achievements, new games, now playing, milestones, removals, leaderboards, sales, XP, logging, and GitHub commits. Creates leaderboard/sales embeds when pointed to new channels.【F:src/discord/commands.js†L30-L101】 |
| `/linksteam profile:<id|url>` | Everyone | Link a Steam account (vanity name, profile URL, or 64-bit ID) to the invoking user. Locks the Steam ID to prevent duplicate claims.【F:src/discord/commands.js†L61-L109】 |
| `/unlinksteam` | Everyone | Remove your Steam link and clear cached stats, watermarks, and permits in this guild.【F:src/discord/commands.js†L111-L139】 |
| `/pingsteam [profile]` | Staff | Health check that pings MySQL and the Steam Web API, with optional profile resolution & recently-played fetch test.【F:src/discord/commands.js†L141-L189】 |
| `/leaderboard init` | Manage Server | Create or move the persistent leaderboard embed to the current channel and ensure it stays updated.【F:src/discord/commands.js†L191-L215】 |
| `/sales init` | Manage Server | Create or move the Steam sales embed to the current channel, enabling button-based browsing.【F:src/discord/commands.js†L217-L239】 |
| `/rank [user]` | Everyone | Display Paradise XP level and progress for yourself or another member.【F:src/discord/commands.js†L260-L306】 |
| `/permit user:<member>` | Manage Messages | Allow a member to post links for one hour without automatic deletion.【F:src/discord/commands.js†L241-L259】【F:src/discord/permits.js†L6-L38】 |
| `/kick user:<member> [reason]` | Kick Members | Kick a member with optional audit-log reason and DM notification.【F:src/discord/commands.js†L308-L354】 |
| `/ban user:<member> [delete_messages] [reason]` | Ban Members | Ban a user, optionally pruning up to 7 days of messages, and DM them the reason.【F:src/discord/commands.js†L356-L406】 |
| `/timeout user:<member> duration:<choice> [reason]` | Moderate Members | Apply Discord timeouts from 5 minutes up to 7 days with audit logging and DM notification.【F:src/discord/commands.js†L408-L472】 |
| `/purge count:<1-100> [user]` | Manage Messages | Bulk delete recent messages (optionally limited to a user) with retries for stubborn messages.【F:src/discord/commands.js†L474-L566】 |
| `/clearchat lines:<1-200>` | Manage Messages | Pushes blank messages to visually clear a channel for quick incident response.【F:src/discord/commands.js†L568-L613】 |
| `/warn user:<member> reason:<text>` | Manage Messages | Send a DM warning to a member and log the action.【F:src/discord/commands.js†L615-L653】 |

> Commands register globally by default; set `DEV_GUILD_ID` in development for instant guild-scoped updates.【F:src/discord/commands.js†L21-L49】

---

## 🔁 Background jobs
- **Achievements loop:** polls recent games per linked member, announces unlocks, and records milestones & rarity summaries.【F:src/loops/achievements.js†L33-L210】
- **Owned games loop:** tracks library additions/removals, seeds on first run, and updates leaderboard statistics.【F:src/loops/owned.js†L27-L200】
- **Now playing loop:** confirms sessions, watches for idle timeouts, and posts start/end embeds.【F:src/loops/nowPlaying.js†L27-L205】
- **Leaderboard refresher:** ensures the embed exists in the mapped channel and rewrites it with aggregated stats on a schedule.【F:src/loops/leaderboard.js†L53-L170】
- **Sales crawler:** fetches specials, maintains multi-page caches, and updates the permanent sales embed & buttons.【F:src/sales/index.js†L29-L275】
- **GitHub announcer:** polls the configured repository for new commits and posts Discord embeds; optionally processes webhook pushes immediately.【F:src/github/announcer.js†L124-L227】【F:src/github/webhook.js†L10-L166】

All loops obey concurrency limits, seeding/backfill guards, and poll intervals defined in configuration to prevent first-run floods or API abuse.【F:src/config.js†L56-L126】

---

## 🧰 Requirements
- Node.js 18+ (20 recommended).
- MySQL 8+ accessible from the bot runtime.
- Steam Web API key.
- Discord application with a bot token and permission to manage slash commands in your guild.

Optional: GitHub personal access token (for higher rate limits) and network access for webhook delivery if you enable the listener.【F:src/config.js†L30-L55】

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
   Set `DEV_GUILD_ID` during development for instant slash command registration and keep `.env` loaded in the shell.【F:index.js†L41-L87】
5. **Deploy** behind a supervisor (systemd, PM2, Docker, etc.) that restarts on crash and loads the same `.env` secrets. Expose the GitHub webhook port if you enable it.【F:src/github/webhook.js†L10-L166】

---

## ⚙️ Configuration reference
All configuration is sourced from environment variables. Highlights:

| Area | Keys | Notes |
| --- | --- | --- |
| Discord auth | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEV_GUILD_ID` | Bot token and application ID are required. `DEV_GUILD_ID` limits command registration to a single guild for development.【F:src/config.js†L1-L25】 |
| Database | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` | Connection info for the MySQL schema; defaults to `127.0.0.1:3306` and database `steam_discord_bot`.【F:src/config.js†L12-L25】 |
| Steam polling | `POLL_SECONDS`, `OWNED_POLL_SECONDS`, `NOWPLAYING_POLL_SECONDS`, `LEADERBOARD_POLL_SECONDS`, `SALES_POLL_SECONDS`, `MAX_CONCURRENCY` | Control poll frequency (seconds) and concurrent Steam API calls across loops.【F:src/config.js†L92-L106】 |
| Sales board | `SALES_SORT_BY`, `SALES_REGION_CC`, `SALES_PAGE_SIZE`, `SALES_PAGE_TTL_MS`, `SALES_PRECACHE_PAGES`, `SALES_PRECACHE_PREV_PAGES`, `SALES_PREWARM_SPACING_MS`, `SALES_EXTEND_TTL_ON_HIT`, `SALES_FULL_WARMER_*`, `SALES_MAX_PAGES_CACHE`, `SALES_NAV_COOLDOWN_MS` | Tune Steam store queries, caching behaviour, warmers, and button cooldowns.【F:src/config.js†L56-L90】 |
| Milestones & rarity | `PLAYTIME_MARKS`, `ACHIEVEMENT_MARKS`, `RARE_PCT`, `RARITY_TTL_HOURS` | Controls milestone thresholds and rarity cache refreshes.【F:src/config.js†L108-L122】 |
| Now playing | `NOWPLAYING_CONFIRM_SECONDS`, `NOWPLAYING_IDLE_TIMEOUT_SECONDS`, `SESSION_MIN_MINUTES` | Configures session confirmation delays and idle detection for recaps.【F:src/config.js†L110-L126】 |
| GitHub announcer | `GITHUB_ANNOUNCER_ENABLED`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_TOKEN`, `GITHUB_POLL_SECONDS`, `GITHUB_MAX_CATCHUP`, `GITHUB_ANNOUNCE_ON_START`, `GITHUB_EMBED_COLOR`, `GITHUB_WEBHOOK_ENABLED`, `GITHUB_WEBHOOK_PORT`, `GITHUB_WEBHOOK_PATH`, `GITHUB_WEBHOOK_SECRET` | Toggle polling/webhooks and point at the repository to mirror. Optional token boosts rate limits and enables private repo access.【F:src/config.js†L30-L55】 |
| Moderation | `MODERATION_BANNED_TERMS` | Comma-separated list of extra phrases to block in addition to the default hate-speech list.【F:src/discord/moderation.js†L38-L76】 |
| Logging | `DEBUG_LEVEL`, `DEBUG_HTTP`, `DEBUG_SQL`, `STEAM_EMBED_COLOR` | Adjust log verbosity and embed colours; HTTP/SQL tracing aids debugging.【F:src/logger.js†L9-L120】【F:src/config.js†L94-L107】 |

Restart the process after changing `.env`; configuration is read at boot.【F:index.js†L3-L94】

---

## 🗄️ Persistence & schema
Tables are created or migrated automatically on startup (requires MySQL privileges for `CREATE TABLE` and `ALTER TABLE`). Key tables include:
- `links`, `steam_account_locks` for Steam ↔ Discord associations.
- `watermarks`, `owned_seen`, `nowplaying_state`, `user_game_stats` for Steam tracking and leaderboard stats.
- `leaderboard_msgs`, `sales_msgs`, `github_announcements` for persistent embeds & commit state.
- `link_permits`, `xp_progress` for moderation utilities and XP progression.【F:src/db.js†L8-L205】

Keep regular database backups – the tables store long-term progress, cached Steam schemas, and bot configuration.

---

## 🚢 Deployment tips
- Run the bot with a supervisor that restarts on crash and captures stdout/stderr logs.【F:index.js†L3-L94】
- Keep `.env` secrets out of source control; inject them via your process manager or secrets store.
- Monitor Steam API usage and adjust polling/concurrency if you hit rate limits.【F:src/config.js†L92-L126】
- When enabling GitHub webhooks, ensure firewalls/proxies expose `GITHUB_WEBHOOK_PORT` and forward the configured path.【F:src/github/webhook.js†L10-L166】

---

## 🔐 License
Copyright © Paradise. All rights reserved.

- Private/internal use only for the Paradise Discord server.
- No redistribution, resale, sublicensing, or public hosting without written permission.
- Modification for internal use is permitted; do not share modified copies.
- Provided “as is” without warranty.

---
