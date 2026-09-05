const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SHELFLIFE_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'shelflife-store-'));

const store = require('../services/steamstore');

// Trimmed copies of real rows from store.steampowered.com/search/results?json=1
const ROW_DISCOUNTED = `<a href="https://store.steampowered.com/app/2406770/Bodycam/" data-ds-appid="2406770" data-ds-itemkey="App_2406770" data-ds-tagids="[493,1663,4175]" data-ds-descids="[2,5]" class="search_result_row">
  <div class="search_capsule"><img src="https://x/capsule_231x87.jpg"></div>
  <div class="search_name ellipsis"><span class="title">Bodycam &amp; Friends</span></div>
  <div class="search_released responsive_secondrow"> Jun 7, 2024 </div>
  <div class="search_reviewscore responsive_secondrow"><span class="search_review_summary positive" data-tooltip-html="Mostly Positive&lt;br&gt;77% of the 28,868 user reviews for this game are positive."></span></div>
  <div class="search_price_discount_combined responsive_secondrow" data-price-final="2665">
    <div class="discount_block search_discount_block" data-price-final="2665" data-discount="20"><div class="discount_pct">-20%</div><div class="discount_prices"><div class="discount_original_price">$33.32</div><div class="discount_final_price">$26.65</div></div></div>
  </div></a>`;
const ROW_FULL_PRICE = `<a href="https://store.steampowered.com/app/2868840/" data-ds-appid="2868840" data-ds-tagids="[1716,1666]" class="search_result_row">
  <div class="search_name ellipsis"><span class="title">Slay the Spire 2</span></div>
  <div class="search_released responsive_secondrow"> Mar 5, 2026 </div>
  <div class="search_reviewscore responsive_secondrow"><span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;91% of the 68,592 user reviews for this game are positive."></span></div>
  <div class="search_price_discount_combined responsive_secondrow" data-price-final="2499"><div class="discount_block no_discount" data-price-final="2499" data-discount="0"></div></div></a>`;
const ROW_ADULT = `<a href="https://store.steampowered.com/app/999/" data-ds-appid="999" data-ds-tagids="[1]" data-ds-descids="[3]"><span class="title">Nope</span></a>`;
const ROW_BUNDLE = `<a href="https://store.steampowered.com/bundle/1/" data-ds-packageid="1"><span class="title">Bundle</span></a>`;

test('parseSearchResults extracts appid, tags, price, discount, reviews', () => {
  const rows = store.parseSearchResults(ROW_DISCOUNTED + ROW_FULL_PRICE + ROW_ADULT + ROW_BUNDLE, { 493: 'Action', 1716: 'Roguelike' });
  assert.strictEqual(rows.length, 3); // bundle skipped
  const [a, b, c] = rows;
  assert.strictEqual(a.appid, 2406770);
  assert.strictEqual(a.name, 'Bodycam & Friends');
  assert.deepStrictEqual(a.tags, ['Action']);
  assert.strictEqual(a.finalCents, 2665);
  assert.strictEqual(a.discountPercent, 20);
  assert.strictEqual(a.reviewPct, 77);
  assert.strictEqual(a.reviewTotal, 28868);
  assert.strictEqual(a.reviewSummary, 'Mostly Positive');
  assert.strictEqual(a.released, 'Jun 7, 2024');
  assert.strictEqual(a.adultOnly, false);

  assert.strictEqual(b.discountPercent, 0);
  assert.strictEqual(b.finalCents, 2499);
  assert.deepStrictEqual(b.tags, ['Roguelike']);
  assert.strictEqual(c.adultOnly, true);
});

test('formatPrice handles common currencies', () => {
  assert.strictEqual(store.formatPrice(2499), '$24.99');
  assert.strictEqual(store.formatPrice(1999, 'EUR'), '€19.99');
  assert.strictEqual(store.formatPrice(1200, 'JPY'), '¥12');
  assert.strictEqual(store.formatPrice(null), null);
});
