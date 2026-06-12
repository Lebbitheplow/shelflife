/* ShelfLife — landing page profile lookup */

const form = document.getElementById('search-form');
const input = document.getElementById('profile-input');
const btn = form.querySelector('button');

// Show error passed via URL param (e.g. redirect from a missing profile)
const params = new URLSearchParams(location.search);
if (params.get('error') && !document.querySelector('.landing-error')) {
  insertError(params.get('error'));
}

function insertError(msg) {
  const el = document.createElement('div');
  el.className = 'landing-error';
  el.textContent = msg;
  form.before(el);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = input.value.trim();
  if (!val) return;

  btn.disabled = true;
  btn.textContent = 'Looking up profile...';

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: val }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.querySelectorAll('.landing-error').forEach(el => el.remove());
      insertError(data.error || 'Something went wrong.');
      btn.disabled = false;
      btn.textContent = 'Explore My Library';
      return;
    }
    window.location.href = `/profile/${data.steamId}`;
  } catch (err) {
    insertError('Network error. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Explore My Library';
  }
});
