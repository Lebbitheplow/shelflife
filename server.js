require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3233;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

class SQLiteStore extends session.Store {
  constructor({ dir, db: dbFile }) {
    super();
    const sessDb = new DatabaseSync(path.join(dir, dbFile));
    sessDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT NOT NULL PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    this._db = sessDb;
    setInterval(() => this._pruneExpired(), 15 * 60 * 1000).unref();
  }

  get(sid, cb) {
    const now = Math.floor(Date.now() / 1000);
    const row = this._db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired >= ?').get(sid, now);
    cb(null, row ? JSON.parse(row.sess) : null);
  }

  set(sid, session, cb) {
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge / 1000 : 86400;
    const expired = Math.floor(Date.now() / 1000) + Math.floor(maxAge);
    this._db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
      .run(sid, JSON.stringify(session), expired);
    cb(null);
  }

  destroy(sid, cb) {
    this._db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb(null);
  }

  touch(sid, session, cb) {
    const maxAge = (session.cookie && session.cookie.maxAge) ? session.cookie.maxAge / 1000 : 86400;
    const expired = Math.floor(Date.now() / 1000) + Math.floor(maxAge);
    this._db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid);
    cb(null);
  }

  _pruneExpired() {
    this._db.prepare('DELETE FROM sessions WHERE expired < ?').run(Math.floor(Date.now() / 1000));
  }
}

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is not set'); })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

const { router: apiRouter } = require('./routes/api');
const pagesRouter = require('./routes/pages');

app.use('/api', apiRouter);
app.use('/', pagesRouter);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ShelfLife running on http://0.0.0.0:${PORT}`);
});
