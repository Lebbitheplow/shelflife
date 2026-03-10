const db = require('../db/database');

const STEAM_API_KEY = () => process.env.STEAM_API_KEY;
const STEAM_API = 'https://api.steampowered.com';
const STORE_API = 'https://store.steampowered.com/api';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Parse a Steam profile URL or vanity name into a SteamID64 or vanity string
function parseInput(input) {
  input = input.trim();
  // Full profile URL: /profiles/76561198XXXXXXXXX
  const profileMatch = input.match(/\/profiles\/(\d{17})/);
  if (profileMatch) return { type: 'steamid', value: profileMatch[1] };
  // Vanity URL: /id/username
  const vanityMatch = input.match(/\/id\/([^\/\?]+)/);
  if (vanityMatch) return { type: 'vanity', value: vanityMatch[1] };
  // Raw SteamID64 (17 digits)
  if (/^\d{17}$/.test(input)) return { type: 'steamid', value: input };
  // Treat anything else as a vanity name
  return { type: 'vanity', value: input };
}

async function resolveToSteamId(input) {
  const parsed = parseInput(input);
  if (parsed.type === 'steamid') return parsed.value;

  const url = `${STEAM_API}/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY()}&vanityurl=${encodeURIComponent(parsed.value)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Steam API error ${res.status}`);
  const json = await res.json();
  const resp = json.response;
  if (resp.success !== 1) throw new Error('Could not find a Steam profile for that URL or username.');
  return resp.steamid;
}

async function getPlayerSummary(steamId) {
  const url = `${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY()}&steamids=${steamId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Steam API error ${res.status}`);
  const json = await res.json();
  const player = json.response?.players?.[0];
  if (!player) throw new Error('Steam profile not found.');
  return player;
}

async function getOwnedGames(steamId) {
  const url = `${STEAM_API}/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY()}&steamid=${steamId}&include_appinfo=false&include_played_free_games=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Steam API error ${res.status}`);
  const json = await res.json();
  return json.response?.games || [];
}

async function fetchAppDetails(appid) {
  if (db.isMetadataFresh(appid)) return db.getGameMetadata(appid);

  try {
    const [storeRes, spyRes] = await Promise.allSettled([
      fetch(`${STORE_API}/appdetails?appids=${appid}&cc=us&l=en`, { signal: AbortSignal.timeout(8000) }),
      fetch(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    let storeData = null;
    if (storeRes.status === 'fulfilled' && storeRes.value.ok) {
      try {
        const json = await storeRes.value.json();
        const entry = json?.[String(appid)];
        if (entry?.success) storeData = entry.data;
      } catch { /* non-JSON response from Steam (e.g. "Connection timed out") */ }
    }

    let spyData = null;
    if (spyRes.status === 'fulfilled' && spyRes.value.ok) {
      try {
        spyData = await spyRes.value.json();
      } catch { /* non-JSON response from SteamSpy */ }
    }

    if (!storeData && !spyData) return null;

    // Extract trailer — Steam now serves HLS/DASH streams, prefer hls_h264 for broadest compat
    // Preserve any existing trailer URL if the current API call didn't return one (rate limit / no trailer)
    const existing = db.getGameMetadata(appid);
    let trailer_mp4 = existing?.trailer_mp4 || null;
    if (storeData?.movies?.length) {
      const movie = storeData.movies[0];
      trailer_mp4 = movie?.hls_h264 || movie?.mp4?.['480'] || movie?.mp4?.max || trailer_mp4;
    }

    // SteamSpy tags — sorted by vote count descending
    let tags = [];
    if (spyData?.tags && typeof spyData.tags === 'object') {
      tags = Object.entries(spyData.tags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([tag]) => tag);
    }

    const metadata = {
      name: storeData?.name || spyData?.name || null,
      short_description: storeData?.short_description || null,
      developers: storeData?.developers || (spyData?.developer ? [spyData.developer] : []),
      publishers: storeData?.publishers || (spyData?.publisher ? [spyData.publisher] : []),
      genres: (storeData?.genres || []).map(g => g.description),
      categories: (storeData?.categories || []).map(c => c.description),
      tags,
      metacritic_score: storeData?.metacritic?.score || null,
      steam_positive: spyData?.positive || storeData?.recommendations?.total || null,
      steam_negative: spyData?.negative || null,
      trailer_mp4,
      header_image: storeData?.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      release_date: storeData?.release_date?.date || null,
    };

    db.setGameMetadata(appid, metadata);
    return db.getGameMetadata(appid);
  } catch (err) {
    console.warn(`[steam] appdetails failed for ${appid}:`, err.message);
    return null;
  }
}

// Fetch metadata for a batch of appids with rate-limiting
async function fetchMetadataBatch(appids, onProgress) {
  const results = [];
  const DELAY = 250; // ms between calls

  for (let i = 0; i < appids.length; i++) {
    const appid = appids[i];

    // Use cached if fresh
    if (db.isMetadataFresh(appid)) {
      results.push(db.getGameMetadata(appid));
    } else {
      const data = await fetchAppDetails(appid);
      if (data) results.push(data);
      await sleep(DELAY);
    }

    if (onProgress) onProgress(i + 1, appids.length);
  }

  return results;
}

// Fetch all positive reviews the user has written — returns Set of appids they thumbed up
async function getPositiveReviews(steamId) {
  const appids = new Set();
  try {
    // Steam community review page — returns up to 100 per cursor page
    let cursor = '*';
    let pages = 0;
    while (pages < 10) { // cap at 10 pages (1000 reviews)
      const url = `https://store.steampowered.com/appreviews/recent?json=1&steamid=${steamId}&filter=all&language=all&cursor=${encodeURIComponent(cursor)}&num_per_page=100`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) break;
      const json = await res.json();
      const reviews = json.reviews || [];
      if (!reviews.length) break;
      for (const r of reviews) {
        if (r.voted_up) appids.add(r.appid || r.recommendationid);
      }
      cursor = json.cursor;
      if (!cursor || reviews.length < 100) break;
      pages++;
      await sleep(200);
    }
  } catch (err) {
    console.warn('[steam] reviews fetch failed:', err.message);
  }

  // Fallback: use the ISteamUser recommended endpoint
  if (!appids.size) {
    try {
      const url = `${STEAM_API}/IReviewService/GetOwnedGames/v1/?key=${STEAM_API_KEY()}&steamid=${steamId}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = await res.json();
        for (const r of (json.response?.reviews || [])) {
          if (r.voted_up) appids.add(r.appid);
        }
      }
    } catch {}
  }

  return appids;
}

// Fetch achievement progress for a single game — returns { total, unlocked } or null
async function getPlayerAchievements(steamId, appid) {
  try {
    const url = `${STEAM_API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_API_KEY()}&steamid=${steamId}&appid=${appid}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    const achievements = json.playerstats?.achievements;
    if (!achievements) return { total: 0, unlocked: 0 }; // game has no achievements schema
    const total = achievements.length;
    const unlocked = achievements.filter(a => a.achieved === 1).length;
    return { total, unlocked };
  } catch {
    return null;
  }
}

module.exports = { resolveToSteamId, getPlayerSummary, getOwnedGames, fetchAppDetails, fetchMetadataBatch, getPositiveReviews, getPlayerAchievements };
