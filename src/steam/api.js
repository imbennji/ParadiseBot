const axios = require('axios').default;
const { log, time } = require('../logger');
const { dbRun, dbGet, dbAll } = require('../db');
const {
  STEAM_HOST,
  STEAM_API_KEY,
  SCHEMA_TTL_MS,
  RARITY_TTL_MS,
} = require('../config');

const STEAM_API = log.tag('STEAM');

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

async function getRecentlyPlayed(steamId) {
  const url = `${STEAM_HOST}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${encodeURIComponent(steamId)}`;
  const t = time('HTTP:GetRecentlyPlayedGames');
  const { data } = await axios.get(url, { timeout: 15000 });
  t.end();
  const games = data?.response?.games || [];
  STEAM_API.debug(`recentlyPlayed steam=${steamId} -> ${games.length} games`);
  return games.map(g => ({ appid: g.appid, name: g.name, playtime_2weeks: g.playtime_2weeks || 0, playtime_forever: g.playtime_forever || 0 }));
}

async function getCurrentGame(steamId) {
  const url = `${STEAM_HOST}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`;
  const t = time('HTTP:GetPlayerSummaries');
  const { data } = await axios.get(url, { timeout: 10000 });
  t.end();
  const p = data?.response?.players?.[0];
  if (p?.gameid) return { appid: Number(p.gameid), name: p.gameextrainfo || `App ${p.gameid}` };
  return null;
}

async function fetchSchemaRaw(appid) {
  const url = `${STEAM_HOST}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(STEAM_API_KEY)}&appid=${appid}&l=en`;
  const t = time('HTTP:GetSchemaForGame');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  return data?.game || null;
}

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

async function getSchemaFromCache(appid) {
  const row = await dbGet('SELECT payload, fetched_at FROM app_schema WHERE appid = ?', [appid]);
  const stale = row ? (Date.now() - Number(row.fetched_at) > SCHEMA_TTL_MS) : false;
  if (!row || stale) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

async function getSchema(appid) {
  return (await getSchemaFromCache(appid)) || (await fetchSchema(appid)).schema;
}

async function getPlayerAchievements(steamId, appid) {
  const url = `${STEAM_HOST}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(STEAM_API_KEY)}&steamid=${steamId}&appid=${appid}&l=en`;
  const t = time('HTTP:GetPlayerAchievements');
  const { data } = await axios.get(url, { timeout: 20000 });
  t.end();
  const list = data?.playerstats?.achievements || [];
  STEAM_API.debug(`achievements steam=${steamId} appid=${appid} -> ${list.length} entries`);
  return list.map(a => ({ apiName: a.apiname, achieved: a.achieved === 1, unlocktime: a.unlocktime || 0 }));
}

async function getAppNameCached(appid) {
  const s = await getSchemaFromCache(appid);
  if (s?.gameName || s?.game?.gameName) return s.gameName || s.game?.gameName;
  return `App ${appid}`;
}

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
  return games.map(g => ({
    appid: g.appid,
    name: g.name,
    img_icon_url: g.img_icon_url || null,
    playtime_forever: g.playtime_forever || 0
  }));
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
};
