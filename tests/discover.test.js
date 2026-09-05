const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SHELFLIFE_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'shelflife-discover-'));

const discover = require('../services/discover');
const db = require('../db/database');

test('preScore prefers well-reviewed games matching the taste profile', () => {
  const profile = { tags: { Roguelike: 1, Farming: 0.1 }, tagIDF: { Roguelike: 1.2, Farming: 1.2 } };
  const match = { tags: ['Roguelike'], reviewPct: 95, reviewTotal: 5000, discountPercent: 0 };
  const miss = { tags: ['Farming'], reviewPct: 60, reviewTotal: 50, discountPercent: 50 };
  assert.ok(discover.preScore(match, profile) > discover.preScore(miss, profile));
});

test('filterDiscover hides dismissed games from every pool', () => {
  const pools = { picks: [{ appid: 1 }, { appid: 2 }], onSale: [{ appid: 2 }], free: [], browsedTags: ['x'] };
  const out = discover.filterDiscover(pools, new Set([2]));
  assert.deepStrictEqual(out.picks.map(g => g.appid), [1]);
  assert.deepStrictEqual(out.onSale, []);
  assert.deepStrictEqual(out.browsedTags, ['x']);
});

test('discover cache round-trips and reports freshness', () => {
  assert.strictEqual(discover.isDiscoverFresh('76561198000000001'), false);
  db.setDiscoverCache('76561198000000001', { picks: [{ appid: 5 }], onSale: [], free: [] });
  assert.strictEqual(discover.isDiscoverFresh('76561198000000001'), true);
  assert.deepStrictEqual(db.getDiscoverCache('76561198000000001').pools.picks, [{ appid: 5 }]);
  db.clearDiscoverCache('76561198000000001');
  assert.strictEqual(db.getDiscoverCache('76561198000000001'), null);
});

test('store prices persist with a short TTL and free flag', () => {
  db.setStorePrice(42, { currency: 'USD', initial: 1999, final: 999, discount_percent: 50, is_free: false });
  const p = db.getStorePrice(42);
  assert.strictEqual(p.final, 999);
  assert.strictEqual(p.discount_percent, 50);
  assert.strictEqual(db.isStorePriceFresh(42), true);
  assert.strictEqual(db.isStorePriceFresh(43), false);
});

test('setGameMetadata preserves IGDB and time-to-beat columns on refresh', () => {
  db.setGameMetadata(77, { name: 'Keep Me', tags: ['A'] });
  db.setIgdbData(77, { igdb_id: 123, igdb_collection: 9 });
  db.setTimeToBeat(77, 3600, 7200);
  db.setGameMetadata(77, { name: 'Keep Me v2', tags: ['A', 'B'], app_type: 'game' });
  const row = db.getGameMetadata(77);
  assert.strictEqual(row.name, 'Keep Me v2');
  assert.strictEqual(row.igdb_id, 123);
  assert.strictEqual(row.ttb_normally, 3600);
  assert.strictEqual(row.app_type, 'game');
});
