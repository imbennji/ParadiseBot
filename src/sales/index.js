const axios = require('axios').default;
const cheerio = require('cheerio');
const { wrapper: axiosCookieJarSupport } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const pLimit = require('p-limit');
const { log, time } = require('../logger');
const { dbRun, dbGet } = require('../db');
const { client } = require('../discord/client');
const {
  SALES_REGION_CC,
  SALES_PAGE_SIZE,
  SALES_PRECACHE_PAGES,
  SALES_PRECACHE_PREV_PAGES,
  SALES_PAGE_TTL_MS,
  SALES_MAX_PAGES_CACHE,
  SALES_PREWARM_SPACING_MS,
  SALES_EXTEND_TTL_ON_HIT,
  SALES_SORT_BY,
  SALES_NAV_COOLDOWN_MS,
  SALES_FULL_WARMER_DELAY_MS,
  SALES_FULL_WARMER_SPACING_MS,
  SALES_POLL_MS,
  STEAM_COLOR,
} = require('../config');
const { CHANNEL_KINDS, getAnnouncementChannel, getConfiguredGuildIds } = require('../discord/channels');

const SALES_TAG = log.tag('SALES');

const storeAxios = axios.create({
  baseURL: 'https://store.steampowered.com',
  timeout: 15_000,
  withCredentials: true,
  headers: {},
});
axiosCookieJarSupport(storeAxios);
storeAxios.defaults.jar = new tough.CookieJar();
storeAxios.defaults.headers.common['User-Agent'] =
  process.env.STORE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
storeAxios.defaults.headers.common['Accept'] = 'application/json, text/javascript, */*; q=0.01';
storeAxios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';
const SEARCH_REFERER = (cc) => `https://store.steampowered.com/search/?specials=1&category1=998&cc=${cc}&l=en`;

let cryptoWeb;
try { cryptoWeb = require('node:crypto').webcrypto; } catch { cryptoWeb = { getRandomValues: (a) => require('crypto').randomFillSync(a) }; }
function randomHex(n) { return [...cryptoWeb.getRandomValues(new Uint8Array(n/2))].map(b=>b.toString(16).padStart(2,'0')).join(''); }

async function bootstrapStoreSession(cc = SALES_REGION_CC) {
  const jar = storeAxios.defaults.jar;
  const sessionid = randomHex(32);
  await jar.setCookie(`sessionid=${sessionid}; Path=/; Secure; SameSite=None; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  await jar.setCookie(`steamCountry=${encodeURIComponent(cc)}%7C0%7C; Path=/; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  await jar.setCookie(`timezoneOffset=0,0; Path=/; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  await jar.setCookie(`birthtime=0; lastagecheckage=1-January-1970; mature_content=1; Path=/; Domain=store.steampowered.com`, 'https://store.steampowered.com');
  try { await storeAxios.get('/', { params: { cc, l: 'en' } }); } catch {}
}
let storeReady = false;
async function ensureStoreSession(cc) {
  if (!storeReady) { await bootstrapStoreSession(cc); storeReady = true; }
}

async function fetchSearchJson(cc, start, count) {
  await ensureStoreSession(cc);
  const params = {
    query: '',
    specials: 1,
    category1: 998,
    cc,
    l: 'en',
    start,
    count,
    infinite: 1,
    force_infinite: 1,
    dynamic_data: 1,
    no_cache: 1,
    sort_by: SALES_SORT_BY,
    _: Date.now(),
  };
  const headers = {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': SEARCH_REFERER(cc),
  };

  const doGet = async () => {
    const { data } = await storeAxios.get('/search/results/', { params, headers });
    if (!data || typeof data !== 'object' || data.success !== 1) {
      throw new Error('Unexpected search response');
    }
    return data;
  };

  try {
    return await doGet();
  } catch (e) {
    if (e.response?.status === 403) {
      SALES_TAG.warn('403 on search; re-bootstrapping session and retrying…');
      await bootstrapStoreSession(cc);
      return await doGet();
    }
    throw e;
  }
}

async function fetchSearchPageHtml(cc, pageIndex) {
  await ensureStoreSession(cc);
  const params = {
    specials: 1,
    category1: 998,
    cc,
    l: 'en',
    page: pageIndex + 1,
    sort_by: SALES_SORT_BY,
    no_cache: 1
  };
  const headers = { 'Referer': SEARCH_REFERER(cc) };
  const { data: html } = await storeAxios.get('/search/', { params, headers, responseType: 'text' });
  return String(html || '');
}

function priceToNumber(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.,]+/g);
  if (!m) return null;
  const raw = m[m.length - 1];
  let digits = raw.replace(/[^\d.,]/g, '');
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  const sepIdx = Math.max(lastComma, lastDot);
  if (sepIdx >= 0) {
    const intPart = digits.slice(0, sepIdx).replace(/[.,]/g, '');
    const fracPart = digits.slice(sepIdx + 1).replace(/[.,]/g, '');
    return parseFloat(`${intPart}.${fracPart}`);
  }
  return parseFloat(digits.replace(/[.,]/g, ''));
}

function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.search_result_row').each((_, el) => {
    const a = $(el);
    const idAttr = a.attr('data-ds-appid');
    if (!idAttr) return;
    const id = Number(String(idAttr).split(',')[0]);
    if (!id || Number.isNaN(id)) return;

    const name = a.find('.title').first().text().trim() || `App ${id}`;

    let discount_percent = 0;
    const pctText = a.find('.search_discount .discount_pct').first().text().trim() || a.find('.discount_pct').first().text().trim();
    if (pctText) discount_percent = Math.abs(parseInt(pctText.replace(/[^\d-]/g,''), 10) || 0);

    let final_price_str = null;
    let original_price_str = null;

    const discBlock = a.find('.discount_block').first();
    if (discBlock.length) {
      const fp = discBlock.find('.discount_final_price').first().text().trim();
      const op = discBlock.find('.discount_original_price').first().text().trim();
      if (fp) final_price_str = fp;
      if (op) original_price_str = op;
    }

    if (!final_price_str) {
      const priceNode = a.find('.search_price').first();
      const txt = priceNode.text().replace(/\s+/g,' ').trim();
      if (txt) {
        const tokens = txt.split(' ').filter(Boolean);
        const nums = tokens.filter(t => /[\d]/.test(t));
        if (nums.length >= 2) {
          original_price_str = nums[0];
          final_price_str = nums[nums.length - 1];
        } else if (nums.length === 1) {
          final_price_str = nums[0];
        } else {
          final_price_str = txt;
        }
      }
    }

    const finalNum = priceToNumber(final_price_str);
    const origNum  = priceToNumber(original_price_str);
    if ((!discount_percent || discount_percent <= 0) && finalNum != null && origNum != null && finalNum < origNum) {
      discount_percent = Math.max(1, Math.round((1 - (finalNum / origNum)) * 100));
    }

    const isDiscounted = discount_percent > 0 || (finalNum != null && origNum != null && finalNum < origNum);
    if (!isDiscounted) return;

    const finalStr = final_price_str || 'Free';
    const urlRaw = (a.attr('href') || '').split('?')[0];
    const url = urlRaw && /\/app\/\d+/.test(urlRaw) ? urlRaw : `https://store.steampowered.com/app/${id}/`;
    out.push({ id, name, discount_percent, final_price_str: finalStr, original_price_str, url });
  });
  return out;
}

const pageCache = new Map();
const pageInflight = new Map();
function lruTouch(key, val) {
  if (pageCache.has(key)) pageCache.delete(key);
  pageCache.set(key, val);
  while (pageCache.size > SALES_MAX_PAGES_CACHE) {
    const firstKey = pageCache.keys().next().value;
    pageCache.delete(firstKey);
  }
}
function cacheDataGet(cc, idx) {
  const key = `${cc}:${idx}`;
  const hit = pageCache.get(key);
  if (hit && hit.until > Date.now()) {
    if (SALES_EXTEND_TTL_ON_HIT) hit.until = Date.now() + SALES_PAGE_TTL_MS;
    lruTouch(key, hit);
    return hit;
  }
  if (hit) pageCache.delete(key);
  return null;
}
function cacheDataSet(cc, idx, items, totalPages) {
  const key = `${cc}:${idx}`;
  const val = { until: Date.now() + SALES_PAGE_TTL_MS, items, totalPages };
  lruTouch(key, val);
  return val;
}

const warmingSet = new Set();
function jitter(ms, j=0.3){ return Math.max(0, Math.round(ms * (1 - j + Math.random()*2*j))); }
function scheduleWarm(cc, idx, delay) {
  const key = `${cc}:${idx}`;
  if (warmingSet.has(key) || cacheDataGet(cc, idx)) return;
  warmingSet.add(key);
  setTimeout(async () => {
    try { await getPageData(cc, idx); SALES_TAG.trace(`prewarm ok ${key}`); }
    catch (e) { SALES_TAG.debug(`prewarm fail ${key}: ${e?.message}`); }
    finally { warmingSet.delete(key); }
  }, delay);
}

function idsOf(items){ return items.map(it => it.id).join(','); }
function sameIds(a,b){ return a && b && idsOf(a) === idsOf(b); }

async function getPageData(cc, pageIndex) {
  const cached = cacheDataGet(cc, pageIndex);
  if (cached) return cached;

  const key = `${cc}:${pageIndex}`;
  if (pageInflight.has(key)) return pageInflight.get(key);

  const fetchPromise = (async () => {
    const start = pageIndex * SALES_PAGE_SIZE;
    const t = time(`SALES:fetch:${cc}:${pageIndex}`);
    const data = await fetchSearchJson(cc, start, SALES_PAGE_SIZE);
    let items = parseSearchHtml(data.results_html || '').slice(0, SALES_PAGE_SIZE);

    const rawTotal = Number(data.total_count);
    let totalPages;
    if (Number.isFinite(rawTotal) && rawTotal > 0) {
      totalPages = Math.max(1, Math.ceil(rawTotal / SALES_PAGE_SIZE));
    } else {
      totalPages = items.length === SALES_PAGE_SIZE ? (pageIndex + 2) : (pageIndex + 1);
    }

    const prev = cacheDataGet(cc, pageIndex - 1);
    if (prev && sameIds(prev.items, items)) {
      try {
        const html = await fetchSearchPageHtml(cc, pageIndex);
        const alt = parseSearchHtml(html);
        if (alt.length) {
          items = alt.slice(0, SALES_PAGE_SIZE);
          if (alt.length < SALES_PAGE_SIZE && totalPages < pageIndex + 1) {
            totalPages = pageIndex + 1;
          }
        }
      } catch (e) {
        SALES_TAG.debug(`fallback page fetch failed p=${pageIndex}: ${e?.message}`);
      }
    }

    t.end();
    const fresh = cacheDataSet(cc, pageIndex, items, totalPages);
    SALES_TAG.trace(`p${pageIndex} ids=`, items.map(i=>i.id).join(','));
    return fresh;
  })();

  pageInflight.set(key, fetchPromise);
  fetchPromise.finally(() => { pageInflight.delete(key); });
  return fetchPromise;
}

function saleItemToLine(it) {
  const off = it.discount_percent ?? 0;
  const fin = (it.final_price_str && it.final_price_str.trim()) || 'Free';
  const orig = it.original_price_str ? ` ~~${it.original_price_str}~~` : '';
  return `**${it.name}** — ${off}% off • ${fin}${orig ? ` ${orig}` : ''} — [Store](${it.url})`;
}

const navEpoch = new Map();
const navState = new Map();
const NAV_STATE_TTL_MS = 10 * 60 * 1000;

function getNavState(messageId) {
  let state = navState.get(messageId);
  if (!state) {
    state = {
      limit: pLimit(1),
      cooldownUntil: 0,
      userCooldowns: new Map(),
      pendingRequests: new Set(),
      inflightKey: null,
      cleanupTimer: null,
    };
    navState.set(messageId, state);
  }

  if (!state.pendingRequests) {
    state.pendingRequests = new Set();
  }

  if (state.cleanupTimer) {
    clearTimeout(state.cleanupTimer);
  }
  const timer = setTimeout(() => {
    if (navState.get(messageId) === state) {
      navState.delete(messageId);
    }
  }, NAV_STATE_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  state.cleanupTimer = timer;

  return state;
}

function refreshCooldowns(state, now = Date.now()) {
  if (state.cooldownUntil && state.cooldownUntil <= now) {
    state.cooldownUntil = 0;
  }
  for (const [userId, until] of state.userCooldowns) {
    if (!until || until <= now) {
      state.userCooldowns.delete(userId);
    }
  }
}

function isUnknownInteractionError(err) {
  if (!err) return false;
  const code = err.code ?? err?.rawError?.code ?? err?.data?.code;
  return code === 10062;
}

async function safeReply(interaction, payload) {
  try {
    await interaction.reply(payload);
    return true;
  } catch (err) {
    if (isUnknownInteractionError(err)) {
      SALES_TAG.debug(`Ignored reply on expired interaction: ${err?.message || err}`);
      return false;
    }
    throw err;
  }
}

async function safeDeferUpdate(interaction) {
  try {
    await interaction.deferUpdate();
    return true;
  } catch (err) {
    if (isUnknownInteractionError(err)) {
      SALES_TAG.debug(`Interaction expired before defer: ${err?.message || err}`);
      return false;
    }
    SALES_TAG.debug(`Failed to defer sales nav interaction: ${err?.message || err}`);
    return false;
  }
}

async function safeEditReply(interaction, payload) {
  try {
    await interaction.editReply(payload);
    return true;
  } catch (err) {
    if (isUnknownInteractionError(err)) {
      SALES_TAG.debug(`Ignored editReply on expired interaction: ${err?.message || err}`);
      return false;
    }
    throw err;
  }
}

async function safeFollowUp(interaction, payload) {
  try {
    await interaction.followUp(payload);
    return true;
  } catch (err) {
    if (isUnknownInteractionError(err)) {
      SALES_TAG.debug(`Ignored followUp on expired interaction: ${err?.message || err}`);
      return false;
    }
    throw err;
  }
}

function buildSalesEmbed(cc, pageIndex, items, totalPages) {
  const lines = items.length ? items.map(saleItemToLine).join('\n\n') : '_No discounted games found._';
  return new EmbedBuilder()
    .setColor(STEAM_COLOR)
    .setTitle(`Steam Game Sales — page ${Math.min(pageIndex+1, totalPages)}/${totalPages}`)
    .setDescription(lines)
    .setFooter({ text: `Showing ${items.length} items • ${SALES_PAGE_SIZE} per page • Region ${cc}` })
    .setTimestamp(new Date());
}
function buildSalesComponents(cc, pageIndex, totalPages, epoch) {
  const prevBtn = new ButtonBuilder()
    .setCustomId(`sales_nav:${cc}:${pageIndex-1}:${epoch}`)
    .setLabel('◀️ Prev')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(pageIndex <= 0);
  const nextBtn = new ButtonBuilder()
    .setCustomId(`sales_nav:${cc}:${pageIndex+1}:${epoch}`)
    .setLabel('Next ▶️')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(pageIndex >= totalPages-1);
  return [ new ActionRowBuilder().addComponents(prevBtn, nextBtn) ];
}

function disableSalesComponentsFromMessage(message) {
  const rows = message?.components;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const disabledRows = [];
  for (const row of rows) {
    const newRow = new ActionRowBuilder();
    for (const component of row.components || []) {
      if (component.type !== 2) continue; // Only buttons are expected.

      const builder = new ButtonBuilder();

      if (component.customId) builder.setCustomId(component.customId);
      if (component.url) builder.setURL(component.url);
      if (component.label) builder.setLabel(component.label);
      if (component.emoji) builder.setEmoji(component.emoji);

      builder.setStyle(component.style);
      if (component.style !== ButtonStyle.Link) {
        builder.setDisabled(true);
      }

      newRow.addComponents(builder);
    }
    if (newRow.components.length > 0) {
      disabledRows.push(newRow);
    }
  }

  return disabledRows;
}

function prewarmAround(cc, pageIndex, totalPages) {
  const upcoming = [];
  for (let i = 1; i <= SALES_PRECACHE_PAGES; i++) {
    const idx = pageIndex + i;
    if (idx >= totalPages) break;
    upcoming.push({ idx, distance: i });
  }
  for (let i = 1; i <= SALES_PRECACHE_PREV_PAGES; i++) {
    const idx = pageIndex - i;
    if (idx < 0) break;
    upcoming.push({ idx, distance: i });
  }
  upcoming
    .sort((a, b) => a.distance - b.distance)
    .forEach(({ idx }, order) => {
      const delay = jitter(SALES_PREWARM_SPACING_MS * (order + 1));
      scheduleWarm(cc, idx, delay);
    });
}

async function ensureSalesMessage(guild, targetChannel = null) {
  const row = await dbGet('SELECT channel_id, message_id FROM sales_msgs WHERE guild_id=?', [guild.id]);
  const configured = await getAnnouncementChannel(guild, CHANNEL_KINDS.SALES);
  const desiredChannel = targetChannel || configured;
  if (!desiredChannel) return null;

  if (!row) {
    const { items, totalPages } = await getPageData(SALES_REGION_CC, 0);
    const embed = buildSalesEmbed(SALES_REGION_CC, 0, items, totalPages);
    const epoch = 1;
    const components = buildSalesComponents(SALES_REGION_CC, 0, totalPages, epoch);
    const msg = await desiredChannel.send({ embeds: [embed], components });
    navEpoch.set(msg.id, epoch);
    prewarmAround(SALES_REGION_CC, 0, totalPages);
    await dbRun('INSERT INTO sales_msgs (guild_id, channel_id, message_id, updated_at) VALUES (?, ?, ?, ?)', [guild.id, desiredChannel.id, msg.id, Math.floor(Date.now()/1000)]);
    return { channel: desiredChannel, messageId: msg.id };
  }

  if (row.channel_id !== desiredChannel.id) {
    try {
      const oldCh = await client.channels.fetch(row.channel_id).catch(()=>null);
      if (oldCh) { const oldMsg = await oldCh.messages.fetch(row.message_id).catch(()=>null); if (oldMsg) await oldMsg.delete().catch(()=>{}); }
    } catch {}
    const { items, totalPages } = await getPageData(SALES_REGION_CC, 0);
    const embed = buildSalesEmbed(SALES_REGION_CC, 0, items, totalPages);
    const epoch = 1;
    const components = buildSalesComponents(SALES_REGION_CC, 0, totalPages, epoch);
    const msg = await desiredChannel.send({ embeds: [embed], components });
    navEpoch.set(msg.id, epoch);
    prewarmAround(SALES_REGION_CC, 0, totalPages);
    await dbRun('UPDATE sales_msgs SET channel_id=?, message_id=?, updated_at=? WHERE guild_id=?', [desiredChannel.id, msg.id, Math.floor(Date.now()/1000), guild.id]);
    return { channel: desiredChannel, messageId: msg.id };
  }

  const ch = await client.channels.fetch(row.channel_id).catch(()=>null);
  if (!ch) return null;
  return { channel: ch, messageId: row.message_id };
}

async function refreshSalesForAllGuilds() {
  const guildIds = await getConfiguredGuildIds();
  for (const gid of guildIds) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;
    const salesCh = await getAnnouncementChannel(guild, CHANNEL_KINDS.SALES);
    if (!salesCh) continue;
    const holder = await ensureSalesMessage(guild, salesCh);
    if (!holder) continue;
    const { channel, messageId } = holder;
    try {
      const { items, totalPages } = await getPageData(SALES_REGION_CC, 0);
      const embed = buildSalesEmbed(SALES_REGION_CC, 0, items, totalPages);
      const epoch = (navEpoch.get(messageId) || 0) + 1;
      const components = buildSalesComponents(SALES_REGION_CC, 0, totalPages, epoch);
      const msg = await channel.messages.fetch(messageId).catch(()=>null);
      if (msg) {
        await msg.edit({ embeds: [embed], components });
        navEpoch.set(messageId, epoch);
        prewarmAround(SALES_REGION_CC, 0, totalPages);
        await dbRun('UPDATE sales_msgs SET updated_at=? WHERE guild_id=?', [Math.floor(Date.now()/1000), gid]);
      } else {
        const newMsg = await channel.send({ embeds: [embed], components });
        navEpoch.set(newMsg.id, epoch);
        prewarmAround(SALES_REGION_CC, 0, totalPages);
        await dbRun('UPDATE sales_msgs SET message_id=?, channel_id=?, updated_at=? WHERE guild_id=?', [newMsg.id, channel.id, Math.floor(Date.now()/1000), gid]);
      }
    } catch (e) {
      SALES_TAG.warn(`refresh failed guild=${gid}: ${e?.message}`);
    }
  }
}

function scheduleSalesLoop(runNow = false) {
  const run = async () => {
    try { await refreshSalesForAllGuilds(); }
    catch (err) { SALES_TAG.error('refreshSalesForAllGuilds error:', err?.stack || err); }
    finally { setTimeout(run, SALES_POLL_MS); }
  };
  SALES_TAG.info(`Sales refresh every ${Math.round(SALES_POLL_MS / 1000)}s`);
  if (runNow) run();
}

async function handleButtonInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('sales_nav:')) return;

  const parts = id.split(':');
  if (parts.length < 4) {
    await safeReply(interaction, { content: 'Malformed button.', ephemeral: true });
    return;
  }

  const cc = parts[1] || SALES_REGION_CC;
  const requestedPageRaw = Number.parseInt(parts[2], 10);
  const requestedPage = Number.isFinite(requestedPageRaw) ? Math.max(0, requestedPageRaw) : null;
  const epoch = Number.parseInt(parts[3], 10);
  const msgId = interaction.message?.id || null;
  const userId = interaction.user?.id || interaction.member?.user?.id || null;

  if (requestedPage === null) {
    await safeReply(interaction, { content: 'Malformed button state.', ephemeral: true });
    return;
  }

  if (!msgId) {
    await safeReply(interaction, { content: 'Missing message context.', ephemeral: true });
    return;
  }

  if (!Number.isFinite(epoch) || epoch <= 0) {
    await safeReply(interaction, { content: 'Malformed button state.', ephemeral: true });
    return;
  }

  const state = getNavState(msgId);
  const now = Date.now();
  refreshCooldowns(state, now);

  let currentEpoch = navEpoch.get(msgId) || 0;
  if (currentEpoch === 0) {
    navEpoch.set(msgId, epoch);
    currentEpoch = epoch;
  }

  if (epoch !== currentEpoch) {
    const message = epoch < currentEpoch
      ? 'Those buttons are a little out of date. Please use the refreshed buttons on the message.'
      : 'Please wait a moment for the current page update to finish.';
    await safeReply(interaction, { content: message, ephemeral: true });
    return;
  }

  if (SALES_NAV_COOLDOWN_MS > 0) {
    if (state.cooldownUntil && state.cooldownUntil > now) {
      await safeReply(interaction, { content: 'Please wait a moment before changing pages again.', ephemeral: true });
      return;
    }
    if (userId) {
      const userUntil = state.userCooldowns.get(userId);
      if (userUntil && userUntil > now) {
        await safeReply(interaction, { content: 'You are clicking a little quickly—please wait just a moment.', ephemeral: true });
        return;
      }
    }
  }

  const requestKey = `${requestedPage}:${epoch}`;
  if (state.pendingRequests.has(requestKey)) {
    await safeReply(interaction, { content: 'Still updating that page. Hang tight!', ephemeral: true });
    return;
  }

  const acked = await safeDeferUpdate(interaction);
  if (!acked) return;

  state.pendingRequests.add(requestKey);

  try {
    await state.limit(async () => {
      state.inflightKey = { key: requestKey, startedAt: Date.now() };
      try {
        if (SALES_NAV_COOLDOWN_MS > 0 && state.cooldownUntil && state.cooldownUntil > Date.now()) {
          return;
        }

        const myEpoch = (navEpoch.get(msgId) || 0) + 1;
        navEpoch.set(msgId, myEpoch);

        const disabledComponents = disableSalesComponentsFromMessage(interaction.message);
        if (disabledComponents.length > 0) {
          const ok = await safeEditReply(interaction, { components: disabledComponents });
          if (!ok) return;
        }

        const data = await getPageData(cc, requestedPage);
        if ((navEpoch.get(msgId) || 0) !== myEpoch) return;

        const embed = buildSalesEmbed(cc, requestedPage, data.items, data.totalPages);
        const components = buildSalesComponents(cc, requestedPage, data.totalPages, myEpoch);
        const edited = await safeEditReply(interaction, { embeds: [embed], components });
        if (!edited) return;

        prewarmAround(cc, requestedPage, data.totalPages);

        if (SALES_NAV_COOLDOWN_MS > 0) {
          const until = Date.now() + SALES_NAV_COOLDOWN_MS;
          state.cooldownUntil = until;
          if (userId) {
            state.userCooldowns.set(userId, until);
          }
        }
      } finally {
        state.inflightKey = null;
      }
    });
  } catch (e) {
    if (isUnknownInteractionError(e)) {
      SALES_TAG.debug(`Sales nav interaction expired mid-update: ${e?.message || e}`);
      state.cooldownUntil = 0;
      if (userId) state.userCooldowns.delete(userId);
      return;
    }
    SALES_TAG.error('button handler error:', e?.stack || e);
    await safeFollowUp(interaction, { content: `Error: ${e.message || e}`, ephemeral: true });
    await safeEditReply(interaction, { content: `Error: ${e.message || e}`, components: [] });
    state.cooldownUntil = 0;
    if (userId) state.userCooldowns.delete(userId);
  } finally {
    state.pendingRequests.delete(requestKey);
  }
}

let fullWarmTimer = null;
function startFullSalesWarm(cc = SALES_REGION_CC) {
  if (fullWarmTimer) return;
  setTimeout(async () => {
    SALES_TAG.info(`Starting full warm for region ${cc}…`);
    try {
      const first = await getPageData(cc, 0);
      const totalPages = first.totalPages;
      let page = 1;
      fullWarmTimer = setInterval(async () => {
        if (page >= totalPages) {
          clearInterval(fullWarmTimer); fullWarmTimer = null; SALES_TAG.info('Full warm complete.');
          return;
        }
        if (!cacheDataGet(cc, page)) {
          try { await getPageData(cc, page); SALES_TAG.trace(`warm ok ${cc}:${page}/${totalPages}`); }
          catch (e) { SALES_TAG.debug(`warm fail ${cc}:${page}: ${e?.message}`); }
        }
        page++;
      }, SALES_FULL_WARMER_SPACING_MS);
    } catch (e) {
      SALES_TAG.warn(`Full warm bootstrap failed: ${e?.message}`);
    }
  }, SALES_FULL_WARMER_DELAY_MS);
}

module.exports = {
  ensureSalesMessage,
  refreshSalesForAllGuilds,
  scheduleSalesLoop,
  handleButtonInteraction,
  startFullSalesWarm,
  getPageData,
};
