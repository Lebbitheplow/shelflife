/* ShelfLife — profile page carousels, loading poll, shuffle.
   Shared helpers (esc, toast, formatTtb, makeScrollTag) live in helpers.js. */

const SECTION_KEYS = ['top20', 'topPicks', 'friendsPlayed', 'neverTouched', 'almostStarted', 'byGenre'];

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

  if (game.ttb_normally) {
    const ttbBadge = document.createElement('span');
    ttbBadge.className = 'badge badge-ttb';
    ttbBadge.textContent = `⏱ ${formatTtb(game.ttb_normally)}`;
    ttbBadge.title = 'Estimated time to beat the main story';
    badges.appendChild(ttbBadge);
  }

  if (game.friends?.count) {
    const fBadge = document.createElement('span');
    fBadge.className = 'badge badge-friends';
    fBadge.textContent = `${game.friends.count} friend${game.friends.count === 1 ? '' : 's'}`;
    fBadge.title = 'Friends who have played this';
    badges.appendChild(fBadge);
  }

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

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'overlay-dismiss-btn';
  dismissBtn.textContent = '✕ Hide';
  dismissBtn.title = "Don't show this again";
  dismissBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    doDismiss(card, game.appid);
  });
  overlay.appendChild(dismissBtn);

  card.appendChild(img);
  card.appendChild(body);
  card.appendChild(overlay);
  card.addEventListener('click', () => openModal(game));

  return card;
}

function doDismiss(cardEl, appid) {
  cardEl.style.opacity = '0';
  cardEl.style.transition = 'opacity 0.25s';
  fetch('/api/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appid, steamId: STEAM_ID }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        setTimeout(() => cardEl.remove(), 250);
      } else {
        cardEl.style.opacity = '';
        cardEl.style.transition = '';
        toast("Couldn't hide that game — please try again.");
      }
    })
    .catch(() => {
      cardEl.style.opacity = '';
      cardEl.style.transition = '';
      toast("Couldn't hide that game — check your connection.");
    });
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

  // Stats bar — backlog chips
  const statsEl = document.getElementById('profile-stats');
  if (statsEl && state.data.stats) {
    const s = state.data.stats;
    const pct = s.total ? Math.round((s.neverPlayed / s.total) * 100) : 0;
    const chips = [
      `${s.total} games`,
      `${s.neverPlayed} never played (${pct}%)`,
      `${s.almostStarted} barely started`,
    ];
    if (s.hoursPlayed != null) chips.push(`${s.hoursPlayed.toLocaleString()}h played`);
    if (s.backlogHours) chips.push(`~${s.backlogHours.toLocaleString()}h to clear your backlog`);
    statsEl.innerHTML = '';
    for (const text of chips) {
      const chip = document.createElement('span');
      chip.className = 'stat-chip';
      chip.textContent = text;
      statsEl.appendChild(chip);
    }
  }

  // Friends section only appears when friend data exists (public friends list)
  const friendsSection = document.getElementById('section-friendsPlayed');
  if (friendsSection) friendsSection.hidden = !state.data.friendsPlayed?.length;

  // Genre dropdown
  const genreSelect = document.getElementById('genre-select');
  if (genreSelect && state.data.genres?.length) {
    genreSelect.innerHTML = state.data.genres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    state.currentGenre = state.data.genres[0];
    genreSelect.addEventListener('change', () => {
      state.currentGenre = genreSelect.value;
      renderSection('byGenre', getGamesForSection('byGenre'));
    });
  }

  SECTION_KEYS.forEach(key => {
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
  SECTION_KEYS.forEach(key => {
    const grid = document.getElementById(`grid-${key}`);
    if (grid) grid.addEventListener('scroll', () => updateArrows(key), { passive: true });
  });

  // Global shuffle button — reshuffles all sections at once
  document.getElementById('shuffle-all-btn')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/shuffle/${STEAM_ID}`);
      if (!res.ok) {
        toast("Shuffle failed — please try again.");
        return;
      }
      state.data = await res.json();
      for (const key of ['topPicks', 'friendsPlayed', 'neverTouched', 'almostStarted', 'byGenre']) {
        renderSection(key, getGamesForSection(key));
      }
    } catch {
      toast("Shuffle failed — check your connection.");
    }
  });

  loadRecs();

  // Refresh data button
  document.getElementById('nav-refresh-btn')?.addEventListener('click', async function () {
    this.disabled = true;
    this.textContent = 'Fetching…';
    const reset = () => { this.disabled = false; this.textContent = '↺ Re-fetch'; };
    try {
      const res = await fetch(`/api/refresh/${STEAM_ID}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Couldn't refresh — please try again later.");
        reset();
        return;
      }
    } catch {
      toast("Couldn't refresh — check your connection.");
      reset();
      return;
    }
    window.location.reload();
  });

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
      tasteList.innerHTML = tasteCache.map(i => `<li>${esc(i)}</li>`).join('');
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
