const Database = require('better-sqlite3');
const path = require('path');

// NOTE: On most free hosting tiers (Render/Railway free plans) the filesystem
// is ephemeral and resets on redeploy. For real production use, attach a
// persistent disk (Render "Disks", Railway "Volumes") mounted at /data, or
// swap this out for a hosted Postgres database. Both platforms offer a free
// Postgres instance if you outgrow SQLite.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room);
`);

// Seed default channels the first time the DB is created.
const channelCount = db.prepare('SELECT COUNT(*) AS c FROM channels').get().c;
if (channelCount === 0) {
  const insert = db.prepare('INSERT INTO channels (name, created_at) VALUES (?, ?)');
  insert.run('general', Date.now());
  insert.run('random', Date.now());
}

module.exports = db;
