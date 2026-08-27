(function () {
  const app = document.getElementById('app');
  const API = ''; // same-origin
  const ONLINE_WINDOW_MS = 25000;

  const state = {
    token: localStorage.getItem('relay_token') || null,
    me: localStorage.getItem('relay_username') || null,
    channels: [],
    users: [],
    online: [],
    active: { type: 'channel', id: 'general' },
    messages: [],
    ws: null,
    authMode: 'login' // or 'register'
  };

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------------- Auth screen ----------------
  function renderAuth(error) {
    const isLogin = state.authMode === 'login';
    app.innerHTML = `
      <div class="auth-screen">
        <div class="auth-logo"><span style="color:var(--accent)">&#9673;</span> Relay</div>
        <div class="auth-tag">Servers, channels, and DMs — your own frequency.</div>
        <div class="auth-card">
          ${error ? `<div class="auth-error">${esc(error)}</div>` : ''}
          <input id="auth-username" placeholder="Username" autocomplete="username" />
          <input id="auth-password" type="password" placeholder="Password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
          <button class="primary" id="auth-submit">${isLogin ? 'Log in' : 'Create account'}</button>
          <div class="auth-switch">
            ${isLogin ? "New here? <a id='auth-toggle'>Create an account</a>" : "Already have one? <a id='auth-toggle'>Log in</a>"}
          </div>
        </div>
      </div>
    `;
    document.getElementById('auth-toggle').addEventListener('click', () => {
      state.authMode = isLogin ? 'register' : 'login';
      renderAuth();
    });
    const submit = document.getElementById('auth-submit');
    const doSubmit = () => handleAuthSubmit();
    submit.addEventListener('click', doSubmit);
    document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
  }

  async function handleAuthSubmit() {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!username || !password) return renderAuth('Enter a username and password.');
    try {
      const endpoint = state.authMode === 'login' ? '/api/login' : '/api/register';
      const data = await api(endpoint, { method: 'POST', body: { username, password } });
      state.token = data.token;
      state.me = data.username;
      localStorage.setItem('relay_token', state.token);
      localStorage.setItem('relay_username', state.me);
      await boot();
    } catch (e) {
      renderAuth(e.message);
    }
  }

  function logout() {
    localStorage.removeItem('relay_token');
    localStorage.removeItem('relay_username');
    state.token = null; state.me = null;
    if (state.ws) state.ws.close();
    renderAuth();
  }

  // ---------------- Main shell ----------------
  function renderShell() {
    app.innerHTML = `
      <div class="shell">
        <div class="rail">
          <div class="rail-header">
            <div class="brand"><span class="dot"></span>Relay</div>
            <div class="sub">home</div>
          </div>
          <div class="rail-list">
            <div class="rail-section"><span class="label-text">Channels</span><button id="add-channel-btn">+</button></div>
            <div id="add-channel-form"></div>
            <div id="channel-list"></div>
            <div class="rail-section" style="margin-top:10px"><span class="label-text">Direct</span></div>
            <div id="dm-list"></div>
          </div>
          <div class="rail-footer">
            <div class="who"><div class="avatar">${esc(initials(state.me))}</div>
              <div><div class="me-name">${esc(state.me)}</div><div class="me-status mono">&#9679; online</div></div>
            </div>
            <button class="logout-btn" id="logout-btn">Log out</button>
          </div>
        </div>
        <div class="main">
          <div class="topbar">
            <div class="title" id="active-title"></div>
            <div class="count mono" id="active-sub"></div>
          </div>
          <div class="thread" id="thread"></div>
          <div class="composer">
            <div class="composer-inner">
              <textarea id="composer-input" rows="1" placeholder="Message"></textarea>
              <button class="send-btn" id="send-btn" disabled>Send</button>
            </div>
          </div>
        </div>
        <div class="members">
          <div class="heading" id="members-heading"></div>
          <div id="members-list"></div>
        </div>
      </div>
    `;

    document.getElementById('logout-btn').addEventListener('click', logout);

    const composerInput = document.getElementById('composer-input');
    const sendBtn = document.getElementById('send-btn');
    composerInput.addEventListener('input', () => { sendBtn.disabled = !composerInput.value.trim(); });
    composerInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    sendBtn.addEventListener('click', sendMessage);

    document.getElementById('add-channel-btn').addEventListener('click', () => {
      const form = document.getElementById('add-channel-form');
      form.innerHTML = form.innerHTML ? '' : `<div class="new-row-form"><input id="new-channel-input" placeholder="channel-name" /><button id="new-channel-btn">Add</button></div>`;
      if (form.innerHTML) {
        document.getElementById('new-channel-input').focus();
        document.getElementById('new-channel-input').addEventListener('keydown', e => { if (e.key === 'Enter') createChannel(); });
        document.getElementById('new-channel-btn').addEventListener('click', createChannel);
      }
    });
  }

  async function createChannel() {
    const input = document.getElementById('new-channel-input');
    if (!input || !input.value.trim()) return;
    try {
      const data = await api('/api/channels', { method: 'POST', body: { name: input.value.trim() } });
      document.getElementById('add-channel-form').innerHTML = '';
      await refreshChannels();
      setActive({ type: 'channel', id: data.name });
    } catch (e) { /* silent */ }
  }

  function renderChannelList() {
    const el = document.getElementById('channel-list');
    el.innerHTML = state.channels.map(c => `
      <div class="rail-item ${state.active.type === 'channel' && state.active.id === c ? 'active' : ''}" data-type="channel" data-id="${esc(c)}">
        <span>#</span><span class="label-text">${esc(c)}</span>
      </div>`).join('');
    el.querySelectorAll('.rail-item').forEach(item => {
      item.addEventListener('click', () => setActive({ type: 'channel', id: item.dataset.id }));
    });
  }

  function renderDMList() {
    const el = document.getElementById('dm-list');
    const others = state.users.filter(u => u !== state.me);
    if (others.length === 0) {
      el.innerHTML = `<div class="rail-empty label-text">No one else has joined yet.</div>`;
      return;
    }
    el.innerHTML = others.map(u => `
      <div class="rail-item ${state.active.type === 'dm' && state.active.id === u ? 'active' : ''}" data-type="dm" data-id="${esc(u)}">
        <span class="presence-dot" data-presence-for="${esc(u)}" style="background:${state.online.includes(u) ? 'var(--live)' : 'var(--surface-3)'}"></span>
        <span class="label-text">${esc(u)}</span>
      </div>`).join('');
    el.querySelectorAll('.rail-item').forEach(item => {
      item.addEventListener('click', () => setActive({ type: 'dm', id: item.dataset.id }));
    });
  }

  function renderMembers() {
    const others = state.users.filter(u => u !== state.me);
    document.getElementById('members-heading').textContent = `Members — ${1 + others.length}`;
    const el = document.getElementById('members-list');
    let html = `<div class="member-row"><span class="presence-dot" style="background:var(--live)"></span>${esc(state.me)} <span class="mono" style="color:var(--text-muted);font-size:11px">(you)</span></div>`;
    html += others.map(u => `
      <div class="member-row" data-id="${esc(u)}">
        <span class="presence-dot" data-presence-for="${esc(u)}" style="background:${state.online.includes(u) ? 'var(--live)' : 'var(--surface-3)'}"></span>${esc(u)}
      </div>`).join('');
    el.innerHTML = html;
    el.querySelectorAll('.member-row[data-id]').forEach(item => {
      item.addEventListener('click', () => setActive({ type: 'dm', id: item.dataset.id }));
    });
  }

  function updatePresenceDots() {
    document.querySelectorAll('[data-presence-for]').forEach(dot => {
      const u = dot.getAttribute('data-presence-for');
      dot.style.background = state.online.includes(u) ? 'var(--live)' : 'var(--surface-3)';
    });
    const sub = document.getElementById('active-sub');
    if (sub && state.active.type === 'dm') sub.textContent = state.online.includes(state.active.id) ? 'online' : 'offline';
  }

  function renderThread() {
    const el = document.getElementById('thread');
    if (!el) return;
    const title = state.active.type === 'channel' ? '#' + state.active.id : state.active.id;
    if (state.messages.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="glyph">&#9673;</div><div class="title">Nothing here yet</div><div>Be the first to send something in ${esc(title)}.</div></div>`;
      return;
    }
    el.innerHTML = state.messages.map(m => `
      <div class="msg-row">
        <div class="avatar">${esc(initials(m.username))}</div>
        <div class="msg-body">
          <div class="msg-head"><span class="name">${esc(m.username)}</span><span class="time mono">${esc(fmtTime(m.ts))}</span></div>
          <div class="msg-text">${esc(m.text)}</div>
        </div>
      </div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  async function refreshChannels() {
    state.channels = await api('/api/channels');
    renderChannelList();
  }
  async function refreshUsers() {
    state.users = await api('/api/users');
    renderDMList();
    renderMembers();
  }

  async function setActive(target) {
    state.active = target;
    renderChannelList();
    renderDMList();
    const title = target.type === 'channel' ? '#' + target.id : target.id;
    document.getElementById('active-title').textContent = title;
    document.getElementById('composer-input').placeholder = 'Message ' + title;
    document.getElementById('active-sub').textContent = target.type === 'dm' ? (state.online.includes(target.id) ? 'online' : 'offline') : '';

    state.messages = await api('/api/messages?type=' + target.type + '&id=' + encodeURIComponent(target.id));
    renderThread();

    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'join', roomType: target.type, roomId: target.id }));
    }
  }

  function sendMessage() {
    const input = document.getElementById('composer-input');
    const text = input.value.trim();
    if (!text || !state.ws || state.ws.readyState !== 1) return;
    state.ws.send(JSON.stringify({ type: 'message', roomType: state.active.type, roomId: state.active.id, text }));
    input.value = '';
    document.getElementById('send-btn').disabled = true;
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws');
    state.ws = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: state.token }));
      ws.send(JSON.stringify({ type: 'join', roomType: state.active.type, roomId: state.active.id }));
    });

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'presence') {
        state.online = msg.online;
        updatePresenceDots();
      } else if (msg.type === 'message') {
        const activeRoomKey = state.active.type === 'channel'
          ? 'channel:' + state.active.id
          : 'dm:' + [state.me, state.active.id].map(s => s.toLowerCase()).sort().join('__');
        if (msg.room === activeRoomKey) {
          state.messages.push(msg.message);
          renderThread();
        }
      } else if (msg.type === 'channel_created') {
        refreshChannels();
      }
    });

    ws.addEventListener('close', () => {
      // simple auto-reconnect
      setTimeout(() => { if (state.token) connectWS(); }, 2000);
    });
  }

  async function boot() {
    if (!state.token) return renderAuth();
    try {
      const me = await api('/api/me');
      state.me = me.username;
    } catch (e) {
      return logout();
    }
    renderShell();
    await refreshChannels();
    await refreshUsers();
    connectWS();
    await setActive(state.active);
    // periodically refresh the user list so new signups show up as DM targets
    setInterval(refreshUsers, 8000);
  }

  boot();
})();
