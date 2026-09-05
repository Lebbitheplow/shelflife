/* Store discovery — recommend games the user does NOT own, priced.
   Pipeline: taste profile → browse Steam search by the user's top tags (plus
   on-sale rows) → drop owned/dismissed/adult-only → cheap pre-score on search
   tags → fetch full metadata + price for the shortlist → full score → pools. */

const db = require('../db/database');
const scoring = require('./scoring');
const recommender = require('./recommender');
const steam = require('./steam');
const store = require('./steamstore');
const igdb = require('./igdb');

const TOP_TAGS = 8;              // profile tags to browse
const ROWS_PER_TAG = 100;        // one search page per tag
const SALE_ROWS_PER_TAG = 50;
const SHORTLIST = 60;            // games we fetch full details for
const SEARCH_DELAY_MS = 900;     // be polite to the store search endpoint
const DETAIL_DELAY_MS = 300;
const MIN_REVIEWS = 20;          // ignore games nobody has reviewed yet
const DISCOVER_TTL_S = 12 * 3600; // rebuild when older — sale prices move

const statusKey = steamId => `${steamId}:discover`;
const inFlight = new Map();

function isDiscoverFresh(steamId) {
  const cached = db.getDiscoverCache(steamId);
  return !!cached && (Date.now() / 1000 - cached.builtAt) < DISCOVER_TTL_S;
}

// Cheap first-pass rank using only the ~7 tags a search row exposes
function preScore(row, profile) {
  let s = 0;
  for (const tag of row.tags) s += (profile.tags[tag] || 0) * scoring.clampIdf(profile.tagIDF?.[tag]);
  if (row.reviewPct != null && row.reviewTotal) {
    s += scoring.wilsonLowerBound(Math.round(row.reviewTotal * row.reviewPct / 100), row.reviewTotal) * 1.5;
  }
  if (row.discountPercent) s += 0.3;
  return s;
}

async function gatherCandidates(profile, ownedSet, dismissed, tagMap) {
  const topTags = scoring.topProfileTags(profile, TOP_TAGS * 2)
    .map(t => ({ ...t, tagId: tagMap.byName[t.tag.toLowerCase()] }))
    .filter(t => t.tagId)
    .slice(0, TOP_TAGS);

  const candidates = new Map();
  function absorb(rows, source) {
    for (const r of rows) {
      if (ownedSet.has(r.appid) || dismissed.has(r.appid) || r.adultOnly || !r.name) continue;
      const existing = candidates.get(r.appid);
      if (existing) {
        for (const t of r.tags) if (!existing.tags.includes(t)) existing.tags.push(t);
        existing.hits++;
        if (r.discountPercent) existing.discountPercent = r.discountPercent;
        continue;
      }
      candidates.set(r.appid, { ...r, hits: 1, source });
    }
  }

  const queries = [];
  for (const t of topTags) queries.push({ tagIds: [t.tagId], count: ROWS_PER_TAG, specials: false, label: t.tag });
  for (const t of topTags.slice(0, 5)) queries.push({ tagIds: [t.tagId], count: SALE_ROWS_PER_TAG, specials: true, label: `${t.tag} (sale)` });
  queries.push({ tagIds: [], count: 100, specials: true, label: 'all specials' });

  for (const q of queries) {
    try {
      const { rows } = await store.searchStore({ tagIds: q.tagIds, count: q.count, specials: q.specials, tagById: tagMap.byId });
      absorb(rows, q.label);
    } catch (err) {
      console.warn(`[discover] search failed (${q.label}):`, err.message);
    }
    await store.sleep(SEARCH_DELAY_MS);
  }
  return { candidates: [...candidates.values()], browsedTags: topTags.map(t => t.tag) };
}

function priceBlock(appid, row) {
  const p = db.getStorePrice(appid);
  if (p) {
    return {
      currency: p.currency || 'USD',
      initial: p.initial, final: p.final, discount: p.discount_percent || 0, isFree: !!p.is_free,
      initialFormatted: p.is_free ? 'Free' : store.formatPrice(p.initial, p.currency),
      finalFormatted: p.is_free ? 'Free' : store.formatPrice(p.final, p.currency),
    };
  }
  // Fall back to what the search row said
  if (row?.finalCents != null) {
    const isFree = row.finalCents === 0;
    const initial = row.discountPercent ? Math.round(row.finalCents / (1 - row.discountPercent / 100)) : row.finalCents;
    return {
      currency: 'USD', initial, final: row.finalCents, discount: row.discountPercent || 0, isFree,
      initialFormatted: isFree ? 'Free' : store.formatPrice(initial),
      finalFormatted: isFree ? 'Free' : store.formatPrice(row.finalCents),
    };
  }
  return null;
}

async function buildDiscover(steamId, onProgress = () => {}) {
  const library = db.getUserLibrary(steamId);
  if (!library.length) throw new Error('No library loaded yet');
  const ownedSet = new Set(library.map(g => g.appid));
  const dismissed = db.getDismissals(steamId);

  onProgress('Reading your taste profile…', 0, 0);
  const allMetadata = db.getGameMetadataBatch(library.map(g => g.appid));
  const achievementMap = db.getAchievements(steamId);
  const profile = scoring.buildProfile(library, allMetadata, new Set(), achievementMap);

  onProgress('Browsing the Steam store…', 0, 0);
  const tagMap = await store.getTagMap();
  const { candidates, browsedTags } = await gatherCandidates(profile, ownedSet, dismissed, tagMap);

  const ranked = candidates
    .filter(c => (c.reviewTotal || 0) >= MIN_REVIEWS)
    .map(c => ({ ...c, pre: preScore(c, profile) }))
    .sort((a, b) => b.pre - a.pre);

  // Shortlist: best pre-scored games, guaranteeing some on-sale presence
  const shortlist = [];
  const seen = new Set();
  for (const c of ranked) {
    if (shortlist.length >= SHORTLIST) break;
    shortlist.push(c); seen.add(c.appid);
  }
  for (const c of ranked.filter(c => c.discountPercent > 0 && !seen.has(c.appid)).slice(0, 15)) shortlist.push(c);

  onProgress(`Fetching details (0 / ${shortlist.length})…`, 0, shortlist.length);
  let n = 0;
  for (const c of shortlist) {
    const needsPrice = !db.isStorePriceFresh(c.appid);
    await steam.fetchAppDetails(c.appid, { force: needsPrice && db.isMetadataFresh(c.appid) });
    n++;
    if (n % 5 === 0) onProgress(`Fetching details (${n} / ${shortlist.length})…`, n, shortlist.length);
    await store.sleep(DETAIL_DELAY_MS);
  }

  const appids = shortlist.map(c => c.appid);
  onProgress('Looking up series and completion times…', n, shortlist.length);
  await igdb.enrichLibrary(appids);
  await igdb.fetchTimeToBeat(appids);

  onProgress('Scoring against your taste…', n, shortlist.length);
  const metaRows = db.getGameMetadataBatch(appids);
  const byRow = new Map(shortlist.map(c => [c.appid, c]));
  const scored = [];
  for (const meta of metaRows) {
    if (!meta?.name) continue;
    if (meta.app_type && meta.app_type !== 'game') continue;
    const row = byRow.get(meta.appid);
    const price = priceBlock(meta.appid, row);
    if (!price) continue; // unreleased / region-locked / no price data at all
    const result = scoring.scoreGame(meta, profile, { appid: meta.appid });
    scored.push(recommender.toCard(meta, result, {
      playtime: 0,
      owned: false,
      price,
      reviewSummary: row?.reviewSummary || null,
    }));
  }
  scored.sort((a, b) => b.score - a.score);
  const deduped = recommender.assignDisplayScores(recommender.dedupeByName(scored));

  const pools = {
    picks: recommender.diversify(deduped, 40, 3),
    onSale: recommender.diversify(deduped.filter(g => g.price.discount > 0), 40, 3),
    free: deduped.filter(g => g.price.isFree).slice(0, 20),
    browsedTags,
    currency: deduped[0]?.price.currency || 'USD',
    stats: { candidates: candidates.length, shortlisted: shortlist.length, results: deduped.length },
  };
  db.setDiscoverCache(steamId, pools);
  return pools;
}

// Fire-and-forget job with progress in load_status under "<steamId>:discover"
async function runDiscoverJob(steamId) {
  if (inFlight.has(steamId)) return;
  inFlight.set(steamId, true);
  const key = statusKey(steamId);
  try {
    db.setLoadStatus(key, 'loading', 'Starting store discovery…', 0, 0);
    await buildDiscover(steamId, (msg, p, t) => db.setLoadStatus(key, 'loading', msg, p, t));
    db.setLoadStatus(key, 'done', 'Ready', 1, 1);
  } catch (err) {
    console.error('[discover] job failed:', err.message);
    db.setLoadStatus(key, 'error', 'Store discovery failed: ' + err.message);
  } finally {
    inFlight.delete(steamId);
  }
}

function getDiscoverStatus(steamId) {
  return db.getLoadStatus(statusKey(steamId));
}

// Hide dismissed games from cached pools at read time (same pattern as the library)
function filterDiscover(pools, dismissed) {
  const f = arr => (arr || []).filter(g => !dismissed.has(g.appid));
  return { ...pools, picks: f(pools.picks), onSale: f(pools.onSale), free: f(pools.free) };
}

module.exports = { buildDiscover, runDiscoverJob, getDiscoverStatus, isDiscoverFresh, filterDiscover, preScore, DISCOVER_TTL_S };
