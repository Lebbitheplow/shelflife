const express = require('express');
const router = express.Router();
const db = require('../db/database');
const steamService = require('../services/steam');
const recommender = require('../services/recommender');
const discover = require('../services/discover');
const { runLoadJob } = require('../services/loader');

// Every per-user route takes a SteamID64 — reject anything else at the boundary
function requireSteamId(req, res, next) {
  const id = req.params.steamId ?? req.body?.steamId;
  if (!id || !/^\d{17}$/.test(String(id))) return res.status(400).json({ error: 'Invalid steamId' });
  req.steamId = String(id);
  next();
}

function parseAppid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Manual refresh — clears cached recs and re-triggers a full data reload.
// Cooldown stops anyone from repeatedly triggering the most expensive operation
// in the app (minutes of Steam API calls) for an arbitrary steamId.
const REFRESH_COOLDOWN_S = 10 * 60;

router.post('/refresh/:steamId', requireSteamId, (req, res) => {
  const { steamId } = req;
  const age = db.getRecCacheAge(steamId);
  if (age !== null && age < REFRESH_COOLDOWN_S) {
    const waitMin = Math.max(1, Math.ceil((REFRESH_COOLDOWN_S - age) / 60));
    return res.status(429).json({ error: `Data was refreshed recently — try again in about ${waitMin} min.` });
  }

  db.clearRecCache(steamId);
  db.clearDiscoverCache(steamId);
  runLoadJob(steamId).catch(err => console.error('[refresh] load job failed:', err));
  res.json({ success: true });
});

// Poll endpoint for load status
router.get('/status/:steamId', requireSteamId, (req, res) => {
  const status = db.getLoadStatus(req.steamId);
  if (!status) return res.json({ status: 'unknown' });
  res.json(status);
});

// Resolve a Steam input to a steamId and kick off loading if needed
router.post('/resolve', async (req, res) => {
  // req.body is undefined when the request carries no parseable body (express 5)
  const { input } = req.body || {};
  if (!input || typeof input !== 'string' || input.length > 300) return res.status(400).json({ error: 'No input provided' });

  try {
    const steamId = await steamService.resolveToSteamId(input);
    const player = await steamService.getPlayerSummary(steamId);

    if (player.communityvisibilitystate !== 3) {
      return res.status(403).json({
        error: 'Your Steam profile is set to Private. Go to Steam → Edit Profile → Privacy Settings and set Game Details to Public, then try again.',
      });
    }

    db.setUserProfile(steamId, { display_name: player.personaname, avatar_url: player.avatarfull });
    res.json({ steamId, displayName: player.personaname });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Dismiss a game (hide it from recommendations without affecting scoring)
router.post('/dismiss', requireSteamId, (req, res) => {
  const appid = parseAppid(req.body?.appid);
  if (!appid) return res.status(400).json({ error: 'Invalid appid' });
  db.addDismissal(req.steamId, appid);
  res.json({ success: true });
});

router.delete('/dismiss', requireSteamId, (req, res) => {
  const appid = parseAppid(req.body?.appid);
  if (!appid) return res.status(400).json({ error: 'Invalid appid' });
  db.removeDismissal(req.steamId, appid);
  res.json({ success: true });
});

// Get recommendations (sampled from cached pools)
router.get('/recommendations/:steamId', requireSteamId, (req, res) => {
  const { steamId } = req;
  const cached = db.getRecCache(steamId);
  if (cached) return res.json(recommender.samplePools(cached, db.getDismissals(steamId)));

  const status = db.getLoadStatus(steamId);
  if (status && status.status === 'loading') return res.status(202).json({ loading: true, message: status.message });

  const profile = db.getUserProfile(steamId);
  if (!profile) return res.status(404).json({ error: 'Profile not found. Please start from the home page.' });

  runLoadJob(steamId).catch(err => console.error('[recommendations] load job failed:', err)); // fire-and-forget
  res.status(202).json({ loading: true, message: 'Starting up...' });
});

// Shuffle — just resamples from existing pools
router.get('/shuffle/:steamId', requireSteamId, (req, res) => {
  const cached = db.getRecCache(req.steamId);
  if (!cached) return res.status(404).json({ error: 'No recommendation data. Please reload the profile page.' });
  res.json(recommender.samplePools(cached, db.getDismissals(req.steamId)));
});

// Profile taste summary
router.get('/interests/:steamId', requireSteamId, (req, res) => {
  const cached = db.getRecCache(req.steamId);
  if (!cached) return res.status(404).json({ error: 'No data.' });
  res.json({ interests: cached.profileSummary || [] });
});

// Genre filter — hasOwn guard so prototype keys like __proto__ can't reach tieredSample
router.get('/genre/:steamId/:genre', requireSteamId, (req, res) => {
  const cached = db.getRecCache(req.steamId);
  if (!cached) return res.status(404).json({ error: 'No data.' });
  const games = Object.hasOwn(cached.byGenre, req.params.genre) ? cached.byGenre[req.params.genre] : [];
  res.json(recommender.tieredSample(games, 60));
});

// Store discovery — games the user doesn't own, with prices.
// Returns cached pools (even stale ones) and rebuilds in the background when stale.
router.get('/discover/:steamId', requireSteamId, (req, res) => {
  const { steamId } = req;
  const cached = db.getDiscoverCache(steamId);
  const status = discover.getDiscoverStatus(steamId);
  const building = status?.status === 'loading';

  if (cached) {
    if (!discover.isDiscoverFresh(steamId) && !building && db.getRecCache(steamId)) {
      discover.runDiscoverJob(steamId).catch(err => console.error('[discover] refresh failed:', err));
    }
    return res.json({ ...discover.filterDiscover(cached.pools, db.getDismissals(steamId)), builtAt: cached.builtAt, refreshing: building });
  }

  if (building) return res.status(202).json({ loading: true, message: status.message, progress: status.progress, total: status.total });
  if (status?.status === 'error') return res.status(500).json({ error: status.message });
  if (!db.getRecCache(steamId)) return res.status(409).json({ error: 'Load your library first.' });

  discover.runDiscoverJob(steamId).catch(err => console.error('[discover] job failed:', err));
  res.status(202).json({ loading: true, message: 'Starting store discovery…', progress: 0, total: 0 });
});

router.get('/discover/:steamId/status', requireSteamId, (req, res) => {
  const status = discover.getDiscoverStatus(req.steamId);
  if (!status) return res.json({ status: 'unknown' });
  res.json(status);
});

module.exports = { router, runLoadJob };
