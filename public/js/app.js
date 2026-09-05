/* ShelfLife — library page: hero, stats, sections, shuffle, tabs, loading poll, taste modal.
   Requires helpers.js, cards.js, modal.js. store.js hooks in via window.ShelfStore. */

const SECTION_KEYS = ['topPicks', 'friendsPlayed', 'neverTouched', 'almostStarted', 'byGenre'];
const state = { data: null, currentGenre: null };

function getGamesForSection(key) {
  if (!state.data) return [];
  if (key === 'byGenre') {
    const g = state.currentGenre;
    return (g && state.data.byGenre[g]) ? state.data.byGenre[g] : [];
  }
  return state.data[key] || [];
}

function updateArrows(key) {
  const grid = document.getElementById(`grid-${key}`);
  const section = document.getElementById(`section-${key}`);
  if (!grid || !section) return;
  const prev = section.querySelector('.carousel-arrow.prev');
  const next = section.querySelector('.carousel-arrow.next');
  if (prev) prev.disabled = grid.scrollLeft <= 4;
  if (next) next.disabled = grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 4;
}

function renderSection(key, games, emptyText) {
  fillGrid(`grid-${key}`, games, emptyText);
  updateArrows(key);
}

function renderStatChips(s) {
  const statsEl = document.getElementById('profile-stats');
  if (!statsEl || !s) return;
  const pct = s.total ? Math.round((s.neverPlayed / s.total) * 100) : 0;
  const chips = [
    `${s.total.toLocaleString()} games`,
    `${s.neverPlayed.toLocaleString()} never played · ${pct}%`,
    `${s.almostStarted.toLocaleString()} barely started`,
  ];
  if (s.hoursPlayed != null) chips.push(`${s.hoursPlayed.toLocaleString()}h played`);
  if (s.backlogHours) chips.push(`~${s.backlogHours.toLocaleString()}h to clear`);
  statsEl.innerHTML = chips.map(t => `<span class="chip">${esc(t)}</span>`).join('');
}

function hydrateAll() {
  if (!state.data) return;
  renderStatChips(state.data.stats);

  const top = state.data.top20 || [];
  renderHero(top[0], top.slice(1, 4));

  const friendsSection = document.getElementById('section-friendsPlayed');
  if (friendsSection) friendsSection.hidden = !state.data.friendsPlayed?.length;

  const genreSelect = document.getElementById('genre-select');
  if (genreSelect && state.data.genres?.length && !genreSelect.options.length) {
    genreSelect.innerHTML = state.data.genres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    state.currentGenre = state.data.genres[0];
    genreSelect.addEventListener('change', () => {
      state.currentGenre = genreSelect.value;
      renderSection('byGenre', getGamesForSection('byGenre'));
    });
  }

  for (const key of SECTION_KEYS) renderSection(key, getGamesForSection(key));
}

async function loadRecs() {
  try {
    const res = await fetch(`/api/recommendations/${STEAM_ID}`);
    if (res.status === 202) return; // still loading, poll handles it
    if (!res.ok) throw new Error(await res.text());
    state.data = await res.json();
    hydrateAll();
  } catch (err) {
    console.error('Failed to load recs:', err);
    toast("Couldn't load recommendations — try refreshing the page.");
  }
}

// ── Loading poll ──────────────────────────────────────────
let pollInterval = null;

async function pollStatus() {
  try {
    const res = await fetch(`/api/status/${STEAM_ID}`);
    const data = await res.json();
    const msgEl = document.getElementById('loading-message');
    const barEl = document.getElementById('loading-bar');
    if (msgEl) msgEl.textContent = (data.message || 'Loading').replace(/\.{3}$/, '');
    if (barEl && data.total > 0) barEl.style.width = `${Math.round((data.progress / data.total) * 100)}%`;

    if (data.status === 'done') {
      clearInterval(pollInterval);
      window.location.reload();
    } else if (data.status === 'error') {
      clearInterval(pollInterval);
      document.getElementById('loading-state').innerHTML =
        `<p style="color:var(--red);margin-bottom:16px">${esc(data.message || 'Something went wrong.')}</p><a href="/" class="btn btn-primary">Try Again</a>`;
    }
  } catch { /* network blip, keep polling */ }
}

// ── Tabs ──────────────────────────────────────────────────
function selectTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.getElementById('panel-shelf').hidden = name !== 'shelf';
  document.getElementById('panel-store').hidden = name !== 'store';
  if (name === 'store') window.ShelfStore?.activate();
  if (history.replaceState) history.replaceState(null, '', name === 'store' ? '#store' : location.pathname);
}

// ── Event wiring ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (IS_LOADING) {
    pollInterval = setInterval(pollStatus, 2000);
    pollStatus();
    return;
  }

  document.querySelectorAll('.carousel-arrow').forEach(btn => {
    btn.addEventListener('click', () => {
      const grid = document.getElementById(`grid-${btn.dataset.section}`);
      if (!grid) return;
      const dir = btn.classList.contains('prev') ? -1 : 1;
      grid.scrollBy({ left: dir * grid.clientWidth * 0.9, behavior: 'smooth' });
    });
  });
  document.querySelectorAll('.card-grid').forEach(grid => {
    const key = grid.id.replace('grid-', '');
    grid.addEventListener('scroll', () => updateArrows(key), { passive: true });
  });
  window.addEventListener('resize', () => document.querySelectorAll('.card-grid').forEach(g => updateArrows(g.id.replace('grid-', ''))));

  document.getElementById('shuffle-all-btn')?.addEventListener('click', async function () {
    this.disabled = true;
    try {
      const res = await fetch(`/api/shuffle/${STEAM_ID}`);
      if (!res.ok) throw new Error();
      state.data = await res.json();
      for (const key of SECTION_KEYS) renderSection(key, getGamesForSection(key));
    } catch {
      toast('Shuffle failed — please try again.');
    } finally {
      this.disabled = false;
    }
  });

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  if (location.hash === '#store') selectTab('store');

  loadRecs();

  document.getElementById('nav-refresh-btn')?.addEventListener('click', async function () {
    this.disabled = true;
    this.textContent = 'Fetching…';
    const reset = () => { this.disabled = false; this.textContent = '↺ Re-fetch'; };
    try {
      const res = await fetch(`/api/refresh/${STEAM_ID}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Couldn't refresh — please try again later.");
        return reset();
      }
    } catch {
      toast("Couldn't refresh — check your connection.");
      return reset();
    }
    window.location.reload();
  });

  // ── Taste Profile / Score Guide modal ────────────────────────────────
  const tasteBackdrop = document.getElementById('taste-backdrop');
  const tasteList = document.getElementById('taste-interests-list');
  let tasteCache = null;

  async function openTasteModal() {
    tasteBackdrop.hidden = false;
    lockScroll(true);
    if (!tasteCache) {
      try {
        const res = await fetch(`/api/interests/${STEAM_ID}`);
        tasteCache = res.ok ? (await res.json()).interests || [] : [];
      } catch { tasteCache = []; }
    }
    tasteList.innerHTML = tasteCache.length
      ? tasteCache.map(i => `<li>${esc(i)}</li>`).join('')
      : '<li class="taste-empty">Play more games to build a taste profile.</li>';
  }
  const closeTasteModal = () => { tasteBackdrop.hidden = true; lockScroll(false); };
  document.getElementById('nav-taste-btn')?.addEventListener('click', openTasteModal);
  document.getElementById('taste-modal-close')?.addEventListener('click', closeTasteModal);
  tasteBackdrop?.addEventListener('click', e => { if (e.target === tasteBackdrop) closeTasteModal(); });
});
