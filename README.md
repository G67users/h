# Relay

A self-hosted Discord/Telegram-style chat app: real accounts (username + password,
hashed with bcrypt), channels, DMs, live presence, and real-time messaging over
WebSockets. Node.js + Express + SQLite backend, no framework on the frontend.

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000, create an account, and start chatting. Open a
second browser (or an incognito window) and sign up as someone else to test
DMs and live presence.

## Put it on GitHub

```bash
cd relay-app
git init
git add .
git commit -m "Initial commit: Relay chat app"
```

Then create a new empty repo on GitHub (github.com/new — don't initialize it
with a README), and push:

```bash
git remote add origin https://github.com/YOUR_USERNAME/relay-chat.git
git branch -M main
git push -u origin main
```

## Deploy it as a real website

This app needs a server that stays running (for the login API and the
WebSocket connection), so **GitHub Pages won't work** — it only hosts static
files. Use one of these instead, both of which deploy straight from your
GitHub repo and have a free tier:

### Render (recommended, simplest)
1. Go to render.com → New → Web Service → connect your GitHub repo.
2. Render will detect `render.yaml` in this repo and configure everything
   automatically (build command, start command, a generated `JWT_SECRET`, and
   a small persistent disk for the database).
3. Click **Create Web Service**. In a couple of minutes you'll get a live URL
   like `https://relay-chat.onrender.com`.

### Railway
1. Go to railway.app → New Project → Deploy from GitHub repo.
2. Railway auto-detects Node and runs `npm install && npm start`.
3. Add an environment variable `JWT_SECRET` set to any long random string.
4. Note: Railway's default filesystem is ephemeral — for the database to
   survive redeploys, attach a Volume mounted at e.g. `/data` and set the
   `DB_PATH` environment variable to `/data/data.db`.

## Important notes before real users touch this

- **Change `JWT_SECRET`** in production — never rely on the default in
  `server/index.js`. Both platforms above let you set it as an environment
  variable.
- **SQLite + free-tier disks**: this is fine for a small group of friends.
  If you expect real growth, migrate to a hosted Postgres (Render and
  Railway both offer a free Postgres instance) — ask me and I can wire that
  up.
- **HTTPS**: both Render and Railway give you HTTPS automatically on their
  provided domain.
- There's currently no email verification or password reset — it's
  username + password only. Say the word if you want either added.

## Project structure

```
relay-app/
  server/
    index.js     — Express API + WebSocket server
    db.js        — SQLite setup (users, channels, messages)
  public/
    index.html
    styles.css
    app.js       — frontend: auth screen + chat UI
  render.yaml    — one-click Render deploy config
  package.json
```
