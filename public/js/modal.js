/* ShelfLife — detail modal */

const backdrop = document.getElementById('modal-backdrop');
const modal = document.getElementById('modal');
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
    const el = document.createElement('span');
    el.className = 'reason-chip';
    el.textContent = r;
    reasonsEl.appendChild(el);
  }

  // Steam link
  document.getElementById('modal-steam-btn').href = `https://store.steampowered.com/app/${game.appid}`;

  // Media — poster always on top, video/iframe appears below when available
  const video = document.getElementById('modal-video');
  const ytFrame = document.getElementById('modal-yt');
  const poster = document.getElementById('modal-poster');

  // Tear down any previous HLS instance or YouTube iframe
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.removeAttribute('src');
  video.load();
  video.classList.remove('visible');
  ytFrame.removeAttribute('src');
  ytFrame.classList.remove('visible');

  // Poster always visible
  poster.src = game.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`;

  function loadTrailer(url) {
    if (!url || url === 'none') return;

    // YouTube fallback — render in iframe, API key stays server-side
    if (url.startsWith('yt:')) {
      const videoId = url.slice(3);
      ytFrame.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&rel=0&playsinline=1`;
      ytFrame.classList.add('visible');
      return;
    }

    function onFail() {
      video.classList.remove('visible');
      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    }

    if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({ autoStartLoad: true, startLevel: -1 });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        video.muted = true;
        video.classList.add('visible');
        video.play().catch(onFail);
      });
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) onFail();
      });
    } else {
      video.muted = true;
      video.src = url;
      video.classList.add('visible');
      video.load();
      video.play().catch(onFail);
      video.addEventListener('error', onFail, { once: true });
    }
  }

  const needsTrailer = !game.trailer_mp4;
  const needsDesc = !game.short_description;

  if (!needsTrailer && !needsDesc) {
    loadTrailer(game.trailer_mp4);
  } else {
    fetch(`/api/trailer/${game.appid}`)
      .then(r => r.json())
      .then(data => {
        if (!backdrop.hidden) {
          if (data.trailer_mp4) { game.trailer_mp4 = data.trailer_mp4; loadTrailer(data.trailer_mp4); }
          if (data.short_description) {
            game.short_description = data.short_description;
            document.getElementById('modal-desc').textContent = data.short_description;
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
  video.classList.remove('visible');
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  const ytFrame = document.getElementById('modal-yt');
  ytFrame.removeAttribute('src');
  ytFrame.classList.remove('visible');
}

document.getElementById('modal-close').addEventListener('click', closeModal);
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !backdrop.hidden) closeModal(); });
