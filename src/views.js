'use strict';

// Small self-contained HTML pages for the auth flow. Kept as strings (no
// separate assets, all CSS/JS inline) so the login page needs no exception
// in the static-file gate.

const BASE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 420px; margin: 0 auto; padding: 3rem 1rem; line-height: 1.45;
  }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { color: light-dark(#555, #aaa); }
  label { display: block; font-size: 0.8rem; font-weight: 600; margin: 0.8rem 0 0.3rem; color: light-dark(#555, #aaa); }
  input {
    font: inherit; width: 100%; padding: 0.55rem 0.7rem; border-radius: 6px;
    border: 1px solid rgba(128,128,128,0.4); background: canvas; color: canvastext;
  }
  button {
    font: inherit; cursor: pointer; padding: 0.55rem 0.9rem; border-radius: 6px;
    border: 1px solid rgba(128,128,128,0.4); background: transparent; color: canvastext;
  }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; font-weight: 600; width: 100%; margin-top: 1.1rem; }
  button.primary:hover { background: #1d4ed8; }
  button.ghost { width: 100%; margin-top: 0.6rem; }
  button.ghost:hover { background: rgba(128,128,128,0.12); }
  .err { color: #b91c1c; font-size: 0.9rem; margin-top: 0.8rem; min-height: 1.2em; }
  .muted { font-size: 0.85rem; }
  a { color: #2563eb; }
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${BASE_CSS}</style></head><body>${body}</body></html>`;
}

function loginPage({ guestEnabled = false, next = '/' } = {}) {
  const nextJson = JSON.stringify(next);
  const guestBtn = guestEnabled
    ? '<button type="button" class="ghost" id="guestBtn">Continue as guest</button>'
    : '';
  return page(
    'Sign in · NAADS Archive',
    `<h1>NAADS Alert Archive</h1>
<p class="muted">Sign in to continue.</p>
<form id="f" autocomplete="on">
  <label for="u">Username</label>
  <input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit" class="primary">Sign in</button>
  ${guestBtn}
  <div class="err" id="err" role="alert"></div>
</form>
<script>
const NEXT = ${nextJson};
const err = document.getElementById('err');
async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  try {
    await post('/api/login', { username: document.getElementById('u').value, password: document.getElementById('p').value });
    location.href = NEXT;
  } catch (ex) { err.textContent = ex.message; }
});
const gb = document.getElementById('guestBtn');
if (gb) gb.addEventListener('click', async () => {
  err.textContent = '';
  try { await post('/api/guest'); location.href = NEXT; }
  catch (ex) { err.textContent = ex.message; }
});
</script>`
  );
}

function broadcastDeniedPage(kind = 'broadcast') {
  const what = kind === 'admin' ? 'Administrator access' : 'Broadcast access';
  return page(
    what + ' required · NAADS Archive',
    `<h1>${what} required</h1>
<p>Your account doesn't have ${kind === 'admin' ? 'administrator' : 'broadcast'} permissions.
Ask an administrator for a full account, or <a href="/">go back to search</a>.</p>
<p class="muted"><a href="/login">Sign in as a different user</a></p>`
  );
}

function adminPage() {
  return page(
    'Users · NAADS Archive',
    `<h1>Users</h1>
<p class="muted"><a href="/">&larr; Search</a> &nbsp;·&nbsp; <a href="/broadcast">Broadcast</a></p>
<div id="list">Loading…</div>
<h1 style="margin-top:2rem;font-size:1.05rem">Add user</h1>
<form id="add">
  <label for="nu">Username</label><input id="nu" required>
  <label for="np">Password</label><input id="np" type="password" required>
  <label for="nr">Role</label>
  <select id="nr" style="width:100%;padding:0.55rem 0.7rem;border-radius:6px;border:1px solid rgba(128,128,128,0.4);background:canvas;color:canvastext">
    <option value="user">user</option><option value="admin">admin</option>
  </select>
  <button type="submit" class="primary">Create</button>
  <div class="err" id="err" role="alert"></div>
</form>
<script>
const err = document.getElementById('err');
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
function esc(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
async function refresh() {
  try {
    const { users } = await api('GET', '/api/users');
    document.getElementById('list').innerHTML = users.map((u) =>
      '<div style="display:flex;gap:0.5rem;align-items:center;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid rgba(128,128,128,0.2)">' +
      '<span><strong>' + esc(u.username) + '</strong> <span class="muted">' + esc(u.role) + '</span></span>' +
      (u.role === 'guest' ? '' :
        '<span>' +
        '<button data-act="passwd" data-u="' + esc(u.username) + '">Reset password</button> ' +
        '<button data-act="role" data-u="' + esc(u.username) + '" data-r="' + (u.role === 'admin' ? 'user' : 'admin') + '">Make ' + (u.role === 'admin' ? 'user' : 'admin') + '</button> ' +
        '<button data-act="del" data-u="' + esc(u.username) + '">Delete</button>' +
        '</span>') +
      '</div>'
    ).join('');
  } catch (ex) { document.getElementById('list').textContent = ex.message; }
}
document.getElementById('list').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  err.textContent = '';
  try {
    if (b.dataset.act === 'del') {
      if (!confirm('Delete ' + b.dataset.u + '?')) return;
      await api('DELETE', '/api/users/' + encodeURIComponent(b.dataset.u));
    } else if (b.dataset.act === 'role') {
      await api('POST', '/api/users/' + encodeURIComponent(b.dataset.u) + '/role', { role: b.dataset.r });
    } else if (b.dataset.act === 'passwd') {
      const p = prompt('New password for ' + b.dataset.u); if (!p) return;
      await api('POST', '/api/users/' + encodeURIComponent(b.dataset.u) + '/password', { password: p });
    }
    refresh();
  } catch (ex) { err.textContent = ex.message; }
});
document.getElementById('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  try {
    await api('POST', '/api/users', {
      username: document.getElementById('nu').value,
      password: document.getElementById('np').value,
      role: document.getElementById('nr').value,
    });
    document.getElementById('nu').value = '';
    document.getElementById('np').value = '';
    refresh();
  } catch (ex) { err.textContent = ex.message; }
});
refresh();
</script>`
  );
}

function streamPage({ token = '', src = '/hls/live.m3u8', title = 'NAADS Alert Channel' } = {}) {
  const qs = token && src === '/hls/live.m3u8' ? '?token=' + encodeURIComponent(token) : '';
  return page(
    title + ' · NAADS Archive',
    `<h1 style="max-width:none">${title}</h1>
<p class="muted"><a href="/broadcast">&larr; Monitor</a> · continuous HLS feed of alerts as they arrive.</p>
<video id="v" controls autoplay muted playsinline style="width:100%;max-width:960px;background:#000;border-radius:8px"></video>
<p class="muted" id="msg">Loading…</p>
<p class="muted">Player URL for VLC / OBS: <code id="u"></code></p>
<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js"></script>
<script>
const SRC = ${JSON.stringify(src)} + ${JSON.stringify(qs)};
document.getElementById('u').textContent = location.origin + SRC;
const v = document.getElementById('v'), msg = document.getElementById('msg');
if (window.Hls && Hls.isSupported()) {
  const hls = new Hls({
    liveSyncDurationCount: 4,          // start ~4 segments back from live edge
    liveMaxLatencyDurationCount: 16,   // tolerate falling well behind before snapping
    maxBufferLength: 40,
    maxMaxBufferLength: 180,
    backBufferLength: 30,
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 500,
    manifestLoadingMaxRetry: 8,
    levelLoadingMaxRetry: 8,
    nudgeMaxRetry: 10,
  });
  hls.loadSource(SRC);
  hls.attachMedia(v);
  hls.on(Hls.Events.MANIFEST_PARSED, () => { msg.textContent = ''; v.play().catch(() => {}); });
  hls.on(Hls.Events.ERROR, (_, d) => {
    if (!d.fatal) return;
    if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { msg.textContent = 'reconnecting…'; hls.startLoad(); }
    else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { msg.textContent = 'recovering…'; hls.recoverMediaError(); }
    else { msg.textContent = 'Stream error: ' + d.details; hls.destroy(); }
  });
  // If playback stalls for >6s, kick the loader and, if we've drifted far
  // behind, jump back toward the live edge.
  let stalledSince = 0;
  setInterval(() => {
    if (v.paused || v.ended) { stalledSince = 0; return; }
    if (v.readyState >= 3) { stalledSince = 0; msg.textContent = ''; return; }
    if (!stalledSince) stalledSince = Date.now();
    else if (Date.now() - stalledSince > 6000) {
      msg.textContent = 'buffering…';
      hls.startLoad();
      if (hls.liveSyncPosition && v.currentTime < hls.liveSyncPosition - 30) v.currentTime = hls.liveSyncPosition;
      stalledSince = Date.now();
    }
  }, 2000);
} else if (v.canPlayType('application/vnd.apple.mpegurl')) {
  v.src = SRC;
  v.addEventListener('loadedmetadata', () => { msg.textContent = ''; });
} else {
  msg.textContent = 'This browser cannot play HLS.';
}
</script>`
  );
}

module.exports = { loginPage, adminPage, broadcastDeniedPage, streamPage };
