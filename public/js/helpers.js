/* ShelfLife — shared helpers, loaded before app.js / modal.js / landing.js */

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

// Small transient notification at the bottom of the screen
function toast(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast';
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
