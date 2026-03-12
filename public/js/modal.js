/* ShelfLife — detail modal */

const ESRB_IMGS = {
  'e':    '/esrb/E.svg',
  'e10':  '/esrb/E10plus.svg',
  'e10+': '/esrb/E10plus.svg',
  't':    '/esrb/T.svg',
  'm':    '/esrb/M.svg',
  'ao':   '/esrb/AO.svg',
  'rp':   '/esrb/RP.svg',
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
const modal = document.getElementById('modal');
const modalHero = document.getElementById('modal-hero');
const modalTrailer = document.getElementById('modal-trailer');
let hlsInstance = null;

function openModal(game) {
  document.getElementById('modal-title').textContent = game.name;

  // Meta row: year · developer · publisher
  const year = game.release_date ? game.release_date.match(/\d{4}/)?.[0] : null;
  const devs = (game.developers || []).join(', ');
  const pubs = (game.publishers || []).filter(p => !game.developers?.includes(p)).join(', ');
  const metaParts = [year, devs, pubs].filter(Boolean);
  document.getElementById('modal-meta').textContent = metaParts.join(' · ');

  // Playtime
  const ptEl = document.getElementById('modal-playtime');
  ptEl.innerHTML = '';
  const ptBadge = document.createElement('span');
  ptBadge.className = 'badge badge-playtime';
  ptBadge.textContent = game.playtime === 0 ? 'Never played'
    : game.playtime < 60 ? `${game.playtime} min played`
    : `${Math.floor(game.playtime / 60)}h played`;
  ptEl.appendChild(ptBadge);

  // Ratings
  const ratingsEl = document.getElementById('modal-ratings');
  ratingsEl.innerHTML = '';

  // Shelf Score badge — uses pre-normalized displayScore (relative to user's top scorer)
  const shelfScore = game.displayScore ?? Math.round(Math.min(96, game.score / 1.24));
  if (shelfScore != null && game.score != null) {
    const tier = shelfScore >= 80 ? 'top'
               : shelfScore >= 60 ? 'high'
               : shelfScore >= 40 ? 'mid'
               : shelfScore >= 20 ? 'low'
               : '';
    const ss = document.createElement('div');
    ss.className = 'shelf-score' + (tier ? ` shelf-score--${tier}` : '');
    ss.title = 'Shelf Score';
    const hasReasons = game.reasons?.length > 0;
    if (hasReasons) ss.classList.add('shelf-score--clickable');
    ss.innerHTML = `<svg class="shelf-score-icon" viewBox="0 0 32 27" xmlns="http://www.w3.org/2000/svg">
      <path class="ss-heart" d="M16,8 C12,2 4,4 4,10 C4,17 10,21 16,25 C22,21 28,17 28,10 C28,4 20,2 16,8Z"
            stroke-width="1.2"/>
      <polyline class="ss-line" points="5,14 8,14 10,12 12,20 14,6 16,14 20,14 27,14"
                stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg><span class="shelf-score-num">${shelfScore}</span>`;
    if (hasReasons) {
      ss.addEventListener('click', (e) => {
        e.stopPropagation();
        showReasonsPopup(ss, game.reasons, tier);
      });
    }
    ratingsEl.appendChild(ss);
  }

  if (game.metacritic_score) {
    const mc = document.createElement('div');
    mc.className = 'rating-badge';
    mc.innerHTML = `<span class="rating-mc">MC ${game.metacritic_score}</span>`;
    ratingsEl.appendChild(mc);
  }

  if (game.steam_positive != null && game.steam_negative != null) {
    const total = game.steam_positive + game.steam_negative;
    if (total > 0) {
      const pct = Math.round((game.steam_positive / total) * 100);
      let label = pct >= 95 ? 'Overwhelmingly Positive'
        : pct >= 85 ? 'Very Positive'
        : pct >= 70 ? 'Mostly Positive'
        : pct >= 40 ? 'Mixed'
        : pct >= 20 ? 'Mostly Negative'
        : 'Overwhelmingly Negative';
      const steam = document.createElement('div');
      steam.className = 'rating-badge';
      steam.innerHTML = `<span class="rating-steam">${label} · ${pct}% of ${total.toLocaleString()}</span>`;
      ratingsEl.appendChild(steam);
    }
  }

  if (game.esrb_rating && game.esrb_rating.toLowerCase() !== 'none') {
    renderEsrbBadge(ratingsEl, game.esrb_rating);
  }

  // Tags + categories
  const tagsEl = document.getElementById('modal-tags');
  tagsEl.innerHTML = '';
  for (const cat of (game.categories || []).slice(0, 4)) {
    const el = document.createElement('span');
    el.className = 'cat-chip';
    el.textContent = cat;
    tagsEl.appendChild(el);
  }
  for (const tag of (game.tags || []).slice(0, 12)) {
    const el = document.createElement('span');
    el.className = 'tag-chip';
    el.textContent = tag;
    tagsEl.appendChild(el);
  }

  // Description
  document.getElementById('modal-desc').textContent = game.short_description || '';

  // Reason tags
  const reasonsEl = document.getElementById('modal-reasons');
  reasonsEl.innerHTML = '';
  for (const r of (game.reasons || [])) {
    reasonsEl.appendChild(makeScrollTag(r, 'reason-chip'));
  }

  // Steam link
  document.getElementById('modal-steam-btn').href = `https://store.steampowered.com/app/${game.appid}`;

  // Media setup
  const video = document.getElementById('modal-video');
  const ytFrame = document.getElementById('modal-yt');
  const poster = document.getElementById('modal-poster');

  // Tear down any previous HLS instance or YouTube iframe
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.removeAttribute('src');
  video.load();
  ytFrame.removeAttribute('src');
  modalTrailer.classList.remove('active');

  // Poster + hero background — both use the same header art
  const artUrl = game.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
  poster.src = artUrl;
  modalHero.style.backgroundImage = `url('${artUrl}')`;

  function loadTrailer(url) {
    if (!url || url === 'none') return;

    // YouTube fallback — youtube-nocookie.com avoids Android's YouTube app intent
    // interception. playsinline=1 keeps playback in-page on iOS.
    if (url.startsWith('yt:')) {
      const videoId = url.slice(3);
      video.style.display = 'none';
      ytFrame.style.display = 'block';
      ytFrame.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&rel=0&playsinline=1`;
      modalTrailer.classList.add('active');
      return;
    }

    function onFail() {
      modalTrailer.classList.remove('active');
      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    }

    // Show only video element in trailer container
    ytFrame.style.display = 'none';
    video.style.display = 'block';
    modalTrailer.classList.add('active');

    if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({ autoStartLoad: true, startLevel: -1 });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        video.muted = true;
        video.play().catch(onFail);
      });
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) onFail();
      });
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
  // null/undefined = never fetched; 'none' = fetched, no rating found — don't re-fetch
  const needsEsrb = game.esrb_rating == null;

  // Show ESRB immediately if already known
  if (!needsEsrb) {
    renderEsrbBadge(document.getElementById('modal-ratings'), game.esrb_rating);
  }

  if (!needsTrailer && !needsDesc && !needsEsrb) {
    loadTrailer(game.trailer_mp4);
  } else {
    if (!needsTrailer) loadTrailer(game.trailer_mp4);
    fetch(`/api/trailer/${game.appid}`)
      .then(r => r.json())
      .then(data => {
        if (!backdrop.hidden) {
          if (data.trailer_mp4 && needsTrailer) { game.trailer_mp4 = data.trailer_mp4; loadTrailer(data.trailer_mp4); }
          if (data.short_description && needsDesc) {
            game.short_description = data.short_description;
            document.getElementById('modal-desc').textContent = data.short_description;
          }
          if (needsEsrb && data.esrb_rating != null) {
            game.esrb_rating = data.esrb_rating;
            renderEsrbBadge(document.getElementById('modal-ratings'), data.esrb_rating);
          }
        }
      })
      .catch(() => {});
  }

  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  backdrop.hidden = true;
  document.body.style.overflow = '';
  const video = document.getElementById('modal-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.muted = true;
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  const ytFrame = document.getElementById('modal-yt');
  ytFrame.removeAttribute('src');
  modalTrailer.classList.remove('active');
  modalHero.style.backgroundImage = '';
}

document.getElementById('modal-close').addEventListener('click', closeModal);
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const tasteBackdrop = document.getElementById('taste-backdrop');
    if (reasonsPopup && reasonsPopup.classList.contains('visible')) {
      hideReasonsPopup();
    } else if (tasteBackdrop && !tasteBackdrop.hidden) {
      tasteBackdrop.hidden = true;
      document.body.style.overflow = '';
    } else if (!backdrop.hidden) {
      closeModal();
    }
  }
});

// ── Shelf Score reasons popup ─────────────────────────────────────────────
const reasonsPopup = document.createElement('div');
reasonsPopup.id = 'score-reasons-popup';
reasonsPopup.className = 'score-reasons-popup';
document.body.appendChild(reasonsPopup);

function showReasonsPopup(anchor, reasons, tier) {
  reasonsPopup.className = 'score-reasons-popup' + (tier ? ` score-reasons-popup--${tier}` : '');
  reasonsPopup.innerHTML = `
    <div class="score-reasons-header">
      <span class="score-reasons-title">Why this matched</span>
      <button class="score-reasons-close" aria-label="Close">×</button>
    </div>
    <ul class="score-reasons-list">
      ${reasons.map(r => `<li>${r}</li>`).join('')}
    </ul>`;
  reasonsPopup.querySelector('.score-reasons-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideReasonsPopup();
  });

  // Position: below anchor, clamped to viewport
  reasonsPopup.classList.add('visible');
  const rect = anchor.getBoundingClientRect();
  const pw = Math.min(300, window.innerWidth - 16);
  let left = rect.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  left = Math.max(8, left);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const popH = reasonsPopup.offsetHeight || 180;
  const top = spaceBelow >= popH || spaceBelow >= spaceAbove
    ? rect.bottom + 6
    : rect.top - popH - 6;
  reasonsPopup.style.left = left + 'px';
  reasonsPopup.style.top = top + 'px';
  reasonsPopup.style.width = pw + 'px';
}

function hideReasonsPopup() {
  reasonsPopup.classList.remove('visible');
}

document.addEventListener('click', (e) => {
  if (reasonsPopup.classList.contains('visible') && !reasonsPopup.contains(e.target)) {
    hideReasonsPopup();
  }
});
