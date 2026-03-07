const db = require('../db/database');

const CLIENT_ID = () => process.env.IGDB_CLIENT_ID;
const CLIENT_SECRET = () => process.env.IGDB_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const id = CLIENT_ID();
  const secret = CLIENT_SECRET();
  if (!id || !secret) return null;

  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`,
    { method: 'POST', signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiry = Date.now() + (json.expires_in - 3600) * 1000;
  return cachedToken;
}

async function igdbQuery(endpoint, body) {
  const token = await getToken();
  if (!token) return [];
  try {
    const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-ID': CLIENT_ID(),
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// Normalize game names for matching: strip trademark symbols and extra whitespace
function normalizeName(name) {
  return name.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Enrich a list of Steam appids with IGDB franchise data via name lookup.
// Uses the games endpoint with exact name matching — more reliable than external_games
// which has very sparse Steam coverage. Skips already-enriched games.
async function enrichLibrary(appids) {
  if (!CLIENT_ID() || !CLIENT_SECRET()) return;

  const toEnrich = db.getUnenrichedAppids(appids);
  if (!toEnrich.length) return;

  const metaList = toEnrich
    .map(id => db.getGameMetadata(id))
    .filter(m => m && m.name);

  if (!metaList.length) return;
  console.log(`[igdb] Enriching ${metaList.length} games by name...`);

  let matched = 0;

  // Batch name lookups — IGDB allows many names in one where clause
  for (const batch of chunk(metaList, 40)) {
    try {
      // Build name list, escaping quotes and stripping trademark symbols
      const namesList = batch
        .map(m => `"${normalizeName(m.name).replace(/"/g, '')}"`)
        .join(',');

      const results = await igdbQuery(
        'games',
        `fields id,name,franchises,first_release_date; where name = (${namesList}); limit 500;`
      );

      // Map: normalized_name → best IGDB match (prefer entries that have franchise data)
      const resultMap = {};
      for (const r of results) {
        const key = normalizeName(r.name).toLowerCase();
        const existing = resultMap[key];
        const hasFranchise = r.franchises?.length > 0;
        if (!existing || (hasFranchise && !existing.franchise)) {
          resultMap[key] = { igdb_id: r.id, franchise: r.franchises?.[0] ?? null };
        }
      }

      for (const meta of batch) {
        const key = normalizeName(meta.name).toLowerCase();
        const match = resultMap[key];
        if (match) {
          db.setIgdbData(meta.appid, { igdb_id: match.igdb_id, igdb_collection: match.franchise });
          if (match.franchise) matched++;
        } else {
          // Mark as looked up so we don't retry on every load
          db.setIgdbData(meta.appid, { igdb_id: -1, igdb_collection: null });
        }
      }
    } catch (err) {
      console.warn('[igdb] Batch error:', err.message);
    }

    await sleep(300); // ~3 req/sec, well under the 4/sec rate limit
  }

  console.log(`[igdb] Enrichment complete — ${matched}/${metaList.length} franchise matches`);
}

module.exports = { enrichLibrary };
