/* Steam storefront browsing — tag catalogue + search results for games the user
   doesn't own. Uses the store's own search endpoint (the same one the website's
   infinite scroll calls); SteamSpy's tag/genre browsing endpoints no longer return data. */

const db = require('../db/database');

const STORE = 'https://store.steampowered.com';
const UA = 'Mozilla/5.0 (compatible; ShelfLife/1.0; +https://github.com/Lebbitheplow/shelflife)';
const TAG_MAP_TTL_S = 7 * 86400;
const STORE_COUNTRY = () => (process.env.STORE_COUNTRY || 'us').toLowerCase();

// Mature-content descriptor ids the store attaches to search rows; 3 = adult-only sexual content
const EXCLUDED_DESCRIPTORS = new Set([3]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// name → tagid, and tagid → name, from Steam's public popular-tags list (~430 tags)
async function getTagMap() {
  const cached = db.getKV('steam_tag_map', TAG_MAP_TTL_S);
  if (cached) return cached;
  const res = await fetch(`${STORE}/tagdata/populartags/english`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Steam tagdata error ${res.status}`);
  const list = await res.json();
  const byName = {};
  const byId = {};
  for (const t of list) {
    if (!t?.tagid || !t?.name) continue;
    byName[t.name.toLowerCase()] = t.tagid;
    byId[t.tagid] = t.name;
  }
  const map = { byName, byId };
  db.setKV('steam_tag_map', map);
  return map;
}

// Parse the results_html blob into plain objects. Each row carries the appid, its
// top tag ids, price (cents), discount %, review summary and release date.
function parseSearchResults(html, tagById = {}) {
  const rows = [];
  const chunks = String(html).split('<a href=').slice(1);
  for (const chunk of chunks) {
    const appid = parseInt(chunk.match(/data-ds-appid="(\d+)"/)?.[1]);
    if (!appid) continue; // bundles/packages carry data-ds-packageid instead
    const tagIds = JSON.parse(chunk.match(/data-ds-tagids="(\[[^"]*\])"/)?.[1] || '[]');
    const descIds = JSON.parse(chunk.match(/data-ds-descids="(\[[^"]*\])"/)?.[1] || '[]');
    const name = decodeEntities(chunk.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1]?.trim() || '');
    const finalCents = parseInt(chunk.match(/data-price-final="(\d+)"/)?.[1]);
    const discount = parseInt(chunk.match(/data-discount="(\d+)"/)?.[1]) || 0;
    const tooltip = decodeEntities(chunk.match(/data-tooltip-html="([^"]*)"/)?.[1] || '');
    const reviewMatch = tooltip.match(/(\d+)% of the ([\d,]+) user reviews/);
    const summary = tooltip.split('<br>')[0] || null;
    const released = chunk.match(/search_released[^>]*>\s*([^<]*?)\s*</)?.[1] || null;
    const capsule = chunk.match(/<img src="([^"]+)"/)?.[1] || null;
    const reviewTotal = reviewMatch ? parseInt(reviewMatch[2].replace(/,/g, '')) : null;
    const reviewPct = reviewMatch ? parseInt(reviewMatch[1]) : null;

    rows.push({
      appid,
      name,
      tagIds,
      tags: tagIds.map(id => tagById[id]).filter(Boolean),
      descIds,
      adultOnly: descIds.some(d => EXCLUDED_DESCRIPTORS.has(d)),
      finalCents: Number.isFinite(finalCents) ? finalCents : null,
      discountPercent: discount,
      reviewPct,
      reviewTotal,
      reviewSummary: reviewMatch ? summary : null,
      released,
      capsule,
    });
  }
  return rows;
}

// One page of store search. `tagIds` are AND-ed by Steam, so callers pass one tag
// at a time for breadth. filter: 'topsellers' | 'globaltopsellers' | 'popularnew' | ''.
async function searchStore({ tagIds = [], specials = false, filter = 'topsellers', start = 0, count = 100, tagById } = {}) {
  const params = new URLSearchParams({
    query: '', start: String(start), count: String(count),
    category1: '998',          // games only — no DLC, soundtracks, software
    infinite: '1', json: '1', ndl: '1',
    cc: STORE_COUNTRY(), l: 'en',
    supportedlang: 'english',
  });
  if (tagIds.length) params.set('tags', tagIds.join(','));
  if (specials) params.set('specials', '1');
  if (filter) params.set('filter', filter);

  const res = await fetch(`${STORE}/search/results/?${params}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Steam search error ${res.status}`);
  const json = await res.json();
  if (!json?.results_html) return { total: 0, rows: [] };
  return { total: json.total_count || 0, rows: parseSearchResults(json.results_html, tagById) };
}

// Format a cents amount in the store currency ("$24.99", "€19,99" approximated as "€19.99")
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', JPY: '¥', BRL: 'R$', PLN: 'zł' };
function formatPrice(cents, currency = 'USD') {
  if (cents == null) return null;
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  const amount = (cents / 100).toFixed(currency === 'JPY' ? 0 : 2);
  return `${sym}${amount}`;
}

module.exports = { getTagMap, searchStore, parseSearchResults, formatPrice, sleep, STORE_COUNTRY };
