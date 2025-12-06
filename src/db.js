/**
 * Database bootstrapper and query helper functions. This module is intentionally tiny so that
 * higher-level modules interact with a constrained surface area: `dbGet` for single rows, `dbAll`
 * for multi-row selects, and `dbRun` for writes. Schema migrations that only require new tables or
 * columns live here as part of the startup sequence.
 */
const mysql = require('mysql2/promise');
const { time, log, DEBUG_SQL } = require('./logger');
const { DB_CFG } = require('./config');

let pool;

/**
 * Creates the shared MySQL connection pool and ensures all required tables exist. The schema is
 * intentionally co-located with the application code to remove external migration dependencies and
 * to make first-time setup a single command (start the bot and it provisions itself).
 */
async function initDb() {
  const t = time('DB:init');
  pool = mysql.createPool(DB_CFG);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id   VARCHAR(32) NOT NULL PRIMARY KEY,
      channel_id VARCHAR(32) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS guild_channels (
      guild_id   VARCHAR(32) NOT NULL,
      kind       VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      PRIMARY KEY (guild_id, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS links (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      steam_id VARCHAR(32) NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS steam_account_locks (
      steam_id VARCHAR(32) NOT NULL PRIMARY KEY,
      user_id  VARCHAR(32) NOT NULL,
      linked_at INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS watermarks (
      guild_id    VARCHAR(32) NOT NULL,
      user_id     VARCHAR(32) NOT NULL,
      appid       INT NOT NULL,
      last_unlock INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_schema (
      appid      INT NOT NULL PRIMARY KEY,
      fetched_at BIGINT NOT NULL,
      payload    LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_names (
      appid      INT NOT NULL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      source     VARCHAR(32) NOT NULL,
      fetched_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS owned_seen (
      guild_id   VARCHAR(32) NOT NULL,
      user_id    VARCHAR(32) NOT NULL,
      appid      INT NOT NULL,
      first_seen INT NOT NULL,
      seeded     TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS global_ach_pct (
      appid INT NOT NULL,
      api_name VARCHAR(191) NOT NULL,
      pct DOUBLE NOT NULL,
      fetched_at BIGINT NOT NULL,
      PRIMARY KEY (appid, api_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS ach_progress_marks (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      last_pct INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS playtime_marks (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      last_mark_hours INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS nowplaying_state (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      name     VARCHAR(191) NULL,
      started_at INT NOT NULL,
      last_seen_at INT NOT NULL,
      announced TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_nowplaying_state_guild_id ON nowplaying_state (guild_id)');
  await dbRun(`
    CREATE TABLE IF NOT EXISTS owned_presence (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      last_seen INT NOT NULL,
      missing_since INT NULL,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_game_stats (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      appid    INT NOT NULL,
      playtime_total_min INT NOT NULL DEFAULT 0,
      playtime_2w_min    INT NOT NULL DEFAULT 0,
      ach_unlocked       INT NOT NULL DEFAULT 0,
      ach_total          INT NOT NULL DEFAULT 0,
      updated_at         INT NOT NULL,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_user_game_stats_guild_id ON user_game_stats (guild_id)');
  await dbRun(`
    CREATE TABLE IF NOT EXISTS leaderboard_msgs (
      guild_id   VARCHAR(32) NOT NULL PRIMARY KEY,
      channel_id VARCHAR(32) NOT NULL,
      message_id VARCHAR(32) NOT NULL,
      updated_at INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sales_msgs (
      guild_id   VARCHAR(32) NOT NULL PRIMARY KEY,
      channel_id VARCHAR(32) NOT NULL,
      message_id VARCHAR(32) NOT NULL,
      updated_at INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS github_announcements (
      repo         VARCHAR(191) NOT NULL PRIMARY KEY,
      last_sha     VARCHAR(64) NULL,
      announced_at BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS link_permits (
      guild_id   VARCHAR(32) NOT NULL,
      user_id    VARCHAR(32) NOT NULL,
      granted_by VARCHAR(32) NOT NULL,
      expires_at BIGINT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS xp_progress (
      guild_id        VARCHAR(32) NOT NULL,
      user_id         VARCHAR(32) NOT NULL,
      xp              INT NOT NULL DEFAULT 0,
      level           INT NOT NULL DEFAULT 0,
      last_message_at INT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_xp_progress_guild_id ON xp_progress (guild_id)');

  await ensureColumn('nowplaying_state', 'announced', 'TINYINT NOT NULL DEFAULT 0');
  await ensureColumn('nowplaying_state', 'name', 'VARCHAR(191) NULL');
  await ensureColumn('owned_seen', 'seeded', 'TINYINT NOT NULL DEFAULT 0');

  t.end();
}

/**
 * Executes a query that is expected to return zero or one row.
 *
 * @template T
 * @param {string} sql - Prepared statement with placeholders.
 * @param {Array} [params=[]] - Values bound to the placeholders.
 * @returns {Promise<T|null>} First row or `null` when no results are returned.
 */
async function dbGet(sql, params = []) {
  const t = time('DB:get');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [rows] = await pool.query(sql, params);
  const row = rows[0] || null;
  log.tag('DB').trace(`get -> ${row ? '1 row' : '0 rows'}`);
  t.end(); return row;
}
/**
 * Executes a read-only query and returns every row.
 *
 * @template T
 * @param {string} sql - Prepared statement with placeholders.
 * @param {Array} [params=[]] - Values bound to the placeholders.
 * @returns {Promise<T[]>} Result set.
 */
async function dbAll(sql, params = []) {
  const t = time('DB:all');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [rows] = await pool.query(sql, params);
  log.tag('DB').trace(`all -> ${rows.length} rows`);
  t.end(); return rows;
}
/**
 * Executes a statement that modifies rows (INSERT/UPDATE/DELETE).
 *
 * @param {string} sql - Prepared statement with placeholders.
 * @param {Array} [params=[]] - Values bound to the placeholders.
 * @returns {Promise<import('mysql2').ResultSetHeader>} Raw driver response for introspection.
 */
async function dbRun(sql, params = []) {
  const t = time('DB:run');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [res] = await pool.query(sql, params);
  log.tag('DB').trace(`run -> affectedRows=${res?.affectedRows ?? 0}`);
  t.end(); return res;
}
/**
 * Adds a column to an existing table when it is missing. We avoid altering the table when the
 * column already exists to keep repeated startups idempotent.
 *
 * @param {string} table - Name of the table to alter.
 * @param {string} column - Column that should be present.
 * @param {string} columnDef - SQL definition for the column.
 */
async function ensureColumn(table, column, columnDef) {
  const row = await dbGet(
    'SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
    [DB_CFG.database, table, column]
  );
  if (!row) {
    await dbRun(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${columnDef}`);
    log.tag('DB:MIGRATE').info(`Added column ${table}.${column}`);
  }
}

/**
 * Provides direct access to the underlying connection pool when specialised queries are required.
 * Throws if the pool has not been initialised so callers fail loudly instead of operating on `null`.
 *
 * @returns {import('mysql2/promise').Pool} Shared connection pool.
 */
function getPool() {
  if (!pool) throw new Error('DB pool not initialized');
  return pool;
}

module.exports = {
  initDb,
  dbGet,
  dbAll,
  dbRun,
  ensureColumn,
  getPool,
};
