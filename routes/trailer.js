const express = require('express');
const router = express.Router();
const db = require('../db/database');

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

function shape(trailer, desc, esrb) {
  return {
    trailer_mp4: trailer === 'none' ? null : trailer || null,
    short_description: desc || null,
    esrb_rating: esrb === 'none' ? null : esrb || null,
  };
}

// On-demand detail fetch — returns trailer_mp4 + short_description + esrb for a single game
router.get('/trailer/:appid', async (req, res) => {
  const appid = parseInt(req.params.appid);
  if (!appid) return res.status(400).json({ error: 'Invalid appid' });

  const cached = db.getGameMetadata(appid);
  const cachedEsrb = cached?.esrb_rating || null;
  const fallback = () => res.json(shape(null, cached?.short_description, cachedEsrb));

  // 'none' sentinel = already confirmed no trailer exists on Steam, stop re-fetching
  // Still re-fetch if esrb_rating is missing (null = never fetched for this field)
  if (cached?.trailer_mp4 === 'none' && cachedEsrb !== null) return fallback();
  if (cached?.trailer_mp4 && cached?.short_description && cachedEsrb !== null) {
    return res.json(shape(cached.trailer_mp4, cached.short_description, cachedEsrb));
  }

  try {
    const cc = (process.env.STORE_COUNTRY || 'us').toLowerCase();
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=en`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return fallback();

    const json = await r.json();
    const storeData = json?.[String(appid)]?.data;
    if (!storeData) return fallback();

    const movies = storeData.movies || [];
    let trailer_mp4 = movies.length
      ? (movies[0]?.hls_h264 || movies[0]?.mp4?.['480'] || movies[0]?.mp4?.max || null)
      : null;
    const short_description = storeData.short_description || cached?.short_description || null;
    const esrb_rating = storeData?.ratings?.esrb?.rating || 'none';

    // No Steam trailer — try YouTube as fallback
    if (!trailer_mp4) {
      trailer_mp4 = await searchYouTubeTrailer(storeData.name || cached?.name || null) || 'none';
    }

    db.upsertTrailerDetails(appid, { trailer_mp4, short_description, esrb_rating });
    res.json(shape(trailer_mp4, short_description, esrb_rating));
  } catch {
    fallback();
  }
});

module.exports = router;
