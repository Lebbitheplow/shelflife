const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// SHELFLIFE_DATA_DIR lets tests point at a throwaway directory
const DATA_DIR = process.env.SHELFLIFE_DATA_DIR || path.join(__dirname, '../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'shelflife.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS game_metadata (
    appid INTEGER PRIMARY KEY,
    name TEXT,
    short_description TEXT,
    developers TEXT,
    publishers TEXT,
    genres TEXT,
    categories TEXT,
    tags TEXT,
    metacritic_score INTEGER,
    steam_positive INTEGER,
    steam_negative INTEGER,
    trailer_mp4 TEXT,
    header_image TEXT,
    release_date TEXT,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS user_library (
    steam_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    playtime_forever INTEGER,
    playtime_2weeks INTEGER,
    last_played INTEGER,
    PRIMARY KEY (steam_id, appid)
  );

  CREATE TABLE IF NOT EXISTS user_profile (
    steam_id TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_url TEXT,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS rec_cache (
    steam_id TEXT PRIMARY KEY,
    pools TEXT,
    built_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS load_status (
    steam_id TEXT PRIMARY KEY,
    status TEXT,
    message TEXT,
    progress INTEGER,
    total INTEGER,
    updated_at INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS dismissals (
    steam_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (steam_id, appid)
  );
  CREATE INDEX IF NOT EXISTS idx_dismissals_steam ON dismissals(steam_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_achievements (
    steam_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    total INTEGER NOT NULL,
    unlocked INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (steam_id, appid)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS store_prices (
    appid INTEGER PRIMARY KEY,
    currency TEXT,
    initial INTEGER,
    final INTEGER,
    discount_percent INTEGER,
    is_free INTEGER,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discover_cache (
    steam_id TEXT PRIMARY KEY,
    pools TEXT,
    built_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS kv_cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    fetched_at INTEGER NOT NULL
  );
`);

// Migrations — must run after CREATE TABLE so they work on both fresh and existing DBs
try { db.exec('ALTER TABLE game_metadata ADD COLUMN igdb_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE game_metadata ADD COLUMN igdb_collection INTEGER'); } catch {}
try { db.exec('ALTER TABLE game_metadata ADD COLUMN esrb_rating TEXT'); } catch {}
try { db.exec('ALTER TABLE user_profile ADD COLUMN last_active INTEGER'); } catch {}
try { db.exec('ALTER TABLE game_metadata ADD COLUMN ttb_normally INTEGER'); } catch {}
try { db.exec('ALTER TABLE game_metadata ADD COLUMN ttb_completely INTEGER'); } catch {}
try { db.exec('ALTER TABLE game_metadata ADD COLUMN app_type TEXT'); } catch {}

// Game metadata
function getGameMetadata(appid) {
  return db.prepare('SELECT * FROM game_metadata WHERE appid = ?').get(appid);
}

function setGameMetadata(appid, data) {
  // INSERT OR REPLACE would wipe columns owned by other writers (igdb_id, ttb_*),
  // so preserve them explicitly from the existing row.
  const existing = db.prepare('SELECT igdb_id, igdb_collection, ttb_normally, ttb_completely FROM game_metadata WHERE appid = ?').get(appid);
  db.prepare(`
    INSERT OR REPLACE INTO game_metadata
      (appid, name, short_description, developers, publishers, genres, categories,
       tags, metacritic_score, steam_positive, steam_negative, trailer_mp4,
       header_image, release_date, esrb_rating, app_type,
       igdb_id, igdb_collection, ttb_normally, ttb_completely, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    appid,
    data.name || null,
    data.short_description || null,
    JSON.stringify(data.developers || []),
    JSON.stringify(data.publishers || []),
    JSON.stringify(data.genres || []),
    JSON.stringify(data.categories || []),
    JSON.stringify(data.tags || []),
    data.metacritic_score || null,
    data.steam_positive || null,
    data.steam_negative || null,
    data.trailer_mp4 || null,
    data.header_image || null,
    data.release_date || null,
    data.esrb_rating || null,
    data.app_type || null,
    existing?.igdb_id ?? null,
    existing?.igdb_collection ?? null,
    existing?.ttb_normally ?? null,
    existing?.ttb_completely ?? null,
    Math.floor(Date.now() / 1000)
  );
}

function getGameMetadataBatch(appids) {
  if (!appids.length) return [];
  const CHUNK = 500; // stay under SQLite's 999-variable limit
  const results = [];
  for (let i = 0; i < appids.length; i += CHUNK) {
    const chunk = appids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    results.push(...db.prepare(`SELECT * FROM game_metadata WHERE appid IN (${placeholders})`).all(...chunk));
  }
  return results;
}

function isMetadataFresh(appid, ttlDays = 30) {
  const row = db.prepare('SELECT fetched_at, esrb_rating FROM game_metadata WHERE appid = ?').get(appid);
  if (!row) return false;
  if (row.esrb_rating === null || row.esrb_rating === undefined) return false;
  return (Date.now() / 1000 - row.fetched_at) < ttlDays * 86400;
}

// User library
function getUserLibrary(steamId) {
  return db.prepare('SELECT * FROM user_library WHERE steam_id = ?').all(steamId);
}

function setUserLibrary(steamId, games) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO user_library (steam_id, appid, playtime_forever, playtime_2weeks, last_played)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const g of games) {
      upsert.run(steamId, g.appid, g.playtime_forever || 0, g.playtime_2weeks || 0, g.rtime_last_played || null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// User profile
function getUserProfile(steamId) {
  return db.prepare('SELECT * FROM user_profile WHERE steam_id = ?').get(steamId);
}

function setUserProfile(steamId, data) {
  db.prepare(`
    INSERT OR REPLACE INTO user_profile (steam_id, display_name, avatar_url, fetched_at)
    VALUES (?, ?, ?, ?)
  `).run(steamId, data.display_name, data.avatar_url, Math.floor(Date.now() / 1000));
}

function isProfileFresh(steamId, ttlHours = 6) {
  const row = db.prepare('SELECT fetched_at FROM user_profile WHERE steam_id = ?').get(steamId);
  if (!row) return false;
  return (Date.now() / 1000 - row.fetched_at) < ttlHours * 3600;
}

function updateLastActive(steamId) {
  db.prepare('UPDATE user_profile SET last_active = ? WHERE steam_id = ?')
    .run(Math.floor(Date.now() / 1000), String(steamId));
}

function getActiveUsers(sinceDays = 30) {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  return db.prepare('SELECT steam_id FROM user_profile WHERE last_active >= ?')
    .all(since).map(r => r.steam_id);
}

// Rec cache — no TTL; background refresh job handles periodic updates
function getRecCache(steamId) {
  const row = db.prepare('SELECT * FROM rec_cache WHERE steam_id = ?').get(steamId);
  if (!row) return null;
  try {
    return JSON.parse(row.pools);
  } catch {
    // Corrupt cache row — drop it so the next visit rebuilds instead of crashing every page
    clearRecCache(steamId);
    return null;
  }
}

function getRecCacheAge(steamId) {
  const row = db.prepare('SELECT built_at FROM rec_cache WHERE steam_id = ?').get(steamId);
  if (!row) return null;
  return Math.floor(Date.now() / 1000) - row.built_at;
}

function setRecCache(steamId, pools) {
  db.prepare(`
    INSERT OR REPLACE INTO rec_cache (steam_id, pools, built_at)
    VALUES (?, ?, ?)
  `).run(steamId, JSON.stringify(pools), Math.floor(Date.now() / 1000));
}

function clearRecCache(steamId) {
  db.prepare('DELETE FROM rec_cache WHERE steam_id = ?').run(steamId);
}

// Load status (for polling during cold visits)
function getLoadStatus(steamId) {
  return db.prepare('SELECT * FROM load_status WHERE steam_id = ?').get(steamId);
}

function setLoadStatus(steamId, status, message, progress = 0, total = 0) {
  db.prepare(`
    INSERT OR REPLACE INTO load_status (steam_id, status, message, progress, total, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(steamId, status, message, progress, total, Math.floor(Date.now() / 1000));
}

function clearLoadStatus(steamId) {
  db.prepare('DELETE FROM load_status WHERE steam_id = ?').run(steamId);
}

function updateTrailerUrl(appid, trailer_mp4) {
  db.prepare('UPDATE game_metadata SET trailer_mp4 = ? WHERE appid = ?').run(trailer_mp4, appid);
}

// IGDB enrichment
function setIgdbData(appid, { igdb_id, igdb_collection }) {
  db.prepare('UPDATE game_metadata SET igdb_id = ?, igdb_collection = ? WHERE appid = ?')
    .run(igdb_id ?? null, igdb_collection ?? null, appid);
}

function getUnenrichedAppids(appids) {
  if (!appids.length) return [];
  const CHUNK = 500;
  const results = [];
  for (let i = 0; i < appids.length; i += CHUNK) {
    const chunk = appids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    results.push(...db.prepare(
      `SELECT appid FROM game_metadata WHERE appid IN (${placeholders}) AND igdb_id IS NULL`
    ).all(...chunk).map(r => r.appid));
  }
  return results;
}

// Time-to-beat (IGDB game_time_to_beats) — ttb values are seconds, -1 = looked up, no data
function getTtbCandidates(appids) {
  if (!appids.length) return [];
  const CHUNK = 500;
  const results = [];
  for (let i = 0; i < appids.length; i += CHUNK) {
    const chunk = appids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    results.push(...db.prepare(
      `SELECT appid, igdb_id FROM game_metadata
       WHERE appid IN (${placeholders}) AND igdb_id > 0 AND ttb_normally IS NULL`
    ).all(...chunk));
  }
  return results;
}

function setTimeToBeat(appid, normally, completely) {
  db.prepare('UPDATE game_metadata SET ttb_normally = ?, ttb_completely = ? WHERE appid = ?')
    .run(normally, completely, appid);
}

// Store prices — short TTL because sales come and go
function setStorePrice(appid, { currency, initial, final, discount_percent, is_free }) {
  db.prepare(`
    INSERT OR REPLACE INTO store_prices (appid, currency, initial, final, discount_percent, is_free, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(appid, currency || null, initial ?? null, final ?? null, discount_percent ?? 0, is_free ? 1 : 0, Math.floor(Date.now() / 1000));
}

function getStorePrice(appid) {
  return db.prepare('SELECT * FROM store_prices WHERE appid = ?').get(appid) || null;
}

function isStorePriceFresh(appid, ttlHours = 12) {
  const row = db.prepare('SELECT fetched_at FROM store_prices WHERE appid = ?').get(appid);
  if (!row) return false;
  return (Date.now() / 1000 - row.fetched_at) < ttlHours * 3600;
}

// Discover cache — store recommendations (games the user doesn't own)
function getDiscoverCache(steamId) {
  const row = db.prepare('SELECT * FROM discover_cache WHERE steam_id = ?').get(steamId);
  if (!row) return null;
  try {
    return { pools: JSON.parse(row.pools), builtAt: row.built_at };
  } catch {
    db.prepare('DELETE FROM discover_cache WHERE steam_id = ?').run(steamId);
    return null;
  }
}

function setDiscoverCache(steamId, pools) {
  db.prepare('INSERT OR REPLACE INTO discover_cache (steam_id, pools, built_at) VALUES (?, ?, ?)')
    .run(steamId, JSON.stringify(pools), Math.floor(Date.now() / 1000));
}

function clearDiscoverCache(steamId) {
  db.prepare('DELETE FROM discover_cache WHERE steam_id = ?').run(steamId);
}

// Generic JSON key/value cache with TTL (e.g. Steam tag id map)
function getKV(key, ttlSeconds) {
  const row = db.prepare('SELECT value, fetched_at FROM kv_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (ttlSeconds != null && (Date.now() / 1000 - row.fetched_at) >= ttlSeconds) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function setKV(key, value) {
  db.prepare('INSERT OR REPLACE INTO kv_cache (key, value, fetched_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(value), Math.floor(Date.now() / 1000));
}

function healthCheck() {
  db.prepare('SELECT 1').get();
  return true;
}

function updateGameDetails(appid, { trailer_mp4, short_description, esrb_rating }) {
  db.prepare(`UPDATE game_metadata SET
    trailer_mp4 = ?,
    short_description = COALESCE(?, short_description),
    esrb_rating = COALESCE(?, esrb_rating)
    WHERE appid = ?`)
    .run(trailer_mp4 ?? null, short_description || null, esrb_rating || null, appid);
}

// Like updateGameDetails but creates the row if it doesn't exist (e.g. metadata fetch failed at load time)
function upsertTrailerDetails(appid, { trailer_mp4, short_description, esrb_rating }) {
  db.prepare('INSERT OR IGNORE INTO game_metadata (appid) VALUES (?)').run(appid);
  db.prepare(`UPDATE game_metadata SET
    trailer_mp4 = ?,
    short_description = COALESCE(?, short_description),
    esrb_rating = COALESCE(?, esrb_rating)
    WHERE appid = ?`)
    .run(trailer_mp4 ?? null, short_description || null, esrb_rating || null, appid);
}

// Dismissals
function addDismissal(steamId, appid) {
  db.prepare('INSERT OR IGNORE INTO dismissals (steam_id, appid, dismissed_at) VALUES (?, ?, ?)')
    .run(String(steamId), Number(appid), Math.floor(Date.now() / 1000));
}

function removeDismissal(steamId, appid) {
  db.prepare('DELETE FROM dismissals WHERE steam_id = ? AND appid = ?')
    .run(String(steamId), Number(appid));
}

function getDismissals(steamId) {
  const rows = db.prepare('SELECT appid FROM dismissals WHERE steam_id = ?').all(String(steamId));
  return new Set(rows.map(r => r.appid));
}

// User achievements
function setAchievements(steamId, appid, total, unlocked) {
  db.prepare(`
    INSERT OR REPLACE INTO user_achievements (steam_id, appid, total, unlocked, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(steamId, appid, total, unlocked, Math.floor(Date.now() / 1000));
}

function getAchievements(steamId) {
  const rows = db.prepare('SELECT appid, total, unlocked FROM user_achievements WHERE steam_id = ?').all(steamId);
  const map = {};
  for (const r of rows) map[r.appid] = { total: r.total, unlocked: r.unlocked };
  return map;
}

function isAchievementFresh(steamId, appid, ttlDays = 7) {
  const row = db.prepare('SELECT fetched_at FROM user_achievements WHERE steam_id = ? AND appid = ?').get(steamId, appid);
  if (!row) return false;
  return (Date.now() / 1000 - row.fetched_at) < ttlDays * 86400;
}

module.exports = {
  getGameMetadata, setGameMetadata, getGameMetadataBatch, isMetadataFresh,
  setIgdbData, getUnenrichedAppids,
  getUserLibrary, setUserLibrary,
  getUserProfile, setUserProfile, isProfileFresh, updateLastActive, getActiveUsers,
  getRecCache, setRecCache, clearRecCache, getRecCacheAge,
  getLoadStatus, setLoadStatus, clearLoadStatus,
  updateTrailerUrl, updateGameDetails, upsertTrailerDetails,
  setAchievements, getAchievements, isAchievementFresh,
  addDismissal, removeDismissal, getDismissals,
  getTtbCandidates, setTimeToBeat,
  setStorePrice, getStorePrice, isStorePriceFresh,
  getDiscoverCache, setDiscoverCache, clearDiscoverCache,
  getKV, setKV,
  healthCheck,
};
