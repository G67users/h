const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const db = require('./db');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const PORT = process.env.PORT || 3000;
const PRESENCE_WINDOW_MS = 20000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------- Auth helpers ----------------
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------- Auth routes ----------------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'That username is taken' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, Date.now());
  const user = { id: info.lastInsertRowid, username };
  res.json({ token: signToken(user), username: user.username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  res.json({ token: signToken(user), username: user.username });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

// ---------------- Channels ----------------
app.get('/api/channels', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT name FROM channels ORDER BY created_at ASC').all();
  res.json(rows.map(r => r.name));
});

app.post('/api/channels', authMiddleware, (req, res) => {
  let { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Channel name required' });
  name = String(name).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Invalid channel name' });
  try {
    db.prepare('INSERT INTO channels (name, created_at) VALUES (?, ?)').run(name, Date.now());
  } catch (e) {
    // already exists — fine, just return it
  }
  broadcastAll({ type: 'channel_created', name });
  res.json({ name });
});

// ---------------- Users (for DM picker) ----------------
app.get('/api/users', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT username FROM users ORDER BY username ASC').all();
  res.json(rows.map(r => r.username));
});

// ---------------- Messages ----------------
function roomKey(type, id, me) {
  if (type === 'channel') return 'channel:' + id;
  return 'dm:' + [me, id].map(s => s.toLowerCase()).sort().join('__');
}

app.get('/api/messages', authMiddleware, (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type and id query params required' });
  const room = roomKey(type, id, req.user.username);
  const rows = db.prepare('SELECT id, username, text, created_at AS ts FROM messages WHERE room = ? ORDER BY id ASC LIMIT 200')
    .all(room);
  res.json(rows);
});

// ---------------- WebSocket (realtime messages + presence) ----------------
const wss = new WebSocketServer({ server, path: '/ws' });

/** Map<username, Set<ws>> so a user can have multiple tabs open */
const connections = new Map();
/** Map<ws, { username, room }> */
const socketMeta = new Map();

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

function broadcastToRoom(room, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, meta] of socketMeta.entries()) {
    if (meta.room === room && ws.readyState === 1) ws.send(data);
  }
}

function broadcastPresence() {
  const online = Array.from(connections.keys());
  broadcastAll({ type: 'presence', online });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      try {
        const decoded = jwt.verify(msg.token, JWT_SECRET);
        socketMeta.set(ws, { username: decoded.username, room: null });
        if (!connections.has(decoded.username)) connections.set(decoded.username, new Set());
        connections.get(decoded.username).add(ws);
        broadcastPresence();
      } catch {
        ws.close();
      }
      return;
    }

    const meta = socketMeta.get(ws);
    if (!meta) return; // must auth first

    if (msg.type === 'join') {
      const room = roomKey(msg.roomType, msg.roomId, meta.username);
      socketMeta.set(ws, { ...meta, room });
      return;
    }

    if (msg.type === 'message') {
      const room = roomKey(msg.roomType, msg.roomId, meta.username);
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get(meta.username);
      if (!user) return;
      const text = String(msg.text || '').slice(0, 4000);
      if (!text.trim()) return;
      const info = db.prepare('INSERT INTO messages (room, user_id, username, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(room, user.id, meta.username, text, Date.now());
      const payload = {
        type: 'message',
        room,
        message: { id: info.lastInsertRowid, username: meta.username, text, ts: Date.now() }
      };
      broadcastToRoom(room, payload);
      return;
    }
  });

  ws.on('close', () => {
    const meta = socketMeta.get(ws);
    socketMeta.delete(ws);
    if (meta) {
      const set = connections.get(meta.username);
      if (set) {
        set.delete(ws);
        if (set.size === 0) connections.delete(meta.username);
      }
      broadcastPresence();
    }
  });
});

// Ping clients periodically to detect dead connections.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PRESENCE_WINDOW_MS);

server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
