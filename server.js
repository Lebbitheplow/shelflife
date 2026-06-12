require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const APP_VERSION = require('./package.json').version;

const app = express();
const PORT = process.env.PORT || 3233;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Single source of truth for cache busting — views and the service worker
// all derive their asset versions from package.json
app.locals.assetV = APP_VERSION;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the service worker with the app version injected so its cache name and
// precache list stay in sync with the views. Registered before express.static
// so this route wins over the raw file in public/.
const swBody = fs
  .readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8')
  .replaceAll('__APP_VERSION__', APP_VERSION);
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(swBody);
});

app.use(express.static(path.join(__dirname, 'public')));

const { router: apiRouter, runLoadJob } = require('./routes/api');
const pagesRouter = require('./routes/pages');
const db = require('./db/database');

app.get('/health', (req, res) => {
  try {
    db.healthCheck();
    res.json({ ok: true, version: APP_VERSION });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

app.use('/api', apiRouter);
app.use('/', pagesRouter);

// Safety net for fire-and-forget background jobs — log instead of crashing
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});

// ── Background refresh scheduler ─────────────────────────────────────────────
// Periodically re-fetches Steam data and rebuilds recommendations for active users.
// Staggered 30s apart to avoid hammering the Steam API.
const REFRESH_INTERVAL_MS = (parseFloat(process.env.REFRESH_INTERVAL_HOURS) || 24) * 60 * 60 * 1000;

async function runScheduledRefresh() {
  const users = db.getActiveUsers(30); // active in last 30 days
  if (!users.length) return;
  console.log(`[refresh] Scheduled refresh starting for ${users.length} user(s)`);
  for (let i = 0; i < users.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 30_000));
    console.log(`[refresh] Refreshing ${users[i]} (${i + 1}/${users.length})`);
    runLoadJob(users[i]).catch(err => console.error('[refresh] job failed:', err));
  }
}

setInterval(runScheduledRefresh, REFRESH_INTERVAL_MS).unref();
console.log(`[refresh] Background refresh scheduled every ${process.env.REFRESH_INTERVAL_HOURS || 24}h`);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ShelfLife running on http://0.0.0.0:${PORT}`);
});
