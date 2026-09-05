/* ShelfLife — card + hero renderers shared by the shelf and store tabs.
   Requires helpers.js; calls openModal() from modal.js. */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function scoreBadge(game, cls = 'score-badge') {
  const score = scoreOf(game);
  if (score == null) return null;
  const badge = el('div', `${cls} tier--${scoreTier(score)}`);
  badge.innerHTML = `${SCORE_SVG}<span>${score}</span>`;
  badge.title = `Shelf Score ${score} · ${TIER_LABELS[scoreTier(score)]}`;
  return badge;
}

// "<s>$29.99</s> $17.99" / "$24.99" / "FREE"
function priceNode(price, cls = 'card-price') {
  const wrap = el('span', cls);
  if (!price) { wrap.appendChild(el('b', null, '—')); return wrap; }
  if (price.isFree) { wrap.classList.add(`${cls}--free`); wrap.appendChild(el('b', null, 'Free')); return wrap; }
  if (price.discount > 0) {
    wrap.classList.add(`${cls}--sale`);
    wrap.appendChild(el('s', null, price.initialFormatted));
  }
  wrap.appendChild(el('b', null, price.finalFormatted));
  return wrap;
}

function renderCard(game) {
  const card = el('div', 'card' + (game.price ? ' card--store' : ''));
  card.dataset.appid = game.appid;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', game.name);

  const art = el('div', 'card-art');
  const img = el('img', 'card-img');
  img.src = headerArt(game);
  img.alt = '';
  img.loading = 'lazy';
  art.appendChild(img);

  const badge = scoreBadge(game, 'score-badge card-score');
  if (badge) art.appendChild(badge);

  if (game.price?.discount > 0) {
    art.appendChild(el('div', 'card-flag chip--sale', `-${game.price.discount}%`));
  } else if (game.friends?.count) {
    art.appendChild(el('div', 'card-flag chip chip--green', `${game.friends.count} friend${game.friends.count === 1 ? '' : 's'}`));
  }

  art.appendChild(el('div', 'card-name', game.name));
  card.appendChild(art);

  const foot = el('div', 'card-foot');
  if (game.price) {
    foot.appendChild(priceNode(game.price));
  } else if (game.ttb_normally) {
    const s = el('span', 'card-stat', `${formatTtb(game.ttb_normally)} main`);
    s.title = 'Estimated time to beat the main story';
    foot.appendChild(s);
  } else {
    foot.appendChild(el('span', 'card-stat', playtimeLabel(game.playtime)));
  }
  if (game.reasons?.[0]) {
    const r = el('span', 'card-reason', game.reasons[0]);
    r.title = game.reasons[0];
    foot.appendChild(r);
  }
  card.appendChild(foot);

  // Hover actions
  const overlay = el('div', 'card-overlay');
  const infoBtn = el('button', 'overlay-btn', 'More Info');
  infoBtn.type = 'button';
  infoBtn.addEventListener('click', e => { e.stopPropagation(); openModal(game); });
  const steamBtn = el('a', 'overlay-link', game.price ? 'View in Store' : 'Open in Steam');
  steamBtn.href = steamUrl(game);
  steamBtn.target = '_blank';
  steamBtn.rel = 'noopener';
  steamBtn.addEventListener('click', e => e.stopPropagation());
  const dismissBtn = el('button', 'overlay-dismiss-btn', '✕ Hide');
  dismissBtn.type = 'button';
  dismissBtn.title = "Don't show this again";
  dismissBtn.addEventListener('click', e => { e.stopPropagation(); doDismiss(card, game.appid); });
  overlay.append(infoBtn, steamBtn, dismissBtn);
  card.appendChild(overlay);

  card.addEventListener('click', () => openModal(game));
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(game); } });
  return card;
}

function doDismiss(cardEl, appid) {
  cardEl.style.opacity = '0';
  cardEl.style.transition = 'opacity 0.25s';
  const undo = () => { cardEl.style.opacity = ''; cardEl.style.transition = ''; };
  fetch('/api/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appid, steamId: STEAM_ID }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.success) setTimeout(() => cardEl.remove(), 250);
      else { undo(); toast("Couldn't hide that game — please try again."); }
    })
    .catch(() => { undo(); toast("Couldn't hide that game — check your connection."); });
}

// Fill a card-grid, replacing the skeleton; shows a placeholder when empty
function fillGrid(gridId, games, emptyText) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = '';
  grid.classList.remove('skeleton-grid');
  grid.scrollLeft = 0;
  if (!games.length) {
    grid.appendChild(el('div', 'grid-empty', emptyText || 'Nothing here yet'));
    return;
  }
  for (const game of games) grid.appendChild(renderCard(game));
}

// Spotlight hero: featured game + up-next queue
function renderHero(featured, queue) {
  const hero = document.getElementById('hero');
  if (!hero || !featured) return;
  hero.classList.remove('hero--skeleton');
  hero.innerHTML = '';

  const bg = el('img', 'hero-bg');
  bg.alt = '';
  bg.src = heroArt(featured);
  bg.addEventListener('error', () => { bg.src = headerArt(featured); bg.classList.add('hero-bg--fallback'); }, { once: true });
  hero.append(bg, el('div', 'hero-shade'));

  const content = el('div', 'hero-content');
  const score = scoreOf(featured);
  content.appendChild(el('div', 'kicker hero-kicker', `★ Top of your shelf${score != null ? ` · Score ${score}` : ''}`));
  content.appendChild(el('h1', 'hero-title', featured.name));

  const chips = el('div', 'hero-chips');
  chips.appendChild(el('span', 'chip chip--glass', playtimeLabel(featured.playtime)));
  if (featured.ttb_normally) chips.appendChild(el('span', 'chip chip--gold', `${formatTtb(featured.ttb_normally)} main`));
  const rev = reviewSummary(featured);
  if (rev && rev.total >= 50) chips.appendChild(el('span', 'chip chip--steam', `${rev.pct}% reviews`));
  if (featured.friends?.count) chips.appendChild(el('span', 'chip chip--green', `${featured.friends.count} friends played`));
  content.appendChild(chips);

  const actions = el('div', 'hero-actions');
  const info = el('button', 'btn btn-primary', 'More Info');
  info.type = 'button';
  info.addEventListener('click', () => openModal(featured));
  const steam = el('a', 'btn btn-steam', 'Open in Steam');
  steam.href = steamUrl(featured); steam.target = '_blank'; steam.rel = 'noopener';
  actions.append(info, steam);
  content.appendChild(actions);
  hero.appendChild(content);

  if (queue?.length) {
    const aside = el('aside', 'hero-queue');
    aside.appendChild(el('div', 'hero-queue-title', '▶ UP NEXT'));
    const list = el('div', 'hero-queue-list');
    for (const g of queue) {
      const row = el('div', 'queue-row');
      row.tabIndex = 0;
      const thumb = el('img'); thumb.src = headerArt(g); thumb.alt = ''; thumb.loading = 'lazy';
      const body = el('div', 'queue-row-body');
      body.appendChild(el('div', 'queue-row-name', g.name));
      const sub = [g.ttb_normally ? `${formatTtb(g.ttb_normally)}` : null, playtimeLabel(g.playtime)].filter(Boolean).join(' · ');
      body.appendChild(el('div', 'queue-row-sub', sub));
      const s = scoreOf(g);
      const sc = el('span', `queue-row-score tier--${scoreTier(s)}`, s != null ? String(s) : '');
      row.append(thumb, body, sc);
      row.addEventListener('click', () => openModal(g));
      row.addEventListener('keydown', e => { if (e.key === 'Enter') openModal(g); });
      list.appendChild(row);
    }
    aside.appendChild(list);
    hero.appendChild(aside);
  }
}
