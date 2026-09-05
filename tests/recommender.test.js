const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the DB at a throwaway directory BEFORE the db module loads
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelflife-test-'));
process.env.SHELFLIFE_DATA_DIR = tmpDir;

const recommender = require('../services/recommender');
const db = require('../db/database');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────
// Metadata rows shaped like the SQLite rows the recommender consumes
// (JSON fields are stored as strings).
function meta(appid, { name, tags = [], genres = [], devs = [], cats = [], ...rest } = {}) {
  return {
    appid,
    name: name ?? `Game ${appid}`,
    short_description: null,
    developers: JSON.stringify(devs),
    publishers: JSON.stringify([]),
    genres: JSON.stringify(genres),
    categories: JSON.stringify(cats),
    tags: JSON.stringify(tags),
    metacritic_score: null,
    steam_positive: null,
    steam_negative: null,
    trailer_mp4: null,
    header_image: null,
    release_date: null,
    igdb_id: null,
    igdb_collection: null,
    esrb_rating: null,
    ttb_normally: null,
    ttb_completely: null,
    ...rest,
  };
}

function lib(appid, playtime, twoWeeks = 0) {
  return { appid, playtime_forever: playtime, playtime_2weeks: twoWeeks };
}

// A small library: one heavily-played game plus three unplayed candidates
function fixture() {
  const library = [
    lib(1, 1200), // loved: 20h
    lib(2, 0),    // candidate, strong match
    lib(3, 0),    // candidate, unrelated
    lib(4, 30),   // candidate, barely started
  ];
  const allMetadata = [
    meta(1, { name: 'Loved Game', tags: ['Roguelike', 'Pixel Art', 'Difficult'], genres: ['Action'], devs: ['Tiny Studio'] }),
    meta(2, { name: 'Strong Match', tags: ['Roguelike', 'Pixel Art', 'Difficult'], genres: ['Action'], devs: ['Tiny Studio'] }),
    meta(3, { name: 'Unrelated Game', tags: ['Farming', 'Relaxing'], genres: ['Simulation'], devs: ['Other Dev'] }),
    meta(4, { name: 'Barely Started', tags: ['Roguelike'], genres: ['Action'], devs: ['Someone'] }),
  ];
  return { library, allMetadata };
}

// ── tieredSample ────────────────────────────────────────────────────────────

test('tieredSample returns a copy when the pool fits', () => {
  const pool = [1, 2, 3];
  const out = recommender.tieredSample(pool, 10);
  assert.deepStrictEqual([...out].sort(), [1, 2, 3]);
  assert.notStrictEqual(out, pool);
});

test('tieredSample returns n items drawn from the pool', () => {
  const pool = Array.from({ length: 100 }, (_, i) => i);
  const out = recommender.tieredSample(pool, 20);
  assert.strictEqual(out.length, 20);
  for (const item of out) assert.ok(pool.includes(item));
  assert.strictEqual(new Set(out).size, 20); // no duplicates
});

// ── buildRecommendations ────────────────────────────────────────────────────

test('matching candidate outscores unrelated candidate and gets reasons', () => {
  const { library, allMetadata } = fixture();
  const pools = recommender.buildRecommendations('s1', library, allMetadata);

  const match = pools.topPicks.find(g => g.appid === 2);
  const unrelated = pools.topPicks.find(g => g.appid === 3);
  assert.ok(match && unrelated);
  assert.ok(match.score > unrelated.score, `expected ${match.score} > ${unrelated.score}`);
  assert.ok(match.reasons.length > 0);
  assert.strictEqual(pools.topPicks[0].appid, 2);
});

test('loved games are excluded from candidates; pools split by playtime', () => {
  const { library, allMetadata } = fixture();
  const pools = recommender.buildRecommendations('s1', library, allMetadata);

  assert.ok(!pools.topPicks.some(g => g.appid === 1));
  assert.deepStrictEqual(pools.neverTouched.map(g => g.appid).sort(), [2, 3]);
  assert.deepStrictEqual(pools.almostStarted.map(g => g.appid), [4]);
});

test('franchise match via shared igdb_collection adds a series reason', () => {
  const { library, allMetadata } = fixture();
  allMetadata[0].igdb_collection = 77; // Loved Game
  allMetadata[2].igdb_collection = 77; // Unrelated Game now shares the franchise
  const pools = recommender.buildRecommendations('s1', library, allMetadata);

  const candidate = pools.topPicks.find(g => g.appid === 3);
  assert.ok(candidate.reasons.some(r => r.includes('Loved Game')),
    `expected a franchise reason, got: ${candidate.reasons.join(' | ')}`);
});

test('duplicate names are deduplicated keeping the higher-scored entry', () => {
  const { library, allMetadata } = fixture();
  library.push(lib(5, 0));
  allMetadata.push(meta(5, { name: 'Strong Match' })); // same name as appid 2, no signals
  const pools = recommender.buildRecommendations('s1', library, allMetadata);

  const matches = pools.topPicks.filter(g => g.name === 'Strong Match');
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].appid, 2);
});

test('time-to-beat passes through; -1 sentinel becomes null', () => {
  const { library, allMetadata } = fixture();
  allMetadata[1].ttb_normally = 36000; // 10h
  allMetadata[1].ttb_completely = 72000;
  allMetadata[2].ttb_normally = -1; // looked up, no data
  const pools = recommender.buildRecommendations('s1', library, allMetadata);

  assert.strictEqual(pools.topPicks.find(g => g.appid === 2).ttb_normally, 36000);
  assert.strictEqual(pools.topPicks.find(g => g.appid === 3).ttb_normally, null);
});

test('stats include hours played and backlog hours from known time-to-beat', () => {
  const { library, allMetadata } = fixture();
  allMetadata[1].ttb_normally = 36000; // 10h, appid 2 (never played)
  const pools = recommender.buildRecommendations('s1', library, allMetadata);

  assert.strictEqual(pools.stats.total, 4);
  assert.strictEqual(pools.stats.neverPlayed, 2);
  assert.strictEqual(pools.stats.almostStarted, 1);
  assert.strictEqual(pools.stats.hoursPlayed, Math.round((1200 + 30) / 60));
  assert.strictEqual(pools.stats.backlogHours, 10);
  assert.strictEqual(pools.stats.backlogKnownCount, 1);
});

test('friendsPlayed pool is sorted by friend count then score', () => {
  const { library, allMetadata } = fixture();
  const friendsMap = {
    3: { count: 3, topMinutes: 600 },
    2: { count: 1, topMinutes: 90 },
  };
  const pools = recommender.buildRecommendations('s1', library, allMetadata, new Set(), {}, friendsMap);

  assert.deepStrictEqual(pools.friendsPlayed.map(g => g.appid), [3, 2]);
  assert.deepStrictEqual(pools.friendsPlayed[0].friends, { count: 3, topMinutes: 600 });
  assert.strictEqual(pools.topPicks.find(g => g.appid === 4).friends, null);
});

// ── samplePools ─────────────────────────────────────────────────────────────

test('samplePools filters dismissed games from every pool', () => {
  const { library, allMetadata } = fixture();
  const pools = recommender.buildRecommendations('s1', library, allMetadata, new Set(), {}, { 2: { count: 1, topMinutes: 300 } });
  const sampled = recommender.samplePools(pools, new Set([2]));

  for (const key of ['top20', 'topPicks', 'neverTouched', 'almostStarted', 'friendsPlayed']) {
    assert.ok(!sampled[key].some(g => g.appid === 2), `appid 2 leaked into ${key}`);
  }
  for (const games of Object.values(sampled.byGenre)) {
    assert.ok(!games.some(g => g.appid === 2), 'appid 2 leaked into byGenre');
  }
});

test('samplePools tolerates caches built before friendsPlayed existed', () => {
  const { library, allMetadata } = fixture();
  const pools = recommender.buildRecommendations('s1', library, allMetadata);
  delete pools.friendsPlayed; // simulate an old cache row
  const sampled = recommender.samplePools(pools, new Set());
  assert.deepStrictEqual(sampled.friendsPlayed, []);
});

// ── rec cache round trip (also covers the corrupt-JSON guard) ───────────────

test('rec cache round-trips through SQLite and survives corruption', () => {
  const { library, allMetadata } = fixture();
  recommender.buildRecommendations('s9', library, allMetadata);

  const cached = db.getRecCache('s9');
  assert.ok(cached && cached.topPicks.length > 0);

  // Corrupt the stored JSON directly — getRecCache should self-heal, not throw
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(tmpDir, 'shelflife.db'));
  raw.prepare('UPDATE rec_cache SET pools = ? WHERE steam_id = ?').run('{not json', 's9');
  raw.close();

  assert.strictEqual(db.getRecCache('s9'), null);
  assert.strictEqual(db.getRecCacheAge('s9'), null); // corrupt row was deleted
});

test('diversify caps repeats per developer and per series', () => {
  const ranked = [
    { appid: 1, developers: ['A'], series: 7 },
    { appid: 2, developers: ['A'], series: 7 },
    { appid: 3, developers: ['A'], series: null },   // third from dev A → skipped
    { appid: 4, developers: ['B'], series: 7 },      // third in series 7 → skipped
    { appid: 5, developers: ['C'], series: null },
  ];
  assert.deepStrictEqual(recommender.diversify(ranked, 3).map(g => g.appid), [1, 2, 5]);
  // Too few survivors → plain ranked order
  assert.deepStrictEqual(recommender.diversify(ranked.slice(0, 3), 3).map(g => g.appid), [1, 2, 3]);
});
