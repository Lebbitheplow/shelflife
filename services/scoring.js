/* Taste profile + candidate scoring. Shared by the library recommender and the
   store discovery service so both rank games with the same signals. */

// Candidate scoring weights — per-signal caps keep any one signal from dominating
const SCORE = {
  FRANCHISE_BONUS: 30,
  DEV_CAP: 15,
  TAG_CAP: 40,
  SIMILAR_CAP: 20,   // item-kNN: closeness to the specific games the user loved
  GENRE_CAP: 20,
  CATEGORY_CAP: 10,
  BOUNCE_CAP: 10,    // penalty: tags shared with games the user tried and dropped
};

const LOVED_MIN_MINUTES = 120;
const BOUNCE_MIN_MINUTES = 5;
const BOUNCE_MAX_MINUTES = 90;
const BOUNCE_STALE_DAYS = 60;
const RECENT_DAYS = 90;
const MIN_REVIEWS_FOR_SIGNAL = 50;

function parseJSON(str, fallback = []) {
  if (Array.isArray(str)) return str;
  try { return JSON.parse(str) ?? fallback; } catch { return fallback; }
}

// Clamp raw IDF: common tags (Singleplayer) → 0.35 floor, niche tags → 1.5 ceiling
function clampIdf(raw) {
  return Math.max(0.35, Math.min(1.5, raw ?? 1));
}

// Wilson score lower bound (95%): a review ratio that is honest about sample size.
// 10/10 positive scores lower than 950/1000 positive.
function wilsonLowerBound(positive, total, z = 1.96) {
  if (!total) return 0;
  const p = positive / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (centre - spread) / denom;
}

// Tag IDF over the corpus: rare/niche tags get higher weight than ubiquitous ones
function computeTagIDF(allMetadata) {
  const tagDF = {};
  let totalDocs = 0;
  for (const m of allMetadata) {
    if (!m) continue;
    totalDocs++;
    for (const tag of new Set(parseJSON(m.tags))) tagDF[tag] = (tagDF[tag] || 0) + 1;
  }
  const tagIDF = {};
  for (const [tag, df] of Object.entries(tagDF)) {
    tagIDF[tag] = Math.log(((totalDocs || 1) + 1) / (df + 1));
  }
  return tagIDF;
}

function normalize(map) {
  const max = Math.max(...Object.values(map), 1);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v / max]));
}

// Build a weighted preference profile from the user's played games.
// Also tracks, per-tag and per-dev, which specific game contributed most (for reason attribution).
function buildPreferenceProfile(library, metadataMap, reviewedAppids = new Set(), achievementMap = {}) {
  const tagWeights = {};
  const genreWeights = {};
  const devWeights = {};
  const categoryWeights = {};
  const bounceWeights = {};
  const tagSeed = {};   // tag -> { name, appid, weight }
  const devSeed = {};   // dev -> { name, appid, weight }
  const lovedWeights = {}; // appid -> raw weight (normalized below)

  const topPlaytime = [...library].sort((a, b) => b.playtime_forever - a.playtime_forever);
  const top30 = new Set(topPlaytime.slice(0, 30).map(g => g.appid));
  const top5 = new Set(topPlaytime.slice(0, 5).map(g => g.appid));
  const recentlyPlayed = new Set(library.filter(g => (g.playtime_2weeks || 0) > 0).map(g => g.appid));
  const now = Date.now() / 1000;

  const lovedGames = library.filter(g => g.playtime_forever >= LOVED_MIN_MINUTES);

  for (const game of lovedGames) {
    const meta = metadataMap[game.appid];
    if (!meta || !meta.name) continue;

    let weight = Math.sqrt(game.playtime_forever);
    if (recentlyPlayed.has(game.appid)) weight *= 1.5;
    else if (game.last_played && now - game.last_played < RECENT_DAYS * 86400) weight *= 1.2;
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

    lovedWeights[game.appid] = weight;

    for (const tag of parseJSON(meta.tags)) {
      tagWeights[tag] = (tagWeights[tag] || 0) + weight;
      if (!tagSeed[tag] || weight > tagSeed[tag].weight) tagSeed[tag] = { name: meta.name, appid: game.appid, weight };
    }
    for (const genre of parseJSON(meta.genres)) genreWeights[genre] = (genreWeights[genre] || 0) + weight;
    for (const dev of parseJSON(meta.developers)) {
      devWeights[dev] = (devWeights[dev] || 0) + weight;
      if (!devSeed[dev] || weight > devSeed[dev].weight) devSeed[dev] = { name: meta.name, appid: game.appid, weight };
    }
    for (const cat of parseJSON(meta.categories)) categoryWeights[cat] = (categoryWeights[cat] || 0) + weight;
  }

  // Negative signal: games the user launched, dropped quickly, and never came back to.
  // Their tags get a small penalty — unless the user also loves that tag elsewhere.
  for (const game of library) {
    const pt = game.playtime_forever || 0;
    if (pt < BOUNCE_MIN_MINUTES || pt > BOUNCE_MAX_MINUTES) continue;
    if (!game.last_played || now - game.last_played < BOUNCE_STALE_DAYS * 86400) continue;
    const meta = metadataMap[game.appid];
    if (!meta) continue;
    for (const tag of parseJSON(meta.tags).slice(0, 8)) bounceWeights[tag] = (bounceWeights[tag] || 0) + 1;
  }

  return {
    tags: normalize(tagWeights),
    genres: normalize(genreWeights),
    devs: normalize(devWeights),
    categories: normalize(categoryWeights),
    bounce: normalize(bounceWeights),
    lovedWeights: normalize(lovedWeights),
    tagSeed,
    devSeed,
    lovedGames,
    reviewedAppids,
    tagIDF: {},
    _metadataMap: metadataMap,
  };
}

// Convenience: IDF + profile in one call, with the metadata map attached
function buildProfile(library, allMetadata, reviewedAppids = new Set(), achievementMap = {}) {
  const metadataMap = {};
  for (const m of allMetadata) if (m) metadataMap[m.appid] = m;
  const profile = buildPreferenceProfile(library, metadataMap, reviewedAppids, achievementMap);
  profile.tagIDF = computeTagIDF(allMetadata);
  return profile;
}

// Top tags by IDF-weighted affinity — used to pick which store tags to browse
function topProfileTags(profile, n = 8) {
  return Object.entries(profile.tags)
    .map(([tag, w]) => ({ tag, effective: w * clampIdf(profile.tagIDF?.[tag]) }))
    .sort((a, b) => b.effective - a.effective)
    .slice(0, n);
}

// Score a candidate game and generate specific reason tags
function scoreGame(meta, profile, game) {
  let score = 0;
  const reasonCandidates = []; // { text, priority, seed }

  const tags = parseJSON(meta.tags);
  const genres = parseJSON(meta.genres);
  const devs = parseJSON(meta.developers);
  const cats = parseJSON(meta.categories);
  const selfAppid = game?.appid ?? meta.appid;

  // ── Franchise / series detection via IGDB collection ─────────────────
  if (meta.igdb_collection) {
    for (const lovedGame of profile.lovedGames) {
      if (lovedGame.appid === selfAppid) continue;
      const lovedMeta = profile._metadataMap?.[lovedGame.appid];
      if (!lovedMeta || lovedMeta.igdb_collection !== meta.igdb_collection) continue;
      const hrs = Math.round(lovedGame.playtime_forever / 60);
      score += SCORE.FRANCHISE_BONUS;
      reasonCandidates.push({
        text: hrs >= 5 ? `You put ${hrs}h into ${lovedMeta.name}` : `In the ${lovedMeta.name} series`,
        priority: 10,
        seed: lovedMeta.name,
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
        text: seed ? `More from ${dev} (you loved ${seed.name})` : `More from ${dev}`,
        priority: w * 8,
        seed: seed?.name || null,
      });
    }
  }
  score += Math.min(devScore, SCORE.DEV_CAP);

  // ── Tag overlap (IDF-weighted: rare/niche tags count more than common ones) ──
  let tagScore = 0;
  let bestTagW = 0;
  let bestTag = null;
  for (const tag of tags) {
    const w = profile.tags[tag] || 0;
    if (!w) continue;
    const effective = w * clampIdf(profile.tagIDF?.[tag]);
    tagScore += effective * 4;
    if (effective > bestTagW) { bestTagW = effective; bestTag = tag; }
  }
  score += Math.min(tagScore, SCORE.TAG_CAP);

  // ── Item similarity (Jaccard tag overlap with the games the user loved) ──
  // Requires 4+ shared tags so generic overlap (RPG, Action) doesn't trigger it.
  // The closest few loved games contribute score, weighted by how much they were loved.
  const candidateTagSet = new Set(tags);
  const similar = [];
  for (const lovedGame of profile.lovedGames) {
    if (lovedGame.appid === selfAppid) continue;
    const lovedMeta = profile._metadataMap?.[lovedGame.appid];
    if (!lovedMeta) continue;
    const lovedTags = parseJSON(lovedMeta.tags);
    if (!lovedTags.length) continue;
    const sharedCount = lovedTags.filter(t => candidateTagSet.has(t)).length;
    if (sharedCount < 4) continue;
    const union = new Set([...tags, ...lovedTags]).size;
    const jaccard = union > 0 ? sharedCount / union : 0;
    similar.push({ meta: lovedMeta, jaccard, playtime: lovedGame.playtime_forever, loved: profile.lovedWeights?.[lovedGame.appid] || 0 });
  }
  similar.sort((a, b) => (b.jaccard * (0.5 + b.loved)) - (a.jaccard * (0.5 + a.loved)));
  let simScore = 0;
  for (const s of similar.slice(0, 3)) simScore += s.jaccard * (0.5 + s.loved) * 20;
  score += Math.min(simScore, SCORE.SIMILAR_CAP);

  const best = similar[0];
  if (best && best.jaccard >= 0.25) {
    const hrs = Math.round(best.playtime / 60);
    reasonCandidates.push({
      text: hrs >= 5 ? `You put ${hrs}h into ${best.meta.name}` : `Similar to ${best.meta.name}`,
      priority: best.jaccard * 10,
      seed: best.meta.name,
    });
  } else if (bestTag && bestTagW > 0.4) {
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
  score += Math.min(genreScore, SCORE.GENRE_CAP);
  if (bestGenre && bestGenreW > 0.45) {
    reasonCandidates.push({ text: `Fits your ${bestGenre} preference`, priority: bestGenreW * 1.8 });
  }

  // ── Category match ─────────────────────────────────────────────────────
  const SOCIAL_CATS = ['Co-op', 'Online Co-op', 'Multi-player', 'Local Co-op', 'MMO'];
  let catScore = 0;
  for (const cat of cats) {
    const w = profile.categories[cat] || 0;
    catScore += w * 2.5;
    if (SOCIAL_CATS.includes(cat) && w > 0.5) reasonCandidates.push({ text: `You enjoy ${cat} games`, priority: w * 1.2 });
  }
  score += Math.min(catScore, SCORE.CATEGORY_CAP);

  // ── Bounce penalty — tags from games the user dropped, unless also loved ──
  let bounce = 0;
  for (const tag of tags) {
    const b = profile.bounce?.[tag] || 0;
    if (!b) continue;
    bounce += b * 3 * (1 - (profile.tags[tag] || 0));
  }
  score -= Math.min(bounce, SCORE.BOUNCE_CAP);

  // ── Metacritic bonus ───────────────────────────────────────────────────
  if (meta.metacritic_score >= 90) {
    score += 5;
    reasonCandidates.push({ text: `Critically acclaimed · ${meta.metacritic_score} MC`, priority: 3 });
  } else if (meta.metacritic_score >= 80) {
    score += 3;
    reasonCandidates.push({ text: `Highly rated · ${meta.metacritic_score} MC`, priority: 2 });
  }

  // ── Steam community score (Wilson lower bound, so small samples don't inflate) ──
  if (meta.steam_positive != null && meta.steam_negative != null) {
    const total = meta.steam_positive + meta.steam_negative;
    if (total >= MIN_REVIEWS_FOR_SIGNAL) {
      const lb = wilsonLowerBound(meta.steam_positive, total);
      if (lb >= 0.93) { score += 4; reasonCandidates.push({ text: 'Overwhelmingly positive reviews', priority: 2.5 }); }
      else if (lb >= 0.83) { score += 2; reasonCandidates.push({ text: 'Very positive reviews', priority: 1.5 }); }
    }
  }

  // ── Release recency bonus ──────────────────────────────────────────────
  if (meta.release_date) {
    const year = parseInt((String(meta.release_date).match(/\d{4}/) || [])[0]);
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
      return w ? { tag: t, effective: w * clampIdf(profile.tagIDF?.[t]) } : null;
    })
    .filter(x => x && x.effective > 0.3 && x.tag !== bestTag)
    .sort((a, b) => b.effective - a.effective)
    .slice(0, 3);
  for (const { tag, effective } of topMatchTags) {
    reasonCandidates.push({ text: `Matches your ${tag} taste`, priority: effective * 1.5, seed: profile.tagSeed?.[tag]?.name || null });
  }

  // Pick top 6 reasons by priority, deduplicating identical text and seed games
  reasonCandidates.sort((a, b) => b.priority - a.priority);
  const seenReasons = new Set();
  const seenSeeds = new Set();
  const reasons = reasonCandidates
    .filter(r => {
      if (seenReasons.has(r.text)) return false;
      const seedKey = r.seed?.toLowerCase();
      if (seedKey && seenSeeds.has(seedKey)) return false;
      seenReasons.add(r.text);
      if (seedKey) seenSeeds.add(seedKey);
      return true;
    })
    .slice(0, 6).map(r => r.text);

  if (!reasons.length && tags[0]) reasons.push(`Matches your ${tags[0]} taste`);

  return { score: Math.max(0, score), reasons };
}

// Build a human-readable taste profile summary (up to 6 interest statements)
function generateProfileSummary(profile, metadataMap, library, achievementMap = {}) {
  const candidates = []; // { text, priority, cat, seed }

  const topGenres = Object.entries(profile.genres).filter(([, w]) => w > 0.45).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [genre, w] of topGenres) candidates.push({ text: `Loves ${genre} games`, priority: w * 5, cat: 'genre' });

  for (const { tag, effective } of topProfileTags(profile, 6).filter(x => x.effective > 0.35)) {
    const seed = profile.tagSeed?.[tag];
    candidates.push({
      text: seed ? `Into ${tag} — ${seed.name} is a favourite` : `Into ${tag} games`,
      priority: effective * 3, cat: 'tag', seed: seed?.name || null,
    });
  }

  const topDevs = Object.entries(profile.devs).filter(([, w]) => w > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [dev, w] of topDevs) {
    const seed = profile.devSeed?.[dev];
    candidates.push({ text: seed ? `Fan of ${dev} — loved ${seed.name}` : `Fan of ${dev}`, priority: w * 4, cat: 'dev', seed: seed?.name || null });
  }

  const topPlayed = [...library].filter(g => g.playtime_forever >= 600).sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, 4);
  for (const game of topPlayed) {
    const meta = metadataMap[game.appid];
    if (!meta?.name) continue;
    const hrs = Math.round(game.playtime_forever / 60);
    candidates.push({ text: `${hrs}h in ${meta.name}`, priority: Math.sqrt(game.playtime_forever) * 0.6, cat: 'playtime', seed: meta.name });
  }

  for (const [appidStr, ach] of Object.entries(achievementMap)) {
    if (ach.total < 10) continue;
    const pct = ach.unlocked / ach.total;
    if (pct < 0.85) continue;
    const meta = metadataMap[parseInt(appidStr)];
    if (!meta?.name) continue;
    candidates.push({ text: `Achievement hunter — ${Math.round(pct * 100)}% done in ${meta.name}`, priority: pct * 4, cat: 'ach', seed: meta.name });
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const CAT_CAPS = { genre: 2, tag: 2, dev: 1, playtime: 2, ach: 1 };
  const catCounts = {};
  const seenSeeds = new Set();
  const result = [];
  for (const c of candidates) {
    if (result.length >= 6) break;
    if ((catCounts[c.cat] || 0) >= (CAT_CAPS[c.cat] ?? 2)) continue;
    const seedKey = c.seed?.toLowerCase();
    if (seedKey && seenSeeds.has(seedKey)) continue;
    if (seedKey) seenSeeds.add(seedKey);
    catCounts[c.cat] = (catCounts[c.cat] || 0) + 1;
    result.push(c.text);
  }
  return result;
}

module.exports = {
  SCORE, LOVED_MIN_MINUTES,
  parseJSON, clampIdf, wilsonLowerBound, computeTagIDF,
  buildPreferenceProfile, buildProfile, topProfileTags, scoreGame, generateProfileSummary,
};
