const express = require('express');
const router = express.Router();
const db = require('../db/database');
const steamService = require('../services/steam');
const recommender = require('../services/recommender');

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

    // Only fetch metadata for unplayed/barely-played games for recommendations
    // but fetch all for profile building (we need playtime context)
    const allAppids = library.map(g => g.appid);
    // Prioritize unplayed games first for faster useful results
    const unplayed = library.filter(g => g.playtime_forever < 120).map(g => g.appid);
    const played = library.filter(g => g.playtime_forever >= 120).map(g => g.appid);
    const ordered = [...unplayed, ...played];

    const fetched = [];
    let count = 0;

    for (const appid of ordered) {
      const meta = await steamService.fetchAppDetails(appid);
      if (meta) fetched.push(meta);
      count++;
      if (count % 10 === 0) {
        db.setLoadStatus(steamId, 'loading', `Fetching game details (${count} / ${ordered.length})...`, count, ordered.length);
      }
    }

    db.setLoadStatus(steamId, 'loading', 'Fetching your Steam reviews...', ordered.length, ordered.length);
    const reviewedAppids = await steamService.getPositiveReviews(steamId);

    db.setLoadStatus(steamId, 'loading', 'Building recommendations...', ordered.length, ordered.length);

    const libRows = db.getUserLibrary(steamId);
    recommender.buildRecommendations(steamId, libRows, fetched, reviewedAppids);

    db.setLoadStatus(steamId, 'done', 'Ready', ordered.length, ordered.length);
  } catch (err) {
    console.error('[load job error]', err.message);
    db.setLoadStatus(steamId, 'error', 'Something went wrong: ' + err.message);
  } finally {
    loadingJobs.delete(steamId);
  }
}

// Poll endpoint for load status
router.get('/status/:steamId', (req, res) => {
  const status = db.getLoadStatus(req.params.steamId);
  if (!status) return res.json({ status: 'unknown' });
  res.json(status);
});

// Resolve a Steam input to a steamId and kick off loading if needed
router.post('/resolve', async (req, res) => {
  const { input } = req.body;
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

// Get recommendations (sampled from cached pools)
router.get('/recommendations/:steamId', async (req, res) => {
  const { steamId } = req.params;

  // Try cached pools first
  const cached = db.getRecCache(steamId);
  if (cached) {
    return res.json(recommender.samplePools(cached));
  }

  // Check if already loading
  const status = db.getLoadStatus(steamId);
  if (status && status.status === 'loading') {
    return res.status(202).json({ loading: true, message: status.message });
  }

  // No cache, no active job — start one
  const profile = db.getUserProfile(steamId);
  if (!profile) return res.status(404).json({ error: 'Profile not found. Please start from the home page.' });

  runLoadJob(steamId); // fire-and-forget
  return res.status(202).json({ loading: true, message: 'Starting up...' });
});

// Shuffle — just resamples from existing pools
router.get('/shuffle/:steamId', (req, res) => {
  const cached = db.getRecCache(req.params.steamId);
  if (!cached) return res.status(404).json({ error: 'No recommendation data. Please reload the profile page.' });
  res.json(recommender.samplePools(cached));
});

// On-demand detail fetch — returns trailer_mp4 + short_description for a single game
router.get('/trailer/:appid', async (req, res) => {
  const appid = parseInt(req.params.appid);
  if (!appid) return res.status(400).json({ error: 'Invalid appid' });

  const cached = db.getGameMetadata(appid);

  // 'none' sentinel = already confirmed no trailer exists on Steam, stop re-fetching
  if (cached?.trailer_mp4 === 'none') {
    return res.json({ trailer_mp4: null, short_description: cached?.short_description || null });
  }
  // Both fields populated — return immediately
  if (cached?.trailer_mp4 && cached?.short_description) {
    return res.json({ trailer_mp4: cached.trailer_mp4, short_description: cached.short_description });
  }

  // Fetch from Steam store API to fill in whatever is missing
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ trailer_mp4: null, short_description: cached?.short_description || null });

    const json = await r.json();
    const storeData = json?.[String(appid)]?.data;
    if (!storeData) return res.json({ trailer_mp4: null, short_description: cached?.short_description || null });

    const movies = storeData.movies || [];
    // Use 'none' sentinel when confirmed no trailer — prevents redundant fetches on future opens
    let trailer_mp4 = movies.length
      ? (movies[0]?.hls_h264 || movies[0]?.mp4?.['480'] || movies[0]?.mp4?.max || null)
      : 'none';
    const short_description = storeData.short_description || cached?.short_description || null;

    if (cached) db.updateGameDetails(appid, { trailer_mp4, short_description });

    res.json({ trailer_mp4: trailer_mp4 === 'none' ? null : trailer_mp4, short_description });
  } catch {
    res.json({ trailer_mp4: null, short_description: cached?.short_description || null });
  }
});

// Genre filter
router.get('/genre/:steamId/:genre', (req, res) => {
  const cached = db.getRecCache(req.params.steamId);
  if (!cached) return res.status(404).json({ error: 'No data.' });
  const games = cached.byGenre[req.params.genre] || [];
  res.json(recommender.tieredSample ? recommender.tieredSample(games, 60) : games.slice(0, 60));
});

module.exports = { router, runLoadJob };
