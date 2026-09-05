/* ShelfLife — shared helpers, loaded before cards.js / modal.js / app.js / store.js / landing.js */

// Escape a string for safe interpolation into innerHTML templates
function esc(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Format a time-to-beat value (seconds) as "~12h" / "~45m"
function formatTtb(seconds) {
  const hours = seconds / 3600;
  if (hours >= 1) return `~${Math.round(hours)}h`;
  return `~${Math.max(1, Math.round(seconds / 60))}m`;
}

function playtimeLabel(minutes) {
  if (!minutes) return 'Never played';
  if (minutes < 60) return `${minutes} min played`;
  return `${Math.floor(minutes / 60)}h played`;
}

// Shelf Score tier + human label. Uses the pre-normalized displayScore when present.
function scoreOf(game) {
  if (game.displayScore != null) return game.displayScore;
  if (game.score == null) return null;
  return Math.round(Math.min(96, game.score / 1.24));
}
function scoreTier(score) {
  if (score == null) return 'none';
  return score >= 80 ? 'top' : score >= 60 ? 'high' : score >= 40 ? 'mid' : score >= 20 ? 'low' : 'none';
}
const TIER_LABELS = { top: 'Outstanding match', high: 'Strong match', mid: 'Decent match', low: 'Partial match', none: 'Weak match' };

const SCORE_SVG = '<svg viewBox="0 0 32 27" fill="none" aria-hidden="true"><path d="M16,8 C12,2 4,4 4,10 C4,17 10,21 16,25 C22,21 28,17 28,10 C28,4 20,2 16,8Z" stroke="currentColor" stroke-width="1.5"/><polyline points="5,14 8,14 10,12 12,20 14,6 16,14 20,14 27,14" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Steam review summary from raw counts → { pct, total, label }
function reviewSummary(game) {
  if (game.steam_positive == null || game.steam_negative == null) return null;
  const total = game.steam_positive + game.steam_negative;
  if (!total) return null;
  const pct = Math.round((game.steam_positive / total) * 100);
  const label = pct >= 95 ? 'Overwhelmingly Positive'
    : pct >= 85 ? 'Very Positive'
    : pct >= 70 ? 'Mostly Positive'
    : pct >= 40 ? 'Mixed'
    : pct >= 20 ? 'Mostly Negative'
    : 'Overwhelmingly Negative';
  return { pct, total, label };
}

function compactCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// Steam CDN art helpers
function headerArt(game) {
  return game.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
}
function heroArt(game) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/library_hero.jpg`;
}
function steamUrl(game) {
  return `https://store.steampowered.com/app/${game.appid}`;
}

// Small transient notification at the bottom of the screen
function toast(message, kind) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'ok' ? ' toast--ok' : '');
  el.setAttribute('role', 'status');
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// Tag whose text scrolls horizontally if it overflows its container
function makeScrollTag(text, outerClass) {
  const tag = document.createElement('span');
  tag.className = outerClass;
  const inner = document.createElement('span');
  inner.className = 'scroll-inner';
  inner.textContent = text;
  tag.appendChild(inner);
  setTimeout(function () {
    const cs = getComputedStyle(tag);
    const tagExtra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
                     parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const overflow = inner.getBoundingClientRect().width - (tag.getBoundingClientRect().width - tagExtra);
    if (overflow > 1) {
      const dist = Math.ceil(overflow) + 6;
      const dur = Math.max(3, (dist / 40 + 2)).toFixed(1) + 's';
      tag.style.setProperty('--tag-scroll-dist', '-' + dist + 'px');
      tag.style.setProperty('--tag-scroll-duration', dur);
      tag.classList.add('scroll-active');
    }
  }, 50);
  return tag;
}

// Lock/unlock page scroll while an overlay is open
function lockScroll(on) { document.body.style.overflow = on ? 'hidden' : ''; }
