/**
 * Thin wrapper around Steam Web API endpoints. The functions here centralise logging, caching, and
 * rate-limit friendly behaviour so other modules can focus on business logic.
 */
const axios = require('axios').default;
const { log, time } = require('../logger');
const { dbRun, dbGet, dbAll } = require('../db');
const {
  STEAM_HOST,
  STEAM_API_KEY,
  SCHEMA_TTL_MS,
  RARITY_TTL_MS,
} = require('../config');

const PLACEHOLDER_REFRESH_MS = 24 * 60 * 60 * 1000;
const APP_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const STEAM_API = log.tag('STEAM');

/**
 * Accepts a Steam profile URL, vanity name, or numeric ID and returns a value suitable for API calls.
 */
function parseSteamIdish(input) {
  const trimmed = input.trim();
  const mProfiles = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (mProfiles) return mProfiles[1];
  const mId = trimmed.match(/^\d{17}$/);
  if (mId) return mId[0];
  const mVanity = trimmed.match(/steamcommunity\.com\/id\/([\w-_.]+)/i);
  if (mVanity) return mVanity[1];
  return trimmed;
}

/** Resolves vanity URLs or profile links into a 64-bit Steam ID. */
async function resolveSteamId(input) {
  const idish = parseSteamIdish(input);
  if (/^\d{17}$/.test(idish)) return idish;
  const url = `${STEAM_HOST}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&vanityurl=${encodeURIComponent(idish)}`;
  const t = time('HTTP:ResolveVanityURL');
  const { data } = await axios.get(url, { timeout: 15000 });
  t.end();
  const ok = data?.response?.success === 1 && data.response.steamid;
  STEAM_API.info(`resolveSteamId("${idish}") -> ${ok ? data.response.steamid : 'NOT FOUND'}`);
  return ok ? data.response.steamid : null;
}

/** Returns the list of recently played games along with playtime aggregates. */
async function getRecentlyPlayed(steamId) {
  const url = `${STEAM_HOST}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(steamId)}`;
  const t = time('HTTP:GetRecentlyPlayedGames');
  const { data } = await axios.get(url, { timeout: 15000 });
  t.end();
  const games = data?.response?.games || [];
  STEAM_API.debug(`recentlyPlayed steam=${steamId} -> ${games.length} games`);
  const normalized = games.map(g => ({
    appid: g.appid,
    name: g.name,
    playtime_2weeks: g.playtime_2weeks || 0,
    playtime_forever: g.playtime_forever || 0,
  }));
  await cacheObservedAppNames(normalized, 'recently_played');
  return normalized;
}

/** Fetches the current game (if any) a user is playing. */
async function getCurrentGame(steamId) {
  const url = `${STEAM_HOST}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`;
  const t = time('HTTP:GetPlayerSummaries');
  const { data } = await axios.get(url, { timeout: 10000 });
  t.end();
  const p = data?.response?.players?.[0];
  if (p?.gameid) {
    const appid = Number(p.gameid);
    const name = p.gameextrainfo || `App ${p.gameid}`;
    await cacheAppName(appid, name, 'observed');
    return { appid, name };
  }
  return null;
}

/** Direct call to Steam for the full schema payload. Use `getSchema` for the cached version. */
async function fetchSchemaRaw(appid) {
  const url = `${STEAM_HOST}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&appid=${appid}&l=en`;
  const t = time('HTTP:GetSchemaForGame');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  return data?.game || null;
}

/** Fetches and caches the schema for a game, storing a snapshot in MySQL. */
async function fetchSchema(appid) {
  const schema = await fetchSchemaRaw(appid);
  if (schema) {
    const achCount = schema?.availableGameStats?.achievements?.length || 0;
    await dbRun(
      'INSERT INTO app_schema (appid, fetched_at, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE fetched_at=VALUES(fetched_at), payload=VALUES(payload)',
      [appid, Date.now(), JSON.stringify({ ...schema, _achCount: achCount })]
    );
    log.tag('SCHEMA').debug(`cached appid=${appid} (achievements=${achCount})`);
  } else {
    log.tag('SCHEMA').warn(`no schema for appid=${appid}`);
  }
  return { schema };
}

/** Retrieves a cached schema if it has not expired. */
async function getSchemaFromCache(appid) {
  const row = await dbGet('SELECT payload, fetched_at FROM app_schema WHERE appid = ?', [appid]);
  const stale = row ? (Date.now() - Number(row.fetched_at) > SCHEMA_TTL_MS) : false;
  if (!row || stale) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

/** Returns a schema, loading from Steam when the cache is cold or stale. */
async function getSchema(appid) {
  return (await getSchemaFromCache(appid)) || (await fetchSchema(appid)).schema;
}

/** Fetches a player's achievements for the given app and normalises the shape. */
async function getPlayerAchievements(steamId, appid) {
  const url = `${STEAM_HOST}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${steamId}&appid=${appid}&l=en`;
  const t = time('HTTP:GetPlayerAchievements');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  const list = data?.playerstats?.achievements || [];
  STEAM_API.debug(`achievements steam=${steamId} appid=${appid} -> ${list.length} entries`);
  return list.map(a => ({ apiName: a.apiname, achieved: a.achieved === 1, unlocktime: a.unlocktime || 0 }));
}

function isAppNamePlaceholder(name, appid) {
  if (!name || !String(name).trim()) return true;
  const normalized = String(name).trim();
  if (normalized === `App ${appid}`) return true;
  if (/^ValveTestApp\d+$/i.test(normalized)) return true;
  return false;
}

async function cacheAppName(appid, name, source) {
  if (!name || isAppNamePlaceholder(name, appid)) return;
  try {
    await dbRun(
      'INSERT INTO app_names (appid, name, source, fetched_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), source=VALUES(source), fetched_at=VALUES(fetched_at)',
      [appid, name, source, Date.now()]
    );
  } catch (err) {
    STEAM_API.debug(`cache app name failed appid=${appid}: ${err?.message || err}`);
  }
}

async function getCachedAppName(appid) {
  const row = await dbGet('SELECT name, fetched_at FROM app_names WHERE appid = ?', [appid]);
  if (!row) return { name: null, stale: false };
  const fetchedAt = Number(row.fetched_at) || 0;
  const stale = Date.now() - fetchedAt > APP_NAME_TTL_MS;
  const name = row.name || null;
  if (!name || isAppNamePlaceholder(name, appid)) return { name: null, stale };
  return { name, stale };
}

async function fetchAppNameFromStore(appid) {
  try {
    const t = time('HTTP:StoreAppDetails');
    const { data } = await axios.get('https://store.steampowered.com/api/appdetails', {
      params: { appids: appid, l: 'en' },
      timeout: 15000,
    });
    t.end();

    const payload = data?.[appid];
    if (!payload || payload.success === false) return null;
    const name = payload?.data?.name || payload?.data?.common?.name || null;
    if (name && !isAppNamePlaceholder(name, appid)) {
      await cacheAppName(appid, name, 'store');
      return name;
    }
  } catch (err) {
    STEAM_API.debug(`store appdetails failed appid=${appid}: ${err?.message || err}`);
  }
  return null;
}

/**
 * Returns the app name when it exists in the cached schema; optionally refreshes when the cache is
 * missing, placeholder-like, or old so embeds can recover from stale schema entries.
 */
async function getAppNameCached(appid, { refreshIfPlaceholder = false } = {}) {
  const { name: cachedStoreName, stale: storeStale } = await getCachedAppName(appid);
  if (cachedStoreName && !storeStale) return cachedStoreName;

  const row = await dbGet('SELECT payload, fetched_at FROM app_schema WHERE appid = ?', [appid]);

  let cachedSchemaName = null;
  let fetchedAt = null;
  if (row) {
    fetchedAt = Number(row.fetched_at) || null;
    try {
      const parsed = JSON.parse(row.payload);
      cachedSchemaName = parsed?.gameName || parsed?.game?.gameName || null;
    } catch (err) {
      STEAM_API.debug(`schema cache parse failed appid=${appid}: ${err?.message || err}`);
    }
  }

  const cacheAge = fetchedAt ? Date.now() - fetchedAt : null;
  const schemaPlaceholder = isAppNamePlaceholder(cachedSchemaName, appid);
  const refreshSchema = refreshIfPlaceholder && (schemaPlaceholder || (cacheAge !== null && cacheAge > PLACEHOLDER_REFRESH_MS));

  if (!cachedStoreName || storeStale || (refreshIfPlaceholder && isAppNamePlaceholder(cachedStoreName, appid))) {
    const storeName = await fetchAppNameFromStore(appid);
    if (storeName) return storeName;
  }

  if (cachedSchemaName && !schemaPlaceholder) {
    await cacheAppName(appid, cachedSchemaName, 'schema');
    return cachedSchemaName;
  }

  if (refreshSchema) {
    const { schema } = await fetchSchema(appid);
    const freshName = schema?.gameName || schema?.game?.gameName;
    if (freshName && !isAppNamePlaceholder(freshName, appid)) {
      await cacheAppName(appid, freshName, 'schema');
      return freshName;
    }
  }

  if (cachedStoreName) return cachedStoreName;
  return `App ${appid}`;
}

/**
 * Retrieves global achievement rarity data, caching results for a configurable amount of time to
 * avoid hammering the API.
 */
async function getGlobalRarity(appid) {
  const staleSince = Date.now() - RARITY_TTL_MS;
  const anyFresh = await dbGet('SELECT 1 AS ok FROM global_ach_pct WHERE appid=? AND fetched_at>=? LIMIT 1', [appid, staleSince]);
  if (!anyFresh) {
    try {
      const url = `${STEAM_HOST}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
      const t = time('HTTP:GetGlobalAchievementPercentages');
      const { data } = await axios.get(url, { timeout: 15000 });
      t.end();
      const list = data?.achievementpercentages?.achievements || [];
      if (list.length) {
        const now = Date.now();
        for (const a of list) {
          await dbRun(
            'INSERT INTO global_ach_pct (appid, api_name, pct, fetched_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pct=VALUES(pct), fetched_at=VALUES(fetched_at)',
            [appid, a.name, Number(a.percent || a.Pct || 0), now]
          );
        }
      }
    } catch (e) {
      log.tag('RARITY').warn(`fetch failed appid=${appid}: ${e?.message}`);
    }
  }
  const rows = await dbAll('SELECT api_name, pct FROM global_ach_pct WHERE appid=?', [appid]);
  const map = new Map();
  rows.forEach(r => map.set(r.api_name, Number(r.pct)));
  return map;
}

/** Fetches the full list of owned games, including playtime and icon hashes. */
async function getOwnedGames(steamId) {
  const url = `${STEAM_HOST}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1`;
  const t = time('HTTP:GetOwnedGames');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  const games = data?.response?.games || [];
  if (!games.length) {
    log.tag('STEAM').warn(`ownedGames steam=${steamId} -> 0 games (library may be private)`);
  } else {
    log.tag('STEAM').debug(`ownedGames steam=${steamId} -> ${games.length} games`);
  }
  const normalized = games.map(g => ({
    appid: g.appid,
    name: g.name,
    img_icon_url: g.img_icon_url || null,
    playtime_forever: g.playtime_forever || 0
  }));
  await cacheObservedAppNames(normalized, 'owned');
  return normalized;
}

/**
 * Attempts to fetch an install size estimate for a given app ID using public SteamCMD metadata.
 * Not every app exposes size information; in those cases `null` is returned so callers can
 * gracefully report partial coverage.
 */
async function getAppInstallSize(appid) {
  try {
    const t = time('HTTP:SteamCMD:info');
    const { data } = await axios.get(`https://api.steamcmd.net/v1/info/${appid}`, { timeout: 20000 });
    t.end();

    const appData = data?.data?.[appid];
    const depots = appData?.data?.depots || appData?.depots;
    if (!depots || typeof depots !== 'object') return null;

    let total = 0;
    let counted = 0;
    for (const [depotId, depot] of Object.entries(depots)) {
      if (!/^\d+$/.test(depotId)) continue;
      const manifestSize = depot?.manifests?.public?.size || depot?.manifests?.public?.size_original;
      const depotSize = depot?.maxsize || depot?.size || manifestSize;
      if (Number.isFinite(depotSize)) {
        total += Number(depotSize);
        counted += 1;
      }
    }
    return counted > 0 ? total : null;
  } catch (err) {
    STEAM_API.debug(`size fetch failed appid=${appid}: ${err?.message || err}`);
    return null;
  }
}

module.exports = {
  parseSteamIdish,
  resolveSteamId,
  getRecentlyPlayed,
  getCurrentGame,
  getSchema,
  getSchemaFromCache,
  getPlayerAchievements,
  getAppNameCached,
  getGlobalRarity,
  getOwnedGames,
  getAppInstallSize,
};
