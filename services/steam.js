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

// Steam's store API throttles at roughly 200 requests per 5 minutes per IP.
// When it does, back off instead of writing degraded rows for every remaining game.
const STORE_BACKOFF_MS = 60_000;
let storeBlockedUntil = 0;

const STORE_COUNTRY = () => (process.env.STORE_COUNTRY || 'us').toLowerCase();

// Persist the price block from a store appdetails payload (free games have no price_overview)
function recordStorePrice(appid, storeData) {
  if (!storeData) return;
  const p = storeData.price_overview;
  if (storeData.is_free) {
    db.setStorePrice(appid, { currency: p?.currency || 'USD', initial: 0, final: 0, discount_percent: 0, is_free: true });
  } else if (p) {
    db.setStorePrice(appid, { currency: p.currency, initial: p.initial, final: p.final, discount_percent: p.discount_percent || 0, is_free: false });
  }
}

async function fetchAppDetails(appid, { force = false } = {}) {
  if (!force && db.isMetadataFresh(appid)) return db.getGameMetadata(appid);

  try {
    const storeAllowed = Date.now() >= storeBlockedUntil;
    const [storeRes, spyRes] = await Promise.allSettled([
      storeAllowed
        ? fetch(`${STORE_API}/appdetails?appids=${appid}&cc=${STORE_COUNTRY()}&l=en`, { signal: AbortSignal.timeout(8000) })
        : Promise.reject(new Error('store backoff')),
      fetch(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    let storeData = null;
    if (storeRes.status === 'fulfilled') {
      if (storeRes.value.status === 429 || storeRes.value.status === 403) {
        storeBlockedUntil = Date.now() + STORE_BACKOFF_MS;
        console.warn(`[steam] store API rate limited (${storeRes.value.status}) — backing off ${STORE_BACKOFF_MS / 1000}s`);
      } else if (storeRes.value.ok) {
        try {
          const json = await storeRes.value.json();
          const entry = json?.[String(appid)];
          if (entry?.success) storeData = entry.data;
        } catch { /* non-JSON response from Steam (e.g. "Connection timed out") */ }
      }
    }
    recordStorePrice(appid, storeData);

    let spyData = null;
    if (spyRes.status === 'fulfilled' && spyRes.value.ok) {
      try {
        spyData = await spyRes.value.json();
      } catch { /* non-JSON response from SteamSpy */ }
    }

    if (!storeData && !spyData) return null;

    const existing = db.getGameMetadata(appid);
    // Store call failed but we already have a full row: keep it rather than
    // overwriting genres/categories/release date with blanks from SteamSpy alone.
    if (!storeData && existing?.name && existing?.genres && existing.genres !== '[]') {
      return existing;
    }

    // Extract trailer — Steam now serves HLS/DASH streams, prefer hls_h264 for broadest compat
    // Preserve any existing trailer URL if the current API call didn't return one (rate limit / no trailer)
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
      esrb_rating: storeData?.ratings?.esrb?.rating || 'none',
      app_type: storeData?.type || existing?.app_type || null,
    };

    db.setGameMetadata(appid, metadata);
    return db.getGameMetadata(appid);
  } catch (err) {
    console.warn(`[steam] appdetails failed for ${appid}:`, err.message);
    return null;
  }
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

  return appids;
}

// Fetch the user's friend list — empty array if the friends list is private
async function getFriendList(steamId) {
  try {
    const url = `${STEAM_API}/ISteamUser/GetFriendList/v1/?key=${STEAM_API_KEY()}&steamid=${steamId}&relationship=friend`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return []; // Steam returns 401 for private friends lists
    const json = await res.json();
    return (json.friendslist?.friends || []).map(f => f.steamid);
  } catch {
    return [];
  }
}

// Build appid → { count, topMinutes } across the user's friends, counting only
// games a friend has genuinely played (2+ hours). Capped to keep the load job
// bounded; friends with private libraries contribute nothing and are skipped.
const FRIEND_PLAYED_MIN_MINUTES = 120;

async function getFriendsPlaytimes(steamId, cap = 25) {
  const friends = (await getFriendList(steamId)).slice(0, cap);
  const map = {};
  for (const friendId of friends) {
    try {
      const games = await getOwnedGames(friendId);
      for (const g of games) {
        if ((g.playtime_forever || 0) < FRIEND_PLAYED_MIN_MINUTES) continue;
        const entry = map[g.appid] || (map[g.appid] = { count: 0, topMinutes: 0 });
        entry.count++;
        if (g.playtime_forever > entry.topMinutes) entry.topMinutes = g.playtime_forever;
      }
    } catch { /* private library or API blip — skip this friend */ }
    await sleep(150); // gentle rate limiting
  }
  return map;
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

module.exports = { resolveToSteamId, getPlayerSummary, getOwnedGames, fetchAppDetails, getPositiveReviews, getPlayerAchievements, getFriendList, getFriendsPlaytimes, sleep };
