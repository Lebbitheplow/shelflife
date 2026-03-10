const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/shelflife.db');
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
  CREATE TABLE IF NOT EXISTS user_achievements (
    steam_id TEXT NOT NULL,
    appid INTEGER NOT NULL,
    total INTEGER NOT NULL,
    unlocked INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (steam_id, appid)
  );
`);

// Migrations — must run after CREATE TABLE so they work on both fresh and existing DBs
try { db.exec('ALTER TABLE game_metadata ADD COLUMN igdb_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE game_metadata ADD COLUMN igdb_collection INTEGER'); } catch {}

// Game metadata
function getGameMetadata(appid) {
  return db.prepare('SELECT * FROM game_metadata WHERE appid = ?').get(appid);
}

function setGameMetadata(appid, data) {
  db.prepare(`
    INSERT OR REPLACE INTO game_metadata
      (appid, name, short_description, developers, publishers, genres, categories,
       tags, metacritic_score, steam_positive, steam_negative, trailer_mp4,
       header_image, release_date, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function isMetadataFresh(appid, ttlDays = 7) {
  const row = db.prepare('SELECT fetched_at FROM game_metadata WHERE appid = ?').get(appid);
  if (!row) return false;
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

// Rec cache
function getRecCache(steamId) {
  const row = db.prepare('SELECT * FROM rec_cache WHERE steam_id = ?').get(steamId);
  if (!row) return null;
  const age = Date.now() / 1000 - row.built_at;
  if (age > 6 * 3600) return null; // 6 hour TTL
  return JSON.parse(row.pools);
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

function updateGameDetails(appid, { trailer_mp4, short_description }) {
  // Always overwrite trailer_mp4 (may be 'none' sentinel); only COALESCE description
  db.prepare('UPDATE game_metadata SET trailer_mp4 = ?, short_description = COALESCE(?, short_description) WHERE appid = ?')
    .run(trailer_mp4 ?? null, short_description || null, appid);
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
  getUserProfile, setUserProfile, isProfileFresh,
  getRecCache, setRecCache, clearRecCache,
  getLoadStatus, setLoadStatus, clearLoadStatus,
  updateTrailerUrl, updateGameDetails,
  setAchievements, getAchievements, isAchievementFresh,
};
