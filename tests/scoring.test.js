const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SHELFLIFE_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'shelflife-scoring-'));

const scoring = require('../services/scoring');

function meta(appid, { name, tags = [], genres = [], devs = [], cats = [], ...rest } = {}) {
  return {
    appid, name: name ?? `Game ${appid}`,
    developers: JSON.stringify(devs), publishers: '[]', genres: JSON.stringify(genres),
    categories: JSON.stringify(cats), tags: JSON.stringify(tags),
    metacritic_score: null, steam_positive: null, steam_negative: null,
    release_date: null, igdb_collection: null, ...rest,
  };
}
const lib = (appid, playtime, extra = {}) => ({ appid, playtime_forever: playtime, playtime_2weeks: 0, ...extra });
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

test('wilsonLowerBound is honest about small samples', () => {
  const small = scoring.wilsonLowerBound(10, 10);
  const large = scoring.wilsonLowerBound(950, 1000);
  assert.ok(small < large, `${small} should be < ${large}`);
  assert.ok(large > 0.93);
  assert.strictEqual(scoring.wilsonLowerBound(0, 0), 0);
});

test('review bonus needs a real sample: 10/10 reviews earn nothing, 950/1000 earn the top tier', () => {
  const library = [lib(1, 1200), lib(2, 0), lib(3, 0)];
  const all = [
    meta(1, { tags: ['Roguelike', 'Pixel Art', 'Difficult', 'Indie'] }),
    meta(2, { tags: ['Farming'], steam_positive: 10, steam_negative: 0 }),
    meta(3, { tags: ['Farming'], steam_positive: 950, steam_negative: 50 }),
  ];
  const profile = scoring.buildProfile(library, all);
  const tiny = scoring.scoreGame(all[1], profile, library[1]);
  const big = scoring.scoreGame(all[2], profile, library[2]);
  assert.strictEqual(tiny.score, 0);
  assert.ok(big.score >= 4);
  assert.ok(big.reasons.includes('Overwhelmingly positive reviews'));
});

test('similar loved games contribute score, not just a reason', () => {
  const shared = ['Roguelike', 'Pixel Art', 'Difficult', 'Indie', 'Action'];
  const library = [lib(1, 3000), lib(2, 0), lib(3, 0)];
  const all = [
    meta(1, { name: 'Loved', tags: shared }),
    meta(2, { name: 'Twin', tags: shared }),                       // 5 shared tags → kNN fires
    meta(3, { name: 'Loose', tags: ['Roguelike', 'Pixel Art', 'Difficult', 'Indie', 'Action', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] }),
  ];
  const profile = scoring.buildProfile(library, all);
  const twin = scoring.scoreGame(all[1], profile, library[1]);
  const loose = scoring.scoreGame(all[2], profile, library[2]);
  assert.ok(twin.score > loose.score, `${twin.score} > ${loose.score}`);
  assert.ok(twin.reasons.some(r => r.includes('Loved')));
});

test('games the user bounced off penalise their tags, unless the tag is also loved', () => {
  const library = [
    lib(1, 3000, { last_played: now - 2 * DAY }),                  // loved: Strategy
    lib(10, 30, { last_played: now - 200 * DAY }),                  // bounced: Horror
    lib(11, 20, { last_played: now - 200 * DAY }),                  // bounced: Horror
    lib(12, 25, { last_played: now - 200 * DAY }),                  // bounced: Strategy (but loved elsewhere)
    lib(20, 0), lib(21, 0),
  ];
  const all = [
    meta(1, { tags: ['Strategy', 'Turn-Based'] }),
    meta(10, { tags: ['Horror', 'Survival'] }),
    meta(11, { tags: ['Horror', 'Jump Scare'] }),
    meta(12, { tags: ['Strategy', 'Real-Time'] }),
    meta(20, { tags: ['Horror', 'Survival'] }),
    meta(21, { tags: ['Puzzle'] }),
  ];
  const profile = scoring.buildProfile(library, all);
  assert.ok(profile.bounce.Horror > 0);
  const horror = scoring.scoreGame(all[4], profile, library[4]);
  const neutral = scoring.scoreGame(all[5], profile, library[5]);
  assert.ok(horror.score <= neutral.score, `bounced tags should not outscore neutral: ${horror.score} vs ${neutral.score}`);
  // Strategy is loved, so its bounce is muted: a Strategy candidate still scores well
  const strat = scoring.scoreGame(meta(30, { tags: ['Strategy', 'Turn-Based'] }), profile, { appid: 30 });
  assert.ok(strat.score > horror.score);
});

test('recently played (last 90 days) games weigh more than long-dormant ones', () => {
  const base = [lib(2, 0)];
  const recent = scoring.buildProfile([lib(1, 600, { last_played: now - 10 * DAY }), ...base],
    [meta(1, { tags: ['X'] }), meta(2, { tags: ['X'] })]);
  const dormant = scoring.buildProfile([lib(1, 600, { last_played: now - 400 * DAY }), ...base],
    [meta(1, { tags: ['X'] }), meta(2, { tags: ['X'] })]);
  assert.ok(recent.tagSeed.X.weight > dormant.tagSeed.X.weight);
});

test('topProfileTags favours niche tags over ubiquitous ones', () => {
  const library = [lib(1, 1000), lib(2, 1000), lib(3, 0), lib(4, 0), lib(5, 0)];
  const all = [
    meta(1, { tags: ['Singleplayer', 'Souls-like'] }),
    meta(2, { tags: ['Singleplayer', 'Souls-like'] }),
    meta(3, { tags: ['Singleplayer'] }), meta(4, { tags: ['Singleplayer'] }), meta(5, { tags: ['Singleplayer'] }),
  ];
  const profile = scoring.buildProfile(library, all);
  assert.strictEqual(scoring.topProfileTags(profile, 1)[0].tag, 'Souls-like');
});
