const express = require('express');
const router = express.Router();
const db = require('../db/database');
const steamService = require('../services/steam');
const { runLoadJob } = require('./api');

// Landing page
router.get('/', (req, res) => {
  res.render('index');
});

// PWA manifest — personalized per user so start_url opens their profile
router.get('/manifest/:steamId.json', (req, res) => {
  const { steamId } = req.params;
  const profile = db.getUserProfile(steamId);
  const displayName = profile?.display_name;
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: displayName ? `${displayName} — ShelfLife` : 'ShelfLife',
    short_name: 'ShelfLife',
    description: 'Your Steam library, ranked and ready.',
    start_url: `/profile/${steamId}`,
    display: 'standalone',
    background_color: '#0f0f11',
    theme_color: '#0f0f11',
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  });
});

// Profile page
router.get('/profile/:steamId', async (req, res) => {
  const { steamId } = req.params;

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

  // Check if we have fresh recs
  const cached = db.getRecCache(steamId);
  const status = db.getLoadStatus(steamId);
  const isLoading = !cached && status?.status === 'loading';
  const isError = !cached && status?.status === 'error';

  // If nothing at all, kick off a load job
  if (!cached && !isLoading && !isError) {
    runLoadJob(steamId);
  }

  res.render('profile', {
    steamId,
    profile,
    isLoading: isLoading || (!cached && !isError),
    isError,
    errorMessage: isError ? status.message : null,
    stats: cached ? JSON.parse('{}') : null,
  });
});

module.exports = router;
