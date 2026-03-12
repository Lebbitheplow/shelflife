/* ShelfLife — profile page carousels, loading poll, shuffle */

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

const state = {
  data: null,
  currentGenre: null,
};

// ── Render helpers ──────────────────────────────────────────

function playtimeLabel(minutes) {
  if (!minutes) return 'Never played';
  if (minutes < 60) return `${minutes} min played`;
  const h = Math.floor(minutes / 60);
  return `${h}h played`;
}

function renderCard(game) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.appid = game.appid;

  const img = document.createElement('img');
  img.className = 'card-img';
  img.src = game.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
  img.alt = game.name;
  img.loading = 'lazy';

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = game.name;

  const badges = document.createElement('div');
  badges.className = 'card-badges';

  const ptBadge = document.createElement('span');
  ptBadge.className = 'badge badge-playtime';
  ptBadge.textContent = playtimeLabel(game.playtime);
  badges.appendChild(ptBadge);

  if (game.reasons?.[0]) {
    badges.appendChild(makeScrollTag(game.reasons[0], 'badge badge-reason'));
  }

  body.appendChild(title);
  body.appendChild(badges);

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';

  const infoBtn = document.createElement('button');
  infoBtn.className = 'overlay-btn';
  infoBtn.textContent = 'More Info';
  infoBtn.addEventListener('click', (e) => { e.stopPropagation(); openModal(game); });

  const steamBtn = document.createElement('a');
  steamBtn.className = 'overlay-steam-btn';
  steamBtn.href = `https://store.steampowered.com/app/${game.appid}`;
  steamBtn.target = '_blank';
  steamBtn.rel = 'noopener';
  steamBtn.textContent = 'Open in Steam';
  steamBtn.addEventListener('click', e => e.stopPropagation());

  overlay.appendChild(infoBtn);
  overlay.appendChild(steamBtn);

  card.appendChild(img);
  card.appendChild(body);
  card.appendChild(overlay);
  card.addEventListener('click', () => openModal(game));

  return card;
}

function updateArrows(sectionKey) {
  const grid = document.getElementById(`grid-${sectionKey}`);
  if (!grid) return;
  const wrap = grid.closest('.carousel-wrap');
  if (!wrap) return;
  const prevBtn = wrap.querySelector('.carousel-arrow.prev');
  const nextBtn = wrap.querySelector('.carousel-arrow.next');
  const atStart = grid.scrollLeft <= 4;
  const atEnd = grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 4;
  if (prevBtn) prevBtn.disabled = atStart;
  if (nextBtn) nextBtn.disabled = atEnd;
}

function renderSection(sectionKey, games) {
  const grid = document.getElementById(`grid-${sectionKey}`);
  if (!grid) return;

  grid.innerHTML = '';
  grid.classList.remove('skeleton-grid');
  grid.scrollLeft = 0;
  for (const game of games) grid.appendChild(renderCard(game));

  updateArrows(sectionKey);
}

function getGamesForSection(sectionKey) {
  if (!state.data) return [];
  if (sectionKey === 'byGenre') {
    const g = state.currentGenre;
    return (g && state.data.byGenre[g]) ? state.data.byGenre[g] : [];
  }
  return state.data[sectionKey] || [];
}

// ── Load recs ──────────────────────────────────────────

async function loadRecs() {
  try {
    const res = await fetch(`/api/recommendations/${STEAM_ID}`);
    if (res.status === 202) return; // still loading, poll handles it
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.data = data;
    hydrateAll();
  } catch (err) {
    console.error('Failed to load recs:', err);
  }
}

function hydrateAll() {
  if (!state.data) return;

  // Stats bar
  const statsEl = document.getElementById('profile-stats');
  if (statsEl && state.data.stats) {
    const s = state.data.stats;
    statsEl.textContent = `${s.total} games owned · ${s.neverPlayed} never played · ${s.almostStarted} barely started`;
  }

  // Genre dropdown
  const genreSelect = document.getElementById('genre-select');
  if (genreSelect && state.data.genres?.length) {
    genreSelect.innerHTML = state.data.genres.map(g => `<option value="${g}">${g}</option>`).join('');
    state.currentGenre = state.data.genres[0];
    genreSelect.addEventListener('change', () => {
      state.currentGenre = genreSelect.value;
      renderSection('byGenre', getGamesForSection('byGenre'));
    });
  }

  ['top20', 'topPicks', 'neverTouched', 'almostStarted', 'byGenre'].forEach(key => {
    renderSection(key, getGamesForSection(key));
  });
}

// ── Loading poll ──────────────────────────────────────────

let pollInterval = null;

async function pollStatus() {
  try {
    const res = await fetch(`/api/status/${STEAM_ID}`);
    const data = await res.json();

    const msgEl = document.getElementById('loading-message');
    const barEl = document.getElementById('loading-bar');

    if (msgEl) msgEl.textContent = data.message || 'Loading...';
    if (barEl && data.total > 0) {
      barEl.style.width = Math.round((data.progress / data.total) * 100) + '%';
    }

    if (data.status === 'done') {
      clearInterval(pollInterval);
      window.location.reload();
    } else if (data.status === 'error') {
      clearInterval(pollInterval);
      document.getElementById('loading-state').innerHTML =
        `<p style="color:#f87171">${data.message}</p><a href="/" class="btn-primary" style="margin-top:16px">Try Again</a>`;
    }
  } catch (err) {
    // network blip, keep polling
  }
}

// ── Event wiring ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (IS_LOADING) {
    pollInterval = setInterval(pollStatus, 2000);
    pollStatus();
    return;
  }

  // Carousel arrow buttons — scroll by one page width
  document.querySelectorAll('.carousel-arrow').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.section;
      const grid = document.getElementById(`grid-${key}`);
      if (!grid) return;
      const dir = btn.classList.contains('prev') ? -1 : 1;
      grid.scrollBy({ left: dir * grid.clientWidth, behavior: 'smooth' });
    });
  });

  // Update arrow states on scroll
  ['top20', 'topPicks', 'neverTouched', 'almostStarted', 'byGenre'].forEach(key => {
    const grid = document.getElementById(`grid-${key}`);
    if (grid) grid.addEventListener('scroll', () => updateArrows(key), { passive: true });
  });

  // Global shuffle button — reshuffles all sections at once
  document.getElementById('shuffle-all-btn')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/shuffle/${STEAM_ID}`);
      if (!res.ok) return;
      state.data = await res.json();
      for (const key of ['topPicks', 'neverTouched', 'almostStarted', 'byGenre']) {
        renderSection(key, getGamesForSection(key));
      }
    } catch {}
  });

  loadRecs();

  // ── Taste Profile / Score Guide modal ────────────────────────────────
  const tasteBtn = document.getElementById('nav-taste-btn');
  const tasteBackdrop = document.getElementById('taste-backdrop');
  const tasteList = document.getElementById('taste-interests-list');
  let tasteCache = null;

  async function openTasteModal() {
    tasteBackdrop.hidden = false;
    document.body.style.overflow = 'hidden';

    if (!tasteCache) {
      try {
        const res = await fetch(`/api/interests/${STEAM_ID}`);
        const data = res.ok ? await res.json() : { interests: [] };
        tasteCache = data.interests || [];
      } catch { tasteCache = []; }
    }

    if (tasteCache.length) {
      tasteList.innerHTML = tasteCache.map(i => `<li>${i}</li>`).join('');
    } else {
      tasteList.innerHTML = '<li class="taste-empty">Play more games to build a taste profile.</li>';
    }
  }

  function closeTasteModal() {
    tasteBackdrop.hidden = true;
    document.body.style.overflow = '';
  }

  if (tasteBtn) tasteBtn.addEventListener('click', openTasteModal);
  document.getElementById('taste-modal-close')?.addEventListener('click', closeTasteModal);
  tasteBackdrop?.addEventListener('click', (e) => { if (e.target === tasteBackdrop) closeTasteModal(); });
});
