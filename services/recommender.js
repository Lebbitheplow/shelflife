const db = require('../db/database');
const scoring = require('./scoring');

const { parseJSON, LOVED_MIN_MINUTES } = scoring;
const ALMOST_STARTED_MAX = LOVED_MIN_MINUTES; // < 2 hours = candidate

// Tiered sampling mix: mostly top-ranked games, with variety from lower tiers
const SAMPLE_TOP_SHARE = 0.45;
const SAMPLE_MID_SHARE = 0.35;

// Diversity: the featured top 20 shouldn't be five games from one studio
const TOP20_MAX_PER_DEV = 2;

// Gameplay-relevant Steam categories to surface in the genre dropdown
const CATEGORY_ALLOWLIST = new Set([
  'Single-player', 'Multi-player', 'Co-op', 'Online Co-op', 'Local Co-op',
  'PvP', 'Online PvP', 'Local Multi-Player', 'Shared/Split Screen',
  'Shared/Split Screen Co-op', 'Shared/Split Screen PvP',
  'Cross-Platform Multiplayer', 'MMO',
]);

// Shape a metadata row into the card object the frontend renders
function toCard(meta, { score, reasons }, extras = {}) {
  return {
    appid: meta.appid,
    name: meta.name,
    score,
    reasons,
    header_image: meta.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${meta.appid}/header.jpg`,
    tags: parseJSON(meta.tags).slice(0, 8),
    genres: parseJSON(meta.genres),
    categories: parseJSON(meta.categories),
    developers: parseJSON(meta.developers),
    publishers: parseJSON(meta.publishers),
    metacritic_score: meta.metacritic_score,
    steam_positive: meta.steam_positive,
    steam_negative: meta.steam_negative,
    trailer_mp4: meta.trailer_mp4 === 'none' ? null : meta.trailer_mp4,
    short_description: meta.short_description,
    release_date: meta.release_date,
    esrb_rating: meta.esrb_rating,
    // Time-to-beat in seconds (-1 sentinel = looked up, no data → null)
    ttb_normally: meta.ttb_normally > 0 ? meta.ttb_normally : null,
    ttb_completely: meta.ttb_completely > 0 ? meta.ttb_completely : null,
    series: meta.igdb_collection || null,
    ...extras,
  };
}

// Deduplicate by name — keep highest-scored entry (input must be sorted by score desc)
function dedupeByName(sorted) {
  const seen = new Set();
  return sorted.filter(g => {
    const key = g.name?.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Normalize scores to 0–96 relative to the user's actual top scorer, so users can
// gauge confidence intuitively. MIN_SCORE_FLOOR keeps a weak library from being
// inflated to look like 96 — sparse/mismatched libraries show lower scores.
function assignDisplayScores(sorted, floor = 40) {
  const topRaw = Math.max(sorted[0]?.score || 1, floor);
  for (const g of sorted) g.displayScore = Math.round(Math.min(96, (g.score / topRaw) * 96));
  return sorted;
}

// Greedy diversification: walk the ranked list, skipping games whose developer or
// series already appears `maxPer` times. Falls back to plain order if too few remain.
function diversify(ranked, n, maxPer = TOP20_MAX_PER_DEV) {
  const count = {};
  const picked = [];
  for (const g of ranked) {
    if (picked.length >= n) break;
    const keys = (g.developers?.length ? g.developers.map(d => `dev:${d}`) : ['dev:__unknown__']);
    if (g.series) keys.push(`series:${g.series}`);
    if (keys.some(k => (count[k] || 0) >= maxPer)) continue;
    for (const k of keys) count[k] = (count[k] || 0) + 1;
    picked.push(g);
  }
  return picked.length >= Math.min(n, ranked.length) ? picked : ranked.slice(0, n);
}

// Tiered random sample: SAMPLE_TOP_SHARE from the top third, SAMPLE_MID_SHARE
// from the middle third, the remainder from the bottom
function tieredSample(pool, n) {
  if (pool.length <= n) return [...pool];
  const top = pool.slice(0, Math.ceil(pool.length * 0.33));
  const mid = pool.slice(Math.ceil(pool.length * 0.33), Math.ceil(pool.length * 0.66));
  const low = pool.slice(Math.ceil(pool.length * 0.66));

  function randomPick(arr, count) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  const topN = Math.ceil(n * SAMPLE_TOP_SHARE);
  const midN = Math.ceil(n * SAMPLE_MID_SHARE);
  const lowN = n - topN - midN;

  return [
    ...randomPick(top, topN),
    ...randomPick(mid, midN),
    ...randomPick(low, Math.max(0, lowN)),
  ].sort(() => Math.random() - 0.5);
}

function buildRecommendations(steamId, library, allMetadata, reviewedAppids = new Set(), achievementMap = {}, friendsMap = {}) {
  // achievementMap is keyed by appid string → { total, unlocked }
  const profile = scoring.buildProfile(library, allMetadata, reviewedAppids, achievementMap);
  const metadataMap = profile._metadataMap;

  const candidates = library.filter(g => g.playtime_forever < ALMOST_STARTED_MAX);

  const scored = [];
  for (const game of candidates) {
    const meta = metadataMap[game.appid];
    if (!meta || !meta.name) continue;
    scored.push(toCard(meta, scoring.scoreGame(meta, profile, game), {
      playtime: game.playtime_forever,
      friends: friendsMap[game.appid] || null,
    }));
  }

  scored.sort((a, b) => b.score - a.score);
  const deduped = assignDisplayScores(dedupeByName(scored));

  const neverTouched = deduped.filter(g => g.playtime === 0);
  const almostStarted = deduped.filter(g => g.playtime > 0 && g.playtime < ALMOST_STARTED_MAX);

  const genreMap = {};
  for (const g of deduped) {
    for (const genre of g.genres) (genreMap[genre] ||= []).push(g);
    for (const cat of g.categories) if (CATEGORY_ALLOWLIST.has(cat)) (genreMap[cat] ||= []).push(g);
  }
  const byGenre = {};
  for (const [genre, games] of Object.entries(genreMap)) {
    if (games.length >= 2) byGenre[genre] = games.slice(0, 100);
  }

  // Games friends actually play, ordered by popularity among friends then match score
  const friendsPlayed = deduped
    .filter(g => g.friends?.count > 0)
    .sort((a, b) => b.friends.count - a.friends.count || b.score - a.score)
    .slice(0, 100);

  const hoursPlayed = Math.round(library.reduce((sum, g) => sum + (g.playtime_forever || 0), 0) / 60);
  const backlogKnown = neverTouched.filter(g => g.ttb_normally);
  const backlogHours = Math.round(backlogKnown.reduce((sum, g) => sum + g.ttb_normally, 0) / 3600);

  const pools = {
    top20: diversify(deduped, 20),
    topPicks: deduped.slice(0, 500),
    neverTouched: neverTouched.slice(0, 500),
    almostStarted: almostStarted.slice(0, 300),
    friendsPlayed,
    byGenre,
    genres: Object.keys(byGenre).sort((a, b) => genreMap[b].length - genreMap[a].length),
    stats: {
      total: library.length,
      neverPlayed: neverTouched.length,
      almostStarted: almostStarted.length,
      hoursPlayed,
      backlogHours,
      backlogKnownCount: backlogKnown.length,
    },
    profileSummary: scoring.generateProfileSummary(profile, metadataMap, library, achievementMap),
  };

  db.setRecCache(steamId, pools);
  return pools;
}

function samplePools(pools, dismissedAppids = new Set()) {
  function filterPool(arr) {
    return dismissedAppids.size ? arr.filter(g => !dismissedAppids.has(g.appid)) : arr;
  }
  return {
    top20: filterPool(pools.top20),
    topPicks: tieredSample(filterPool(pools.topPicks), 72),
    neverTouched: tieredSample(filterPool(pools.neverTouched), 60),
    almostStarted: tieredSample(filterPool(pools.almostStarted), 60),
    // Keep friend-count order rather than sampling — `|| []` covers caches built before this pool existed
    friendsPlayed: filterPool(pools.friendsPlayed || []).slice(0, 60),
    byGenre: Object.fromEntries(
      Object.entries(pools.byGenre).map(([g, games]) => [g, tieredSample(filterPool(games), 60)])
    ),
    genres: pools.genres,
    stats: pools.stats,
  };
}

module.exports = { buildRecommendations, samplePools, tieredSample, toCard, dedupeByName, assignDisplayScores, diversify };
