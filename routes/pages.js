const express = require('express');
const router = express.Router();
const db = require('../db/database');
const steamService = require('../services/steam');
const { runLoadJob } = require('../services/loader');

const STEAM_ID_RE = /^\d{17}$/;

// Landing page
router.get('/', (req, res) => {
  res.render('index', { errorMsg: typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null });
});

// PWA manifest — personalized per user so start_url opens their profile
router.get('/manifest/:steamId.json', (req, res) => {
  const { steamId } = req.params;
  if (!STEAM_ID_RE.test(steamId)) return res.status(404).end();
  const profile = db.getUserProfile(steamId);
  const displayName = profile?.display_name;
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: displayName ? `${displayName} — ShelfLife` : 'ShelfLife',
    short_name: 'ShelfLife',
    description: 'Your Steam library, ranked and ready.',
    start_url: `/profile/${steamId}`,
    display: 'standalone',
    background_color: '#0a0a0e',
    theme_color: '#0a0a0e',
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  });
});

// Profile page
router.get('/profile/:steamId', async (req, res) => {
  const { steamId } = req.params;
  if (!STEAM_ID_RE.test(steamId)) return res.redirect('/?error=' + encodeURIComponent('That profile link is not valid.'));

  let profile = db.getUserProfile(steamId);

  // Refresh profile if stale or missing
  if (!profile || !db.isProfileFresh(steamId)) {
    try {
      const player = await steamService.getPlayerSummary(steamId);
      db.setUserProfile(steamId, { display_name: player.personaname, avatar_url: player.avatarfull });
      profile = db.getUserProfile(steamId);
    } catch (err) {
      // Use cached if available even if stale
      if (!profile) return res.redirect('/?error=' + encodeURIComponent('Profile not found.'));
    }
  }

  // Track this visit for the background refresh scheduler
  db.updateLastActive(steamId);

  const cached = db.getRecCache(steamId);
  const status = db.getLoadStatus(steamId);
  const isLoading = !cached && status?.status === 'loading';
  const isError = !cached && status?.status === 'error';

  // Only kick off a load job on first visit (no cache at all)
  if (!cached && !isLoading && !isError) {
    runLoadJob(steamId).catch(err => console.error('[profile] load job failed:', err));
  }

  res.render('profile', {
    steamId,
    profile,
    isLoading: isLoading || (!cached && !isError),
    isError,
    errorMessage: isError ? status.message : null,
  });
});

module.exports = router;
