const db = require('../db/database');

const ALMOST_STARTED_MAX = 120; // < 2 hours = candidate

function parseJSON(str, fallback = []) {
  try { return JSON.parse(str); } catch { return fallback; }
}


// Build a weighted preference profile from the user's played games
// Also tracks, per-tag and per-dev, which specific game contributed most (for reason attribution)
function buildPreferenceProfile(library, metadataMap, reviewedAppids = new Set(), achievementMap = {}) {
  const tagWeights = {};
  const genreWeights = {};
  const devWeights = {};
  const categoryWeights = {};

  // For reason attribution: tag/dev -> { name, weight } of the best seed game
  const tagSeed = {};   // tag -> { name, appid, weight }
  const devSeed = {};   // dev -> { name, appid, weight }

  const topPlaytime = [...library].sort((a, b) => b.playtime_forever - a.playtime_forever);
  const top30 = new Set(topPlaytime.slice(0, 30).map(g => g.appid));
  const top5 = new Set(topPlaytime.slice(0, 5).map(g => g.appid));
  const recentlyPlayed = new Set(library.filter(g => (g.playtime_2weeks || 0) > 0).map(g => g.appid));

  const lovedGames = library.filter(g => g.playtime_forever >= 120);

  for (const game of lovedGames) {
    const meta = metadataMap[game.appid];
    if (!meta || !meta.name) continue;

    let weight = Math.sqrt(game.playtime_forever);
    if (recentlyPlayed.has(game.appid)) weight *= 1.5;
    if (top30.has(game.appid)) weight *= 1.8;
    if (top5.has(game.appid)) weight *= 2.0;
    if (reviewedAppids.has(game.appid)) weight *= 1.5; // reviewed positively

    // Achievement completion bonus — only counted if game has at least 5 achievements
    const ach = achievementMap[game.appid];
    if (ach && ach.total >= 5) {
      const pct = ach.unlocked / ach.total;
      if (pct >= 0.9) weight *= 1.8;
      else if (pct >= 0.75) weight *= 1.5;
      else if (pct >= 0.5) weight *= 1.25;
      else if (pct >= 0.25) weight *= 1.1;
    }

    const tags = parseJSON(meta.tags);
    for (const tag of tags) {
      tagWeights[tag] = (tagWeights[tag] || 0) + weight;
      if (!tagSeed[tag] || weight > tagSeed[tag].weight) {
        tagSeed[tag] = { name: meta.name, appid: game.appid, weight };
      }
    }

    const genres = parseJSON(meta.genres);
    for (const genre of genres) {
      genreWeights[genre] = (genreWeights[genre] || 0) + weight;
    }

    const devs = parseJSON(meta.developers);
    for (const dev of devs) {
      devWeights[dev] = (devWeights[dev] || 0) + weight;
      if (!devSeed[dev] || weight > devSeed[dev].weight) {
        devSeed[dev] = { name: meta.name, appid: game.appid, weight };
      }
    }

    const cats = parseJSON(meta.categories);
    for (const cat of cats) {
      categoryWeights[cat] = (categoryWeights[cat] || 0) + weight;
    }
  }

  function normalize(map) {
    const max = Math.max(...Object.values(map), 1);
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v / max]));
  }

  return {
    tags: normalize(tagWeights),
    genres: normalize(genreWeights),
    devs: normalize(devWeights),
    categories: normalize(categoryWeights),
    tagSeed,
    devSeed,
    lovedGames,
    reviewedAppids,
  };
}

// Score a candidate game and generate specific reason tags
function scoreGame(meta, profile, game) {
  let score = 0;
  const reasonCandidates = []; // { text, priority }

  const tags = parseJSON(meta.tags);
  const genres = parseJSON(meta.genres);
  const devs = parseJSON(meta.developers);
  const cats = parseJSON(meta.categories);
  const candidateName = meta.name || '';

  // ── Franchise / series detection via IGDB collection ─────────────────
  const candidateCollection = meta.igdb_collection;
  if (candidateCollection) {
    for (const lovedGame of profile.lovedGames) {
      if (lovedGame.appid === game?.appid) continue;
      const lovedMeta = profile._metadataMap?.[lovedGame.appid];
      if (!lovedMeta || lovedMeta.igdb_collection !== candidateCollection) continue;
      const hrs = Math.round(lovedGame.playtime_forever / 60);
      score += 30;
      reasonCandidates.push({
        text: hrs >= 5
          ? `You put ${hrs}h into ${lovedMeta.name}`
          : `In the ${lovedMeta.name} series`,
        priority: 10,
      });
      break;
    }
  }

  // ── Developer familiarity ──────────────────────────────────────────────
  let devScore = 0;
  for (const dev of devs) {
    const w = profile.devs[dev] || 0;
    devScore += w * 15;
    if (w > 0.4) {
      const seed = profile.devSeed[dev];
      reasonCandidates.push({
        text: seed
          ? `More from ${dev} (you loved ${seed.name})`
          : `More from ${dev}`,
        priority: w * 8,
      });
    }
  }
  score += Math.min(devScore, 15);

  // ── Tag overlap (IDF-weighted: rare/niche tags count more than common ones) ──
  let tagScore = 0;
  let bestTagW = 0;
  let bestTag = null;
  for (const tag of tags) {
    const w = profile.tags[tag] || 0;
    if (!w) continue;
    // Normalize IDF to 0–1, floor at 0.1 so no tag is fully silenced
    // Clamp raw IDF: common tags (Singleplayer) → ~0.35 floor, niche tags → up to 1.5 ceiling
    // Avoids the old approach of dividing by maxTagIDF which collapsed common tags to near-zero
    const rawIdf = profile.tagIDF?.[tag] ?? 1;
    const normIdf = Math.max(0.35, Math.min(1.5, rawIdf));
    const effective = w * normIdf;
    tagScore += effective * 4;
    if (effective > bestTagW) { bestTagW = effective; bestTag = tag; }
  }
  score += Math.min(tagScore, 40);

  // ── Specific game similarity (Jaccard tag overlap with loved games) ────
  // Find the loved game most similar to this candidate by shared tags.
  // Requires 4+ shared tags so generic overlap (RPG, Action) doesn't trigger it.
  const candidateTagSet = new Set(tags);
  let bestSimilarGame = null;
  let bestSimilarity = 0;
  let bestSimilarPlaytime = 0;

  for (const lovedGame of profile.lovedGames) {
    if (lovedGame.appid === game?.appid) continue;
    const lovedMeta = profile._metadataMap?.[lovedGame.appid];
    if (!lovedMeta) continue;
    const lovedTags = parseJSON(lovedMeta.tags || '[]');
    if (!lovedTags.length) continue;

    const sharedCount = lovedTags.filter(t => candidateTagSet.has(t)).length;
    if (sharedCount < 4) continue; // require meaningful overlap

    const union = new Set([...tags, ...lovedTags]).size;
    const jaccard = union > 0 ? sharedCount / union : 0;

    // Tiebreak by playtime — prefer the game the user played most
    const score_sim = jaccard + lovedGame.playtime_forever / 1_000_000;
    if (score_sim > bestSimilarity) {
      bestSimilarity = score_sim;
      bestSimilarGame = lovedMeta;
      bestSimilarPlaytime = lovedGame.playtime_forever;
    }
  }

  if (bestSimilarGame && bestSimilarity >= 0.25) {
    const hrs = Math.round(bestSimilarPlaytime / 60);
    reasonCandidates.push({
      text: hrs >= 5
        ? `You put ${hrs}h into ${bestSimilarGame.name}`
        : `Similar to ${bestSimilarGame.name}`,
      priority: bestSimilarity * 10,
    });
  } else if (bestTag && bestTagW > 0.4) {
    // Fall back to generic tag reason if no strong game match
    reasonCandidates.push({ text: `Matches your ${bestTag} taste`, priority: bestTagW * 3 });
  }

  // ── Genre match ────────────────────────────────────────────────────────
  let genreScore = 0;
  let bestGenreW = 0, bestGenre = null;
  for (const genre of genres) {
    const w = profile.genres[genre] || 0;
    genreScore += w * 5;
    if (w > bestGenreW) { bestGenreW = w; bestGenre = genre; }
  }
  score += Math.min(genreScore, 20);
  if (bestGenre && bestGenreW > 0.45) {
    reasonCandidates.push({ text: `Fits your ${bestGenre} preference`, priority: bestGenreW * 1.8 });
  }

  // ── Category match ─────────────────────────────────────────────────────
  const SOCIAL_CATS = ['Co-op', 'Online Co-op', 'Multi-player', 'Local Co-op', 'MMO'];
  let catScore = 0;
  for (const cat of cats) {
    const w = profile.categories[cat] || 0;
    catScore += w * 2.5;
    if (SOCIAL_CATS.includes(cat) && w > 0.5) {
      reasonCandidates.push({ text: `You enjoy ${cat} games`, priority: w * 1.2 });
    }
  }
  score += Math.min(catScore, 10);

  // ── Metacritic bonus ───────────────────────────────────────────────────
  if (meta.metacritic_score >= 90) {
    score += 5;
    reasonCandidates.push({ text: `Critically acclaimed · ${meta.metacritic_score} MC`, priority: 3 });
  } else if (meta.metacritic_score >= 80) {
    score += 3;
    reasonCandidates.push({ text: `Highly rated · ${meta.metacritic_score} MC`, priority: 2 });
  }

  // ── Steam community score ──────────────────────────────────────────────
  if (meta.steam_positive != null && meta.steam_negative != null) {
    const total = meta.steam_positive + meta.steam_negative;
    if (total > 500) {
      const pct = meta.steam_positive / total;
      if (pct >= 0.95) { score += 4; reasonCandidates.push({ text: 'Overwhelmingly positive reviews', priority: 2.5 }); }
      else if (pct >= 0.85) { score += 2; reasonCandidates.push({ text: 'Very positive reviews', priority: 1.5 }); }
    }
  }

  // ── Release recency bonus ──────────────────────────────────────────────
  if (meta.release_date) {
    const year = parseInt((meta.release_date.match(/\d{4}/) || [])[0]);
    if (year) {
      const age = new Date().getFullYear() - year;
      if (age <= 1) { score += 5; reasonCandidates.push({ text: 'Recently released', priority: 1.5 }); }
      else if (age <= 2) score += 3;
      else if (age <= 3) score += 1;
    }
  }

  // Top 3 niche matching tags as supplemental reasons (lower priority, fills slots 4–6)
  const topMatchTags = tags
    .map(t => {
      const w = profile.tags[t] || 0;
      if (!w) return null;
      const idf = Math.max(0.35, Math.min(1.5, profile.tagIDF?.[t] ?? 1));
      return { tag: t, effective: w * idf };
    })
    .filter(x => x && x.effective > 0.3 && x.tag !== bestTag)
    .sort((a, b) => b.effective - a.effective)
    .slice(0, 3);
  for (const { tag, effective } of topMatchTags) {
    reasonCandidates.push({ text: `Matches your ${tag} taste`, priority: effective * 1.5 });
  }

  // Pick top 6 reasons by priority
  reasonCandidates.sort((a, b) => b.priority - a.priority);
  const reasons = reasonCandidates.slice(0, 6).map(r => r.text);

  // Fallback reason if nothing specific fired
  if (!reasons.length) {
    const topTag = tags[0];
    if (topTag) reasons.push(`Matches your ${topTag} taste`);
  }

  return { score, reasons };
}

// Build a human-readable taste profile summary (up to 6 interest statements)
function generateProfileSummary(profile, metadataMap, library, achievementMap = {}) {
  const candidates = []; // { text, priority, category }

  // ── Top genres ────────────────────────────────────────────────────────
  const topGenres = Object.entries(profile.genres)
    .filter(([, w]) => w > 0.45)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [genre, w] of topGenres) {
    candidates.push({ text: `Loves ${genre} games`, priority: w * 5, cat: 'genre' });
  }

  // ── Top niche tags (IDF-weighted so common ones don't dominate) ───────
  const tagEffectives = Object.entries(profile.tags)
    .map(([tag, w]) => {
      const rawIdf = profile.tagIDF?.[tag] ?? 1;
      const idf = Math.max(0.35, Math.min(1.5, rawIdf));
      return { tag, w, effective: w * idf };
    })
    .filter(x => x.effective > 0.35)
    .sort((a, b) => b.effective - a.effective)
    .slice(0, 6);
  for (const { tag, effective } of tagEffectives) {
    const seed = profile.tagSeed?.[tag];
    const text = seed
      ? `Into ${tag} — ${seed.name} is a favourite`
      : `Into ${tag} games`;
    candidates.push({ text, priority: effective * 3, cat: 'tag' });
  }

  // ── Developer loyalty ─────────────────────────────────────────────────
  const topDevs = Object.entries(profile.devs)
    .filter(([, w]) => w > 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  for (const [dev, w] of topDevs) {
    const seed = profile.devSeed?.[dev];
    const text = seed
      ? `Fan of ${dev} — loved ${seed.name}`
      : `Fan of ${dev}`;
    candidates.push({ text, priority: w * 4, cat: 'dev' });
  }

  // ── Most-played games ─────────────────────────────────────────────────
  const topPlayed = [...library]
    .filter(g => g.playtime_forever >= 600)
    .sort((a, b) => b.playtime_forever - a.playtime_forever)
    .slice(0, 4);
  for (const game of topPlayed) {
    const meta = metadataMap[game.appid];
    if (!meta?.name) continue;
    const hrs = Math.round(game.playtime_forever / 60);
    candidates.push({ text: `${hrs}h in ${meta.name}`, priority: Math.sqrt(game.playtime_forever) * 0.6, cat: 'playtime' });
  }

  // ── Achievement hunter ────────────────────────────────────────────────
  for (const [appidStr, ach] of Object.entries(achievementMap)) {
    if (ach.total < 10) continue;
    const pct = ach.unlocked / ach.total;
    if (pct < 0.85) continue;
    const meta = metadataMap[parseInt(appidStr)];
    if (!meta?.name) continue;
    candidates.push({
      text: `Achievement hunter — ${Math.round(pct * 100)}% done in ${meta.name}`,
      priority: pct * 4,
      cat: 'ach',
    });
  }

  // Sort by priority, then cap per-category to avoid all interests being the same type
  candidates.sort((a, b) => b.priority - a.priority);
  const catCounts = {};
  const CAT_CAPS = { genre: 2, tag: 2, dev: 1, playtime: 2, ach: 1 };
  const result = [];
  for (const c of candidates) {
    if (result.length >= 6) break;
    const cap = CAT_CAPS[c.cat] ?? 2;
    const used = catCounts[c.cat] || 0;
    if (used >= cap) continue;
    catCounts[c.cat] = used + 1;
    result.push(c.text);
  }
  return result;
}

// Tiered random sample: 45% top, 35% mid, 20% lower
function tieredSample(pool, n) {
  if (pool.length <= n) return [...pool];
  const top = pool.slice(0, Math.ceil(pool.length * 0.33));
  const mid = pool.slice(Math.ceil(pool.length * 0.33), Math.ceil(pool.length * 0.66));
  const low = pool.slice(Math.ceil(pool.length * 0.66));

  function randomPick(arr, count) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  const topN = Math.ceil(n * 0.45);
  const midN = Math.ceil(n * 0.35);
  const lowN = n - topN - midN;

  return [
    ...randomPick(top, topN),
    ...randomPick(mid, midN),
    ...randomPick(low, Math.max(0, lowN)),
  ].sort(() => Math.random() - 0.5);
}

function buildRecommendations(steamId, library, allMetadata, reviewedAppids = new Set(), achievementMap = {}) {
  // achievementMap is keyed by appid string → { total, unlocked }
  const metadataMap = {};
  for (const m of allMetadata) {
    if (m) metadataMap[m.appid] = m;
  }

  // Compute tag IDF: rare/niche tags get higher weight than ubiquitous ones (e.g. "Singleplayer")
  const tagDF = {};
  const totalDocs = allMetadata.filter(m => m).length || 1;
  for (const m of allMetadata) {
    if (!m) continue;
    const seen = new Set(parseJSON(m.tags));
    for (const tag of seen) tagDF[tag] = (tagDF[tag] || 0) + 1;
  }
  const tagIDF = {};
  for (const [tag, df] of Object.entries(tagDF)) {
    tagIDF[tag] = Math.log((totalDocs + 1) / (df + 1));
  }
  // maxTagIDF kept for reference but scoring now uses clamped raw IDF (see scoreGame)
  const maxTagIDF = Math.max(...Object.values(tagIDF), 1);

  const profile = buildPreferenceProfile(library, metadataMap, reviewedAppids, achievementMap);
  profile.tagIDF = tagIDF;
  profile.maxTagIDF = maxTagIDF;

  // Attach metadata map and loved game names so scoreGame can do franchise detection
  profile._metadataMap = metadataMap;
  // Pre-attach names to lovedGames for franchise detection
  for (const g of profile.lovedGames) {
    const m = metadataMap[g.appid];
    if (m) g._name = m.name;
  }

  const candidates = library.filter(g => g.playtime_forever < ALMOST_STARTED_MAX);

  const scored = [];
  for (const game of candidates) {
    const meta = metadataMap[game.appid];
    if (!meta || !meta.name) continue;
    const { score, reasons } = scoreGame(meta, profile, game);
    scored.push({
      appid: game.appid,
      name: meta.name,
      playtime: game.playtime_forever,
      score,
      reasons,
      header_image: meta.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
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
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Deduplicate by name — keep highest-scored entry (first after sort)
  const seenNames = new Set();
  const deduped = scored.filter(g => {
    const key = g.name?.toLowerCase().trim();
    if (!key || seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  // Normalize scores to 0–96 range relative to user's actual top scorer.
  // Top game ≈ 92–96, so users can gauge recommendation confidence intuitively.
  // Falls back to raw score if pool is empty.
  // MIN_SCORE_FLOOR: if the best raw score doesn't clear this, scores compress downward
  // rather than inflating a weak library to look like 96. A well-matched library
  // naturally clears 40+ and gets full range; sparse/mismatched libraries show lower scores.
  const MIN_SCORE_FLOOR = 40;
  const topRaw = Math.max(deduped[0]?.score || 1, MIN_SCORE_FLOOR);
  for (const g of deduped) {
    g.displayScore = Math.round(Math.min(96, (g.score / topRaw) * 96));
  }

  const neverTouched = deduped.filter(g => g.playtime === 0);
  const almostStarted = deduped.filter(g => g.playtime > 0 && g.playtime < ALMOST_STARTED_MAX);

  // Gameplay-relevant Steam categories to surface in the genre dropdown
  const CATEGORY_ALLOWLIST = new Set([
    'Single-player', 'Multi-player', 'Co-op', 'Online Co-op', 'Local Co-op',
    'PvP', 'Online PvP', 'Local Multi-Player', 'Shared/Split Screen',
    'Shared/Split Screen Co-op', 'Shared/Split Screen PvP',
    'Cross-Platform Multiplayer', 'MMO',
  ]);

  const genreMap = {};
  for (const g of deduped) {
    for (const genre of g.genres) {
      if (!genreMap[genre]) genreMap[genre] = [];
      genreMap[genre].push(g);
    }
    for (const cat of g.categories) {
      if (!CATEGORY_ALLOWLIST.has(cat)) continue;
      if (!genreMap[cat]) genreMap[cat] = [];
      genreMap[cat].push(g);
    }
  }
  const byGenre = {};
  for (const [genre, games] of Object.entries(genreMap)) {
    if (games.length >= 2) byGenre[genre] = games.slice(0, 100);
  }

  const pools = {
    top20: deduped.slice(0, 20),
    topPicks: deduped.slice(0, 500),
    neverTouched: neverTouched.slice(0, 500),
    almostStarted: almostStarted.slice(0, 300),
    byGenre,
    genres: Object.keys(byGenre).sort((a, b) => genreMap[b].length - genreMap[a].length),
    stats: {
      total: library.length,
      neverPlayed: neverTouched.length,
      almostStarted: almostStarted.length,
    },
    profileSummary: generateProfileSummary(profile, metadataMap, library, achievementMap),
  };

  db.setRecCache(steamId, pools);
  return pools;
}

function samplePools(pools) {
  return {
    top20: pools.top20,
    topPicks: tieredSample(pools.topPicks, 72),
    neverTouched: tieredSample(pools.neverTouched, 60),
    almostStarted: tieredSample(pools.almostStarted, 60),
    byGenre: Object.fromEntries(
      Object.entries(pools.byGenre).map(([g, games]) => [g, tieredSample(games, 60)])
    ),
    genres: pools.genres,
    stats: pools.stats,
  };
}

module.exports = { buildRecommendations, samplePools, tieredSample };
