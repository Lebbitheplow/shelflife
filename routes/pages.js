const express = require('express');
const router = express.Router();
const db = require('../db/database');
const steamService = require('../services/steam');
const { runLoadJob } = require('./api');

// Landing page
router.get('/', (req, res) => {
  res.render('index');
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
