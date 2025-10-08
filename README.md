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

| Area | Key flags |
| --- | --- |
| Discord auth | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEV_GUILD_ID` |
| Database | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` |
| Steam polling | `POLL_SECONDS`, `OWNED_POLL_SECONDS`, `NOWPLAYING_POLL_SECONDS`, `LEADERBOARD_POLL_SECONDS`, `SALES_POLL_SECONDS`, `MAX_CONCURRENCY` |
| Sales board | `SALES_REGION_CC`, `SALES_PAGE_SIZE`, `SALES_PRECACHE_PAGES`, `SALES_PRECACHE_PREV_PAGES`, `SALES_PAGE_TTL_MS`, `SALES_MAX_PAGES_CACHE`, `SALES_FULL_WARMER_ENABLED` |
| Milestones & rarity | `PLAYTIME_MARKS`, `ACHIEVEMENT_MARKS`, `RARE_PCT`, `RARITY_TTL_HOURS` |
| Moderation | `MODERATION_BANNED_TERMS` (comma-separated extra phrases) |
| Logging | `DEBUG_LEVEL`, `DEBUG_HTTP`, `DEBUG_SQL`, `STEAM_EMBED_COLOR` |

Restart the bot whenever you change `.env`; modules read configuration at boot.

---

## 🛠️ Slash commands
| Command | Who | Purpose |
| --- | --- | --- |
| `/setchannel type:<...> [channel]` | Manage Server | Map announcement/log targets for achievements, library events, sales board, XP, logs, etc. Triggers leaderboard / sales embed creation when pointed at new channels. |
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

All loops respect concurrency settings, seeding rules, and backfill limits to avoid overwhelming channels during first runs.

---

## 🧾 Logging & moderation
- **Structured logs** with tags such as `ACH`, `OWNED`, `SALES`, `CMD:*`, `XP`, etc. Enable verbose output via `DEBUG_LEVEL=debug` and optional HTTP/SQL tracing.
- **Discord logging channel** collects join/leave, message edits/deletes, role changes, channel events, member updates, and moderation actions (if `/setchannel type:logging` is configured).
- **Hate speech filter** normalizes text (including embed content & attachment filenames) before matching.
- **Link enforcement** automatically deletes link posts from non-staff unless they have an active permit.

---

## 🗄️ Database schema
Tables are created automatically on startup. Key tables include `links`, `steam_account_locks`, `watermarks`, `owned_seen`, `nowplaying_state`, `user_game_stats`, `leaderboard_msgs`, `sales_msgs`, `link_permits`, and `xp_progress`. Additional schema upgrades run via helper `ensureColumn` checks, so keep the bot running with a user that can issue `ALTER TABLE` when deploying updates.

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
