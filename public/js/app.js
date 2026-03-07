/* ShelfLife — profile page carousels, loading poll, shuffle */

const COLS_PER_ROW = () => {
  const gridW = document.querySelector('.card-grid')?.offsetWidth || window.innerWidth - 48;
  return Math.max(1, Math.floor(gridW / (180 + 12)));
};
const ROWS = 2;
const PAGE_SIZE = () => COLS_PER_ROW() * ROWS;

const state = {
  data: null,
  pages: {
    top20: 0,
    topPicks: 0,
    neverTouched: 0,
    almostStarted: 0,
    byGenre: 0,
  },
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
    const r = document.createElement('span');
    r.className = 'badge badge-reason';
    r.textContent = game.reasons[0];
    badges.appendChild(r);
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

function renderSection(sectionKey, games, pageNum) {
  const grid = document.getElementById(`grid-${sectionKey}`);
  if (!grid) return;

  const ps = PAGE_SIZE();
  const totalPages = Math.max(1, Math.ceil(games.length / ps));
  const p = Math.min(pageNum, totalPages - 1);
  state.pages[sectionKey] = p;

  const slice = games.slice(p * ps, (p + 1) * ps);

  grid.innerHTML = '';
  grid.classList.remove('skeleton-grid');
  for (const game of slice) grid.appendChild(renderCard(game));

  // Update page indicator and arrow states
  const indicator = document.getElementById(`page-${sectionKey}`);
  if (indicator) indicator.textContent = `${p + 1} / ${totalPages}`;

  document.querySelectorAll(`.carousel-btn[data-section="${sectionKey}"]`).forEach(btn => {
    if (btn.classList.contains('prev')) btn.disabled = p === 0;
    if (btn.classList.contains('next')) btn.disabled = p >= totalPages - 1;
  });
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
      state.pages.byGenre = 0;
      renderSection('byGenre', getGamesForSection('byGenre'), 0);
    });
  }

  ['top20', 'topPicks', 'neverTouched', 'almostStarted', 'byGenre'].forEach(key => {
    renderSection(key, getGamesForSection(key), 0);
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

  // Carousel buttons
  document.querySelectorAll('.carousel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.section;
      const games = getGamesForSection(key);
      const ps = PAGE_SIZE();
      const totalPages = Math.max(1, Math.ceil(games.length / ps));
      let p = state.pages[key] || 0;
      if (btn.classList.contains('prev')) p = Math.max(0, p - 1);
      if (btn.classList.contains('next')) p = Math.min(totalPages - 1, p + 1);
      renderSection(key, games, p);
    });
  });

  // Shuffle buttons
  document.querySelectorAll('.shuffle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.section;
      try {
        const res = await fetch(`/api/shuffle/${STEAM_ID}`);
        if (!res.ok) return;
        state.data = await res.json();
        renderSection(key, getGamesForSection(key), 0);
      } catch {}
    });
  });

  loadRecs();
});
