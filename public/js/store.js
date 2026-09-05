/* ShelfLife — Steam Store tab: games you don't own, priced, ranked against your taste.
   Requires helpers.js, cards.js. Exposes window.ShelfStore.activate(). */

(function () {
  let loaded = false;
  let pollTimer = null;

  const $ = id => document.getElementById(id);
  const show = (id, on) => { const n = $(id); if (n) n.hidden = !on; };

  function renderStore(data) {
    show('store-loading', false);
    show('store-error', false);
    show('store-sections', true);

    const sub = $('sub-storePicks');
    if (sub) {
      const tags = (data.browsedTags || []).slice(0, 5).join(' · ');
      sub.textContent = tags ? `Browsed by your taste: ${tags}` : '';
    }
    const note = $('store-note');
    if (note) {
      const when = data.builtAt ? new Date(data.builtAt * 1000) : null;
      const age = when ? Math.round((Date.now() - when.getTime()) / 3600000) : null;
      note.textContent = `GAMES YOU DON'T OWN, RANKED AGAINST YOUR TASTE · PRICES IN ${data.currency || 'USD'}`
        + (age != null ? ` · UPDATED ${age < 1 ? 'JUST NOW' : `${age}H AGO`}` : '')
        + (data.refreshing ? ' · REFRESHING' : '');
    }

    fillGrid('grid-storePicks', data.picks || [], 'No strong matches found');
    fillGrid('grid-storeSale', data.onSale || [], 'Nothing you\'d like is on sale right now');
    const freeSection = $('section-storeFree');
    if (freeSection) freeSection.hidden = !(data.free || []).length;
    fillGrid('grid-storeFree', data.free || []);
    document.querySelectorAll('#store-sections .card-grid').forEach(g => updateArrows(g.id.replace('grid-', '')));
  }

  function renderProgress(data) {
    show('store-sections', false);
    show('store-error', false);
    show('store-loading', true);
    const msg = $('store-loading-message');
    if (msg) msg.textContent = (data.message || 'Working').replace(/[.…]+$/, '');
    const bar = $('store-loading-bar');
    if (bar) bar.style.width = data.total > 0 ? `${Math.round((data.progress / data.total) * 100)}%` : '8%';
  }

  function renderError(message) {
    show('store-sections', false);
    show('store-loading', false);
    show('store-error', true);
    const m = $('store-error-message');
    if (m) m.textContent = message || 'Store discovery failed.';
  }

  async function load() {
    try {
      const res = await fetch(`/api/discover/${STEAM_ID}`);
      if (res.status === 202) {
        renderProgress(await res.json());
        pollTimer = setTimeout(poll, 2500);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return renderError(data.error);
      loaded = true;
      renderStore(data);
    } catch {
      renderError('Network error — check your connection and try again.');
    }
  }

  async function poll() {
    try {
      const res = await fetch(`/api/discover/${STEAM_ID}/status`);
      const data = await res.json();
      if (data.status === 'done' || data.status === 'unknown') return load();
      if (data.status === 'error') return renderError(data.message);
      renderProgress(data);
    } catch { /* keep polling */ }
    pollTimer = setTimeout(poll, 2500);
  }

  function activate() {
    if (loaded) return;
    clearTimeout(pollTimer);
    load();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('store-retry-btn')?.addEventListener('click', () => { loaded = false; load(); });
  });

  window.ShelfStore = { activate };
})();
