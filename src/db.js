const mysql = require('mysql2/promise');
const { time, log, DEBUG_SQL } = require('./logger');
const { DB_CFG } = require('./config');

let pool;

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
      started_at INT NOT NULL,
      last_seen_at INT NOT NULL,
      announced TINYINT NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, appid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
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

  await ensureColumn('nowplaying_state', 'announced', 'TINYINT NOT NULL DEFAULT 0');
  await ensureColumn('owned_seen', 'seeded', 'TINYINT NOT NULL DEFAULT 0');

  t.end();
}

async function dbGet(sql, params = []) {
  const t = time('DB:get');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [rows] = await pool.query(sql, params);
  const row = rows[0] || null;
  log.tag('DB').trace(`get -> ${row ? '1 row' : '0 rows'}`);
  t.end(); return row;
}
async function dbAll(sql, params = []) {
  const t = time('DB:all');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [rows] = await pool.query(sql, params);
  log.tag('DB').trace(`all -> ${rows.length} rows`);
  t.end(); return rows;
}
async function dbRun(sql, params = []) {
  const t = time('DB:run');
  DEBUG_SQL && log.tag('SQL').debug(sql, JSON.stringify(params));
  const [res] = await pool.query(sql, params);
  log.tag('DB').trace(`run -> affectedRows=${res?.affectedRows ?? 0}`);
  t.end(); return res;
}
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
