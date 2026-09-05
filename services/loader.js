/* The full data load for one user: library → metadata → reviews → IGDB →
   achievements → friends → recommendations. Then store discovery in the background. */

const db = require('../db/database');
const steamService = require('./steam');
const recommender = require('./recommender');
const igdb = require('./igdb');
const discover = require('./discover');

const ACHIEVEMENT_MIN_MINUTES = 600; // 10 hours
const ACHIEVEMENT_CAP = 50;
const DETAIL_DELAY_MS = 120; // between uncached store calls — keeps under the ~200/5min store limit

// In-flight load jobs — prevents duplicate background fetches
const loadingJobs = new Map();

async function runLoadJob(steamId) {
  if (loadingJobs.has(steamId)) return; // already running

  loadingJobs.set(steamId, true);
  const status = (msg, p = 0, t = 0) => db.setLoadStatus(steamId, 'loading', msg, p, t);
  try {
    status('Fetching your Steam library...');

    const library = await steamService.getOwnedGames(steamId);
    if (!library.length) {
      db.setLoadStatus(steamId, 'error', 'No games found. Your Steam profile may be set to Private.');
      return;
    }

    db.setUserLibrary(steamId, library);
    status(`Fetching game details (0 / ${library.length})...`, 0, library.length);

    // Prioritize unplayed games first for faster useful results
    const unplayed = library.filter(g => g.playtime_forever < 120).map(g => g.appid);
    const played = library.filter(g => g.playtime_forever >= 120).map(g => g.appid);
    const ordered = [...unplayed, ...played];

    let count = 0;
    for (const appid of ordered) {
      const fresh = db.isMetadataFresh(appid);
      await steamService.fetchAppDetails(appid);
      if (!fresh) await steamService.sleep(DETAIL_DELAY_MS);
      count++;
      if (count % 10 === 0) status(`Fetching game details (${count} / ${ordered.length})...`, count, ordered.length);
    }

    status('Fetching your Steam reviews...', ordered.length, ordered.length);
    const reviewedAppids = await steamService.getPositiveReviews(steamId);

    status('Looking up game series data...', ordered.length, ordered.length);
    await igdb.enrichLibrary(ordered);

    status('Looking up completion times...', ordered.length, ordered.length);
    await igdb.fetchTimeToBeat(ordered);

    // Achievement data for games the user has seriously played (10+ hours, top 50)
    const achievementCandidates = library
      .filter(g => g.playtime_forever >= ACHIEVEMENT_MIN_MINUTES)
      .sort((a, b) => b.playtime_forever - a.playtime_forever)
      .slice(0, ACHIEVEMENT_CAP);

    if (achievementCandidates.length) {
      status(`Fetching achievement data (0 / ${achievementCandidates.length})...`, 0, achievementCandidates.length);
      let achCount = 0;
      for (const game of achievementCandidates) {
        if (!db.isAchievementFresh(steamId, game.appid)) {
          const result = await steamService.getPlayerAchievements(steamId, game.appid);
          if (result) db.setAchievements(steamId, game.appid, result.total, result.unlocked);
          await steamService.sleep(150); // gentle rate limiting
        }
        achCount++;
        if (achCount % 10 === 0) status(`Fetching achievement data (${achCount} / ${achievementCandidates.length})...`, achCount, achievementCandidates.length);
      }
    }

    status('Checking what your friends play...', ordered.length, ordered.length);
    const friendsMap = await steamService.getFriendsPlaytimes(steamId);

    status('Building recommendations...', ordered.length, ordered.length);

    const libRows = db.getUserLibrary(steamId);
    const achievementMap = db.getAchievements(steamId);
    // Re-read metadata from the DB so IGDB enrichment (franchise + time-to-beat)
    // written above is reflected — the rows captured during the fetch loop predate it
    const allMetadata = db.getGameMetadataBatch(ordered);
    recommender.buildRecommendations(steamId, libRows, allMetadata, reviewedAppids, achievementMap, friendsMap);

    db.setLoadStatus(steamId, 'done', 'Ready', ordered.length, ordered.length);

    // Store discovery is independent of the library page — run it after so the
    // user isn't kept waiting, and only when the existing pool is stale.
    if (!discover.isDiscoverFresh(steamId)) {
      discover.runDiscoverJob(steamId).catch(err => console.error('[discover] background job failed:', err));
    }
  } catch (err) {
    console.error('[load job error]', err.message);
    db.setLoadStatus(steamId, 'error', 'Something went wrong: ' + err.message);
  } finally {
    loadingJobs.delete(steamId);
  }
}

module.exports = { runLoadJob };
