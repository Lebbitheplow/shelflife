const express = require('express');
const router = express.Router();
const db = require('../db/database');
const steamService = require('../services/steam');
const recommender = require('../services/recommender');
const igdb = require('../services/igdb');

// Search YouTube for a game trailer — returns 'yt:VIDEO_ID' or null
// All API calls are server-side; the key is never sent to the browser
async function searchYouTubeTrailer(gameName) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !gameName) return null;
  try {
    const q = encodeURIComponent(`${gameName} official trailer`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=1&videoEmbeddable=true&key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    const videoId = json.items?.[0]?.id?.videoId;
    return videoId ? `yt:${videoId}` : null;
  } catch {
    return null;
  }
}

// In-flight load jobs — prevents duplicate background fetches
const loadingJobs = new Map();

async function runLoadJob(steamId) {
  if (loadingJobs.has(steamId)) return; // already running

  loadingJobs.set(steamId, true);
  try {
    db.setLoadStatus(steamId, 'loading', 'Fetching your Steam library...', 0, 0);

    const library = await steamService.getOwnedGames(steamId);
    if (!library.length) {
      db.setLoadStatus(steamId, 'error', 'No games found. Your Steam profile may be set to Private.');
      return;
    }

    db.setUserLibrary(steamId, library);
    db.setLoadStatus(steamId, 'loading', `Fetching game details (0 / ${library.length})...`, 0, library.length);

    // Prioritize unplayed games first for faster useful results
    const unplayed = library.filter(g => g.playtime_forever < 120).map(g => g.appid);
    const played = library.filter(g => g.playtime_forever >= 120).map(g => g.appid);
    const ordered = [...unplayed, ...played];

    let count = 0;

    for (const appid of ordered) {
      await steamService.fetchAppDetails(appid);
      count++;
      if (count % 10 === 0) {
        db.setLoadStatus(steamId, 'loading', `Fetching game details (${count} / ${ordered.length})...`, count, ordered.length);
      }
    }

    db.setLoadStatus(steamId, 'loading', 'Fetching your Steam reviews...', ordered.length, ordered.length);
    const reviewedAppids = await steamService.getPositiveReviews(steamId);

    db.setLoadStatus(steamId, 'loading', 'Looking up game series data...', ordered.length, ordered.length);
    await igdb.enrichLibrary(ordered);

    db.setLoadStatus(steamId, 'loading', 'Looking up completion times...', ordered.length, ordered.length);
    await igdb.fetchTimeToBeat(ordered);

    // Fetch achievement data for games the user has seriously played (10+ hours, top 50)
    const ACHIEVEMENT_MIN_MINUTES = 600; // 10 hours
    const ACHIEVEMENT_CAP = 50;
    const achievementCandidates = library
      .filter(g => g.playtime_forever >= ACHIEVEMENT_MIN_MINUTES)
      .sort((a, b) => b.playtime_forever - a.playtime_forever)
      .slice(0, ACHIEVEMENT_CAP);

    if (achievementCandidates.length) {
      db.setLoadStatus(steamId, 'loading', `Fetching achievement data (0 / ${achievementCandidates.length})...`, 0, achievementCandidates.length);
      let achCount = 0;
      for (const game of achievementCandidates) {
        if (!db.isAchievementFresh(steamId, game.appid)) {
          const result = await steamService.getPlayerAchievements(steamId, game.appid);
          if (result) db.setAchievements(steamId, game.appid, result.total, result.unlocked);
          await new Promise(r => setTimeout(r, 150)); // gentle rate limiting
        }
        achCount++;
        if (achCount % 10 === 0) {
          db.setLoadStatus(steamId, 'loading', `Fetching achievement data (${achCount} / ${achievementCandidates.length})...`, achCount, achievementCandidates.length);
        }
      }
    }

    db.setLoadStatus(steamId, 'loading', 'Checking what your friends play...', ordered.length, ordered.length);
    const friendsMap = await steamService.getFriendsPlaytimes(steamId);

    db.setLoadStatus(steamId, 'loading', 'Building recommendations...', ordered.length, ordered.length);

    const libRows = db.getUserLibrary(steamId);
    const achievementMap = db.getAchievements(steamId);
    // Re-read metadata from the DB so IGDB enrichment (franchise + time-to-beat)
    // written above is reflected — the rows captured during the fetch loop predate it
    const allMetadata = db.getGameMetadataBatch(ordered);
    recommender.buildRecommendations(steamId, libRows, allMetadata, reviewedAppids, achievementMap, friendsMap);

    db.setLoadStatus(steamId, 'done', 'Ready', ordered.length, ordered.length);
  } catch (err) {
    console.error('[load job error]', err.message);
    db.setLoadStatus(steamId, 'error', 'Something went wrong: ' + err.message);
  } finally {
    loadingJobs.delete(steamId);
  }
}

// Manual refresh — clears cached recs and re-triggers a full data reload.
// Cooldown stops anyone from repeatedly triggering the most expensive operation
// in the app (minutes of Steam API calls) for an arbitrary steamId.
const REFRESH_COOLDOWN_S = 10 * 60;

router.post('/refresh/:steamId', (req, res) => {
  const { steamId } = req.params;
  if (!/^\d+$/.test(steamId)) return res.status(400).json({ error: 'Invalid steamId' });

  const age = db.getRecCacheAge(steamId);
  if (age !== null && age < REFRESH_COOLDOWN_S) {
    const waitMin = Math.max(1, Math.ceil((REFRESH_COOLDOWN_S - age) / 60));
    return res.status(429).json({
      error: `Data was refreshed recently — try again in about ${waitMin} min.`,
    });
  }

  db.clearRecCache(steamId);
  runLoadJob(steamId).catch(err => console.error('[refresh] load job failed:', err));
  res.json({ success: true });
});

// Poll endpoint for load status
router.get('/status/:steamId', (req, res) => {
  const status = db.getLoadStatus(req.params.steamId);
  if (!status) return res.json({ status: 'unknown' });
  res.json(status);
});

// Resolve a Steam input to a steamId and kick off loading if needed
router.post('/resolve', async (req, res) => {
  // req.body is undefined when the request carries no parseable body (express 5)
  const { input } = req.body || {};
  if (!input) return res.status(400).json({ error: 'No input provided' });

  try {
    const steamId = await steamService.resolveToSteamId(input);

    // Fetch profile summary (name + avatar)
    const player = await steamService.getPlayerSummary(steamId);

    // Private profile check
    if (player.communityvisibilitystate !== 3) {
      return res.status(403).json({
        error: 'Your Steam profile is set to Private. Go to Steam → Edit Profile → Privacy Settings and set Game Details to Public, then try again.',
      });
    }

    db.setUserProfile(steamId, {
      display_name: player.personaname,
      avatar_url: player.avatarfull,
    });

    res.json({ steamId, displayName: player.personaname });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Dismiss a game (hide it from recommendations without affecting scoring)
router.post('/dismiss', (req, res) => {
  const { appid, steamId } = req.body || {};
  if (!steamId || !/^\d+$/.test(String(steamId))) return res.status(400).json({ error: 'Invalid steamId' });
  if (!appid || isNaN(Number(appid))) return res.status(400).json({ error: 'Invalid appid' });
  db.addDismissal(steamId, Number(appid));
  res.json({ success: true });
});

router.delete('/dismiss', (req, res) => {
  const { appid, steamId } = req.body || {};
  if (!steamId || !/^\d+$/.test(String(steamId))) return res.status(400).json({ error: 'Invalid steamId' });
  if (!appid || isNaN(Number(appid))) return res.status(400).json({ error: 'Invalid appid' });
  db.removeDismissal(steamId, Number(appid));
  res.json({ success: true });
});

// Get recommendations (sampled from cached pools)
router.get('/recommendations/:steamId', async (req, res) => {
  const { steamId } = req.params;

  // Try cached pools first
  const cached = db.getRecCache(steamId);
  if (cached) {
    const dismissed = db.getDismissals(steamId);
    return res.json(recommender.samplePools(cached, dismissed));
  }

  // Check if already loading
  const status = db.getLoadStatus(steamId);
  if (status && status.status === 'loading') {
    return res.status(202).json({ loading: true, message: status.message });
  }

  // No cache, no active job — start one
  const profile = db.getUserProfile(steamId);
  if (!profile) return res.status(404).json({ error: 'Profile not found. Please start from the home page.' });

  runLoadJob(steamId).catch(err => console.error('[recommendations] load job failed:', err)); // fire-and-forget
  return res.status(202).json({ loading: true, message: 'Starting up...' });
});

// Shuffle — just resamples from existing pools
router.get('/shuffle/:steamId', (req, res) => {
  const { steamId } = req.params;
  const cached = db.getRecCache(steamId);
  if (!cached) return res.status(404).json({ error: 'No recommendation data. Please reload the profile page.' });
  const dismissed = db.getDismissals(steamId);
  res.json(recommender.samplePools(cached, dismissed));
});

// On-demand detail fetch — returns trailer_mp4 + short_description for a single game
router.get('/trailer/:appid', async (req, res) => {
  const appid = parseInt(req.params.appid);
  if (!appid) return res.status(400).json({ error: 'Invalid appid' });

  const cached = db.getGameMetadata(appid);

  const cachedEsrb = cached?.esrb_rating || null;

  // 'none' sentinel = already confirmed no trailer exists on Steam, stop re-fetching
  // Still re-fetch if esrb_rating is missing (null = never fetched for this field)
  if (cached?.trailer_mp4 === 'none' && cachedEsrb !== null) {
    return res.json({ trailer_mp4: null, short_description: cached?.short_description || null, esrb_rating: cachedEsrb === 'none' ? null : cachedEsrb });
  }
  // All fields populated — return immediately
  if (cached?.trailer_mp4 && cached?.short_description && cachedEsrb !== null) {
    return res.json({ trailer_mp4: cached.trailer_mp4, short_description: cached.short_description, esrb_rating: cachedEsrb === 'none' ? null : cachedEsrb });
  }

  // Fetch from Steam store API to fill in whatever is missing
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ trailer_mp4: null, short_description: cached?.short_description || null, esrb_rating: cachedEsrb === 'none' ? null : cachedEsrb });

    const json = await r.json();
    const storeData = json?.[String(appid)]?.data;
    if (!storeData) return res.json({ trailer_mp4: null, short_description: cached?.short_description || null, esrb_rating: cachedEsrb === 'none' ? null : cachedEsrb });

    const movies = storeData.movies || [];
    let trailer_mp4 = movies.length
      ? (movies[0]?.hls_h264 || movies[0]?.mp4?.['480'] || movies[0]?.mp4?.max || null)
      : null;
    const short_description = storeData.short_description || cached?.short_description || null;
    const esrb_rating = storeData?.ratings?.esrb?.rating || 'none';

    // No Steam trailer — try YouTube as fallback
    if (!trailer_mp4) {
      const gameName = storeData.name || cached?.name || null;
      trailer_mp4 = await searchYouTubeTrailer(gameName) || 'none';
    }

    db.upsertTrailerDetails(appid, { trailer_mp4, short_description, esrb_rating });

    res.json({ trailer_mp4: trailer_mp4 === 'none' ? null : trailer_mp4, short_description, esrb_rating: esrb_rating === 'none' ? null : esrb_rating });
  } catch {
    res.json({ trailer_mp4: null, short_description: cached?.short_description || null, esrb_rating: cachedEsrb === 'none' ? null : cachedEsrb });
  }
});

// Profile taste summary
router.get('/interests/:steamId', (req, res) => {
  const cached = db.getRecCache(req.params.steamId);
  if (!cached) return res.status(404).json({ error: 'No data.' });
  res.json({ interests: cached.profileSummary || [] });
});

// Genre filter — hasOwn guard so prototype keys like __proto__ can't reach tieredSample
router.get('/genre/:steamId/:genre', (req, res) => {
  const cached = db.getRecCache(req.params.steamId);
  if (!cached) return res.status(404).json({ error: 'No data.' });
  const games = Object.hasOwn(cached.byGenre, req.params.genre) ? cached.byGenre[req.params.genre] : [];
  res.json(recommender.tieredSample(games, 60));
});

module.exports = { router, runLoadJob };
