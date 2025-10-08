# Paradise — Steam ↔ Discord Announcer Bot

A production-ready Discord bot built for the Paradise Discord server that links members to their Steam profiles and posts rich, automated announcements: achievements, new games added, session start/stop, playtime leaderboards, and a permanent “Steam Game Sales” embed with fast paging and caching.

> **License:** Private/Proprietary. All rights reserved. See the **License** section below.


## ✨ Features

- **Steam achievements**: per-game unlock feeds, rarity (global %), milestone posts (25/50/75/100%).
- **Library tracking**: new games added, removals (with grace period).
- **Now playing & sessions**: start confirmations, idle-based end summaries with duration.
- **Leaderboards**: rolling top lists (lifetime hours, 2‑week hours, total achievements, new adds).
- **Steam sales board**: a single, permanent embed that pages discounted games instantly with:
  - LRU data cache, TTLs, epoch‑guarded buttons (race‑proof), pre‑warming, periodic full‑warm.
  - Accurate discount % (computed when Steam omits it), locale‑robust price parsing.
- **MySQL persistence**: resilient, idempotent upserts and automatic migrations.
- **Observability**: structured logging, timing helpers, optional HTTP/SQL debug logs.
- **Safety**: permission checks, rate/concurrency limits, mature‑content & 403 handling for store pages.


## 🧰 Tech Stack

- **Node.js** (v18+ recommended; v20+ ideal)
- **discord.js v14**
- **MySQL 8+** (via `mysql2/promise`)
- **Steam Web API** + Steam Store scraping with `axios`, `tough-cookie`, `axios-cookiejar-support`, `cheerio`
- Utilities: `p-limit`, `dotenv`


## 🚀 Quick Start

### 0) Prerequisites
- **Node.js 18+** (20+ recommended for longer-term support)
- **MySQL 8+** reachable from the bot runtime
- Discord permissions to create/manage an application and invite it to your guilds

### 1) Create a Discord application & bot
- Enable the **bot** in the Developer Portal, invite it with the `applications.commands` and `bot` scopes.
- Grant channel perms: **View Channel**, **Send Messages**, **Embed Links**.

### 2) Prepare a MySQL database
```sql
CREATE DATABASE steam_discord_bot CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
GRANT ALL ON steam_discord_bot.* TO 'youruser'@'%' IDENTIFIED BY 'yourpass';
FLUSH PRIVILEGES;
```

### 3) Configure environment
Create a `.env` file in the project root. Values shown here are sane defaults—tune them for your guild scale and announcement cadence.

```bash
# Discord
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DEV_GUILD_ID=             # optional: fast command registration for one guild

# Steam
STEAM_API_KEY=

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=
DB_NAME=steam_discord_bot

# Behavior & tuning
DEBUG_LEVEL=info          # silent|error|warn|info|debug|trace
DEBUG_HTTP=0
DEBUG_SQL=0
MAX_CONCURRENCY=2         # worker pool for Steam/MySQL calls

# Sales board
SALES_REGION_CC=US
SALES_PAGE_SIZE=10
SALES_SORT_BY=Discount_DESC   # Steam sort key
SALES_PRECACHE_PAGES=10
SALES_PRECACHE_PREV_PAGES=2
SALES_PAGE_TTL_MS=1200000     # 20 minutes
SALES_MAX_PAGES_CACHE=400
SALES_PREWARM_SPACING_MS=800
SALES_EXTEND_TTL_ON_HIT=true
SALES_FULL_WARMER_ENABLED=true
SALES_FULL_WARMER_DELAY_MS=15000
SALES_FULL_WARMER_SPACING_MS=1500
STORE_UA=                     # optional custom UA string

# Polling (seconds)
POLL_SECONDS=300             # achievements
OWNED_POLL_SECONDS=3600      # new library adds
NOWPLAYING_POLL_SECONDS=120  # current session
LEADERBOARD_POLL_SECONDS=300
SALES_POLL_SECONDS=86400

# Thresholds & marks
PLAYTIME_MARKS=10,25,50,100
ACHIEVEMENT_MARKS=25,50,75,100
RARE_PCT=1.0                 # <= 1% global is 'rare'
RARITY_TTL_HOURS=24
RECENT_LIMIT=10

# Sessions
NOWPLAYING_CONFIRM_SECONDS=60
NOWPLAYING_IDLE_TIMEOUT_SECONDS=150  # auto derived; can override
SESSION_MIN_MINUTES=10

# Colors
STEAM_EMBED_COLOR=#171A21
```

> Need a pre-filled example? See the **`.env example`** below.

### 4) Install & run
```bash
npm install
node index.js
```
The bot registers slash commands globally (or to `DEV_GUILD_ID` if set). For production, wrap the start command in your process manager of choice (systemd, PM2, Docker, etc.).

### 5) Set channels & start
In Discord, run these commands (as an admin with **Manage Server**):

```
/setchannel type:steam_achievements   channel:#your-achievements
/setchannel type:new_game_notifications channel:#your-library
/setchannel type:now_playing            channel:#your-sessions
/setchannel type:milestones             channel:#your-milestones
/setchannel type:library_removals       channel:#your-library
...
/sales init                             # creates/moves the sales embed here
/leaderboard init                       # creates/moves the leaderboard here
```

Users then link their Steam:
```
/linksteam profile:<vanity|profile URL|steamid64>
```
…and can unlink with `/unlinksteam`.

---

## ⚙️ `.env example`

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=123456789012345678
DEV_GUILD_ID=                             # optional

STEAM_API_KEY=your_steam_web_api_key

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=
DB_NAME=steam_discord_bot

DEBUG_LEVEL=info
DEBUG_HTTP=0
DEBUG_SQL=0
MAX_CONCURRENCY=2

SALES_REGION_CC=US
SALES_PAGE_SIZE=10
SALES_SORT_BY=Discount_DESC
SALES_PRECACHE_PAGES=10
SALES_PRECACHE_PREV_PAGES=2
SALES_PAGE_TTL_MS=1200000
SALES_MAX_PAGES_CACHE=400
SALES_PREWARM_SPACING_MS=800
SALES_EXTEND_TTL_ON_HIT=true
SALES_FULL_WARMER_ENABLED=true
SALES_FULL_WARMER_DELAY_MS=15000
SALES_FULL_WARMER_SPACING_MS=1500
STORE_UA=

POLL_SECONDS=300
OWNED_POLL_SECONDS=3600
NOWPLAYING_POLL_SECONDS=120
LEADERBOARD_POLL_SECONDS=300
SALES_POLL_SECONDS=86400

PLAYTIME_MARKS=10,25,50,100
ACHIEVEMENT_MARKS=25,50,75,100
RARE_PCT=1.0
RARITY_TTL_HOURS=24
RECENT_LIMIT=10

NOWPLAYING_CONFIRM_SECONDS=60
NOWPLAYING_IDLE_TIMEOUT_SECONDS=150
SESSION_MIN_MINUTES=10

STEAM_EMBED_COLOR=#171A21
```


## 🗂️ Project layout

```
src/
├─ config.js            # Centralised environment parsing & sanity checks
├─ db.js                # MySQL pool helpers & migrations
├─ discord/             # Slash command handlers, interaction routing, permission guards
├─ loops/               # Pollers for achievements, owned games, play sessions, sales, etc.
├─ sales/               # Steam store scraping, caching and paginator orchestration
├─ steam/               # Steam Web API + Web store fetching utilities
├─ utils/               # Shared helpers (formatting, embeds, rate limiting)
└─ logger.js            # Structured logging wrapper
```

> Tip: start with `index.js` to see how Discord, the poll loops, and persistence are wired together.


## ⚙️ Configuration deep dive

Key environment flags for tuning behaviour:

- **Concurrency & backfill** – `MAX_CONCURRENCY`, `BACKFILL_LIMIT`, `SEED_ON_FIRST_RUN`, `SEED_IF_ZERO`, and friends govern how aggressively the bot catches up when first launched and how many Steam calls can execute concurrently.
- **Announcement cadence** – Poll intervals like `POLL_SECONDS`, `OWNED_POLL_SECONDS`, `NOWPLAYING_POLL_SECONDS`, and `LEADERBOARD_POLL_SECONDS` map directly to the timers defined in `src/config.js`. Shorter intervals mean faster updates at the cost of more API traffic.
- **Sales cache behaviour** – Tweak `SALES_PRECACHE_PAGES`, `SALES_PRECACHE_PREV_PAGES`, `SALES_EXTEND_TTL_ON_HIT`, and `SALES_FULL_WARMER_*` to balance immediacy versus Steam store load.
- **Rarity thresholds** – `RARE_PCT`, `RARITY_TTL_HOURS`, `PLAYTIME_MARKS`, and `ACHIEVEMENT_MARKS` govern which milestones become milestone posts.
- **Schema refresh** – `SCHEMA_TTL_HOURS` limits how frequently automatic migrations re-check the database structure.

Whenever you change `.env`, restart the bot—the config module reads values at boot.


## 🧪 Local development tips

1. Copy `example.env` → `.env` and fill in secrets.
2. Run `npm install` once, then `node index.js` to start the bot.
3. Set `DEBUG_LEVEL=debug` (and optionally `DEBUG_HTTP=1`, `DEBUG_SQL=1`) to surface verbose logging from `src/logger.js`.
4. Use a private Discord server with test Steam accounts to avoid spamming production channels while iterating on handlers.

For iterative development, pair the bot with a local database (e.g. Docker MySQL) and use the `steam_discord_bot` schema provided in the SQL snippet above. All schema migrations are applied on startup—watch the logs for `[schema]` entries confirming updates.


## 🚢 Deployment notes

- **Process manager** – Systemd, PM2, or Docker keep the bot alive and restart on crashes. Ensure the `.env` file is mounted or environment variables are supplied via secrets.
- **Health checks** – The `/pingsteam` command verifies Steam API reachability and database connectivity. Automate a periodic check to detect regressions.
- **Scaling** – Horizontal scaling requires sharding Discord connections. For a single-guild bot, one instance is typically sufficient; if you plan to shard, ensure each worker has a unique token/shard configuration and consider moving polling loops into a shared worker to avoid duplicate announcements.
- **Backups** – The MySQL database houses link state, playtime history, and cached sales pages. Schedule regular dumps and monitor disk usage.


## 🔘 Sales Board UX tips

- Button clicks are acknowledged via `deferUpdate()` for “instant” feel.
- Pages are **epoch‑guarded**: only the newest click updates the message (prevents race flicker).
- A **pre‑warmer** fetches the next N pages in the background; periodic **full warm** fills the cache.
- TTLs keep data reasonably fresh, with a scheduled refresh that resets epoch and components.


## 🧑‍💻 Command Reference

- `/setchannel type:<kind> [channel:<#>]` — map a feature to a channel.
  Kinds: `steam_achievements`, `new_game_notifications`, `now_playing`, `milestones`, `library_removals`, `leaderboard`, `steam_game_sales`
- `/linksteam profile:<id|url|steamid64>` — link your Steam account in this guild.
- `/unlinksteam` — unlink and clear cached stats.
- `/pingsteam [profile:<...>]` — DB & Steam health check; optional profile resolution test.
- `/leaderboard init` — create/move the permanent leaderboard message here.
- `/sales init` — create/move the permanent Steam Game Sales embed here.


## 🔒 Permissions

- Members need to execute `/linksteam`.
- Admins need **Manage Server** to run `/setchannel`, `/leaderboard init`, `/sales init`.
- The bot requires channel perms: **View Channel**, **Send Messages**, **Embed Links**.


## 🧩 Troubleshooting

- **Buttons “don’t change games”**: ensure epoch updates and `interaction.editReply` aren’t blocked by permissions; check debug logs.
- **HTTP 403 from store**: session bootstrap re-runs automatically; verify `STORE_UA`, region cookie, and that outbound IP isn’t blocked.
- **No achievements shown**: user library or achievements may be private; verify Steam profile and game privacy settings.
- **MySQL connect errors**: confirm credentials & host reachability; the app does basic migrations automatically.
- **Slash commands missing**: allow up to a few minutes globally, or set `DEV_GUILD_ID` for instant per‑guild registration.


## 🔐 License (Private/Proprietary)

Copyright © {YEAR} {OWNER}. All rights reserved.

- You are granted a personal, non‑transferable, non‑sublicensable license to use this software **privately**.
- **Redistribution, resale, relicensing, or public hosting (including public GitHub repos) is prohibited** without explicit written permission.
- You may modify the code for your private use. You may not distribute modified versions.
- No warranty; use at your own risk.

> Replace `{YEAR}` and `{OWNER}` above with your details if desired.


## 💬 Support

- Open a private ticket in your workspace or contact the maintainer directly.
- For bug reports, include your config (`.env` with secrets redacted), Node.js version, and debug logs (set `DEBUG_LEVEL=debug` and optionally `DEBUG_HTTP=1`, `DEBUG_SQL=1`).


---

Made with ❤️ for Discord communities who love Steam.
