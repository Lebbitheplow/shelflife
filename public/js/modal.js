/* ShelfLife — detail modal (shelf + store games). Requires helpers.js. */

const ESRB_IMGS = {
  'e': '/esrb/E.svg', 'e10': '/esrb/E10plus.svg', 'e10+': '/esrb/E10plus.svg',
  't': '/esrb/T.svg', 'm': '/esrb/M.svg', 'ao': '/esrb/AO.svg', 'rp': '/esrb/RP.svg',
};

function renderEsrbBadge(container, rating) {
  container.querySelector('.esrb-badge')?.remove();
  if (!rating || rating === 'none') return;
  const src = ESRB_IMGS[rating.toLowerCase()];
  if (!src) return;
  const img = document.createElement('img');
  img.className = 'esrb-badge';
  img.src = src;
  img.alt = `ESRB ${rating}`;
  container.appendChild(img);
}

const backdrop = document.getElementById('modal-backdrop');
const modalHero = document.getElementById('modal-hero');
const modalTrailer = document.getElementById('modal-trailer');
let hlsInstance = null;
let currentGame = null;

function statTile(label, value, cls, sub) {
  const tile = document.createElement('div');
  tile.className = 'stat-tile';
  tile.innerHTML = `<div class="stat-tile-label">${esc(label)}</div><div class="stat-tile-value${cls ? ' ' + cls : ''}"></div>`;
  const v = tile.querySelector('.stat-tile-value');
  if (value instanceof Node) v.appendChild(value); else v.textContent = value;
  if (sub) {
    const s = document.createElement('div');
    s.className = 'stat-tile-sub';
    s.textContent = sub;
    tile.appendChild(s);
  }
  return tile;
}

function renderModalStats(game) {
  const statsEl = document.getElementById('modal-stats');
  statsEl.innerHTML = '';
  if (game.price) {
    const p = game.price;
    const node = document.createElement('span');
    if (p.isFree) node.textContent = 'Free';
    else if (p.discount > 0) node.innerHTML = `<s>${esc(p.initialFormatted)}</s>${esc(p.finalFormatted)}`;
    else node.textContent = p.finalFormatted;
    statsEl.appendChild(statTile('Price', node, p.discount > 0 || p.isFree ? 'green' : '', p.discount > 0 ? `${p.discount}% off right now` : null));
  } else {
    statsEl.appendChild(statTile('Playtime', playtimeLabel(game.playtime)));
  }
  statsEl.appendChild(statTile('To beat', game.ttb_normally ? `${formatTtb(game.ttb_normally)} main` : '—', '',
    game.ttb_completely ? `${formatTtb(game.ttb_completely)} completionist` : null));
  const rev = reviewSummary(game);
  statsEl.appendChild(statTile('Reviews', rev ? `${rev.pct}%` : (game.reviewSummary || '—'), rev ? 'steam' : '',
    rev ? `${rev.label} · ${compactCount(rev.total)}` : null));
  statsEl.appendChild(statTile('Metacritic', game.metacritic_score || '—', game.metacritic_score ? 'gold' : ''));
}

function openModal(game) {
  currentGame = game;
  document.getElementById('modal-title').textContent = game.name;

  // Meta row: year · developer · publisher
  const year = game.release_date ? String(game.release_date).match(/\d{4}/)?.[0] : null;
  const devs = (game.developers || []).join(', ');
  const pubs = (game.publishers || []).filter(p => !game.developers?.includes(p)).join(', ');
  document.getElementById('modal-meta').textContent = [year, devs, pubs].filter(Boolean).join(' · ');

  // Shelf Score badge + ESRB
  const ratingsEl = document.getElementById('modal-ratings');
  ratingsEl.innerHTML = '';
  const score = scoreOf(game);
  if (score != null) {
    const tier = scoreTier(score);
    const ss = document.createElement('div');
    ss.className = `shelf-score tier--${tier}`;
    ss.title = 'Shelf Score';
    ss.innerHTML = `${SCORE_SVG}<span>${score}</span><span class="shelf-score-label">· ${TIER_LABELS[tier]}</span>`;
    if (game.reasons?.length) {
      ss.classList.add('shelf-score--clickable');
      ss.addEventListener('click', e => { e.stopPropagation(); showReasonsPopup(ss, game.reasons, tier); });
    }
    ratingsEl.appendChild(ss);
  }
  if (game.friends?.count) {
    const f = document.createElement('span');
    f.className = 'chip chip--green';
    const topHours = Math.floor((game.friends.topMinutes || 0) / 60);
    f.textContent = `${game.friends.count} friend${game.friends.count === 1 ? '' : 's'} played` + (topHours >= 1 ? ` · top ${topHours}h` : '');
    ratingsEl.appendChild(f);
  }
  if (game.esrb_rating && game.esrb_rating.toLowerCase() !== 'none') renderEsrbBadge(ratingsEl, game.esrb_rating);

  renderModalStats(game);

  // Reasons, tags, description
  const reasonsEl = document.getElementById('modal-reasons');
  reasonsEl.innerHTML = '';
  for (const r of (game.reasons || [])) reasonsEl.appendChild(makeScrollTag(r, 'reason-chip'));

  const tagsEl = document.getElementById('modal-tags');
  tagsEl.innerHTML = '';
  for (const cat of (game.categories || []).slice(0, 4)) {
    const c = document.createElement('span'); c.className = 'cat-chip'; c.textContent = cat; tagsEl.appendChild(c);
  }
  for (const tag of (game.tags || []).slice(0, 12)) {
    const t = document.createElement('span'); t.className = 'tag-chip'; t.textContent = tag; tagsEl.appendChild(t);
  }
  document.getElementById('modal-desc').textContent = game.short_description || '';

  // Actions
  const steamBtn = document.getElementById('modal-steam-btn');
  steamBtn.href = steamUrl(game);
  steamBtn.textContent = game.price
    ? (game.price.isFree ? 'Get on Steam · Free' : `View in Store · ${game.price.finalFormatted}`)
    : 'Open in Steam';
  document.getElementById('modal-dismiss-btn').onclick = () => {
    const card = document.querySelector(`.card[data-appid="${game.appid}"]`);
    if (card) doDismiss(card, game.appid);
    else fetch('/api/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appid: game.appid, steamId: STEAM_ID }) }).catch(() => {});
    closeModal();
  };

  // Media
  const video = document.getElementById('modal-video');
  const ytFrame = document.getElementById('modal-yt');
  const poster = document.getElementById('modal-poster');
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.removeAttribute('src'); video.load();
  ytFrame.removeAttribute('src');
  modalTrailer.classList.remove('active');

  const artUrl = headerArt(game);
  poster.src = artUrl;
  poster.alt = game.name;
  modalHero.style.backgroundImage = `url('${heroArt(game)}'), url('${artUrl}')`;

  function loadTrailer(url) {
    if (!url || url === 'none' || currentGame !== game) return;
    if (url.startsWith('yt:')) {
      // youtube-nocookie.com avoids Android's YouTube app intent interception; playsinline keeps iOS in-page
      const videoId = url.slice(3);
      video.style.display = 'none';
      ytFrame.style.display = 'block';
      ytFrame.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&rel=0&playsinline=1`;
      modalTrailer.classList.add('active');
      return;
    }
    const onFail = () => { modalTrailer.classList.remove('active'); if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; } };
    ytFrame.style.display = 'none';
    video.style.display = 'block';
    modalTrailer.classList.add('active');
    if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({ autoStartLoad: true, startLevel: -1 });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => { video.muted = true; video.play().catch(onFail); });
      hlsInstance.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) onFail(); });
    } else {
      video.muted = true;
      video.src = url;
      video.load();
      video.play().catch(onFail);
      video.addEventListener('error', onFail, { once: true });
    }
  }

  const needsTrailer = !game.trailer_mp4;
  const needsDesc = !game.short_description;
  const needsEsrb = game.esrb_rating == null; // null = never fetched; 'none' = fetched, nothing found
  if (!needsTrailer) loadTrailer(game.trailer_mp4);
  if (needsTrailer || needsDesc || needsEsrb) {
    fetch(`/api/trailer/${game.appid}`)
      .then(r => r.json())
      .then(data => {
        if (backdrop.hidden || currentGame !== game) return;
        if (data.trailer_mp4 && needsTrailer) { game.trailer_mp4 = data.trailer_mp4; loadTrailer(data.trailer_mp4); }
        if (data.short_description && needsDesc) {
          game.short_description = data.short_description;
          document.getElementById('modal-desc').textContent = data.short_description;
        }
        if (needsEsrb && data.esrb_rating != null) {
          game.esrb_rating = data.esrb_rating;
          renderEsrbBadge(ratingsEl, data.esrb_rating);
        }
      })
      .catch(() => { if (needsTrailer && needsDesc) toast("Couldn't load extra details for this game."); });
  }

  backdrop.hidden = false;
  lockScroll(true);
  document.getElementById('modal-close').focus({ preventScroll: true });
}

function closeModal() {
  backdrop.hidden = true;
  lockScroll(false);
  currentGame = null;
  const video = document.getElementById('modal-video');
  video.pause(); video.removeAttribute('src'); video.load(); video.muted = true;
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  document.getElementById('modal-yt').removeAttribute('src');
  modalTrailer.classList.remove('active');
  modalHero.style.backgroundImage = '';
}

document.getElementById('modal-close').addEventListener('click', closeModal);
backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const tasteBackdrop = document.getElementById('taste-backdrop');
  if (reasonsPopup.classList.contains('visible')) hideReasonsPopup();
  else if (tasteBackdrop && !tasteBackdrop.hidden) { tasteBackdrop.hidden = true; lockScroll(false); }
  else if (!backdrop.hidden) closeModal();
});

// ── Shelf Score reasons popup ─────────────────────────────────────────────
const reasonsPopup = document.createElement('div');
reasonsPopup.id = 'score-reasons-popup';
reasonsPopup.className = 'score-reasons-popup';
document.body.appendChild(reasonsPopup);

function showReasonsPopup(anchor, reasons, tier) {
  reasonsPopup.className = `score-reasons-popup tier--${tier}`;
  reasonsPopup.innerHTML = `
    <div class="score-reasons-header">
      <span class="score-reasons-title">Why this matched</span>
      <button class="score-reasons-close" aria-label="Close">×</button>
    </div>
    <ul class="score-reasons-list">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
  reasonsPopup.querySelector('.score-reasons-close').addEventListener('click', e => { e.stopPropagation(); hideReasonsPopup(); });

  reasonsPopup.classList.add('visible');
  const rect = anchor.getBoundingClientRect();
  const pw = Math.min(320, window.innerWidth - 16);
  let left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
  const popH = reasonsPopup.offsetHeight || 180;
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const top = spaceBelow >= popH || spaceBelow >= rect.top - 8 ? rect.bottom + 6 : rect.top - popH - 6;
  reasonsPopup.style.left = `${left}px`;
  reasonsPopup.style.top = `${top}px`;
  reasonsPopup.style.width = `${pw}px`;
}

function hideReasonsPopup() { reasonsPopup.classList.remove('visible'); }

document.addEventListener('click', e => {
  if (reasonsPopup.classList.contains('visible') && !reasonsPopup.contains(e.target)) hideReasonsPopup();
});
