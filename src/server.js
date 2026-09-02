'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const {
  searchAlerts,
  countAlerts,
  getAlertRawXml,
  getAlertForBroadcast,
  getResourceById,
  stats,
  createStreamKey,
  getStreamKey,
  listStreamKeys,
  listAllStreamKeys,
  deleteStreamKey,
  touchStreamKey,
} = require('./db');
const auth = require('./auth');
const alertBus = require('./alertBus');
const hls = require('./hlsStream');
const { BROADCAST_CLIPS } = require('./broadcastClips');
const { loginPage, adminPage, broadcastDeniedPage, streamPage } = require('./views');

// Query params arrive as strings; only an explicit truthy value should
// activate one of these "only show flagged alerts" filters.
function parseBoolParam(v) {
  return /^(1|true|yes)$/i.test(v || '') || undefined;
}

// Only allow same-origin relative redirect targets from ?next=.
function safeNext(next) {
  if (typeof next !== 'string') return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

function createServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Liveness probe, deliberately before the auth gate so container health
  // checks work whether or not NAADS_AUTH is set.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // --- auth entry points (registered before the gate) ---

  app.get('/login', async (req, res) => {
    if (!auth.authEnabled()) return res.redirect(302, '/');
    try {
      if (await auth.getSession(auth.readSessionCookie(req) || '')) return res.redirect(302, safeNext(req.query.next));
    } catch {
      /* fall through to the login form */
    }
    res.type('html').send(loginPage({ guestEnabled: auth.guestEnabled(), next: safeNext(req.query.next) }));
  });

  app.post('/api/login', async (req, res) => {
    if (!auth.authEnabled()) return res.status(404).json({ error: 'auth is not enabled' });
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (username === auth.GUEST_USERNAME) return res.status(400).json({ error: 'reserved username' });
    if (auth.loginBlocked(req, username)) {
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    try {
      const user = await auth.getUserByUsername(username);
      const ok = await auth.verifyPassword(password, user && user.pass_hash);
      if (!user || !ok || user.role === 'guest') {
        auth.noteLoginFailure(req, username);
        return res.status(401).json({ error: 'invalid credentials' });
      }
      auth.noteLoginSuccess(req, username);
      const { id, expiresAt } = await auth.startSession(user.id, req.headers['user-agent']);
      auth.setSessionCookie(res, id, expiresAt);
      res.json({ ok: true, user: { username: user.username, role: user.role } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/guest', async (req, res) => {
    if (!auth.guestEnabled()) return res.status(404).json({ error: 'guest access is not enabled' });
    try {
      const guest = await auth.ensureGuestUser();
      const { id, expiresAt } = await auth.startSession(guest.id, req.headers['user-agent']);
      auth.setSessionCookie(res, id, expiresAt);
      res.json({ ok: true, user: { username: guest.username, role: 'guest' } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/logout', async (req, res) => {
    const sid = auth.readSessionCookie(req);
    if (sid) {
      try {
        await auth.destroySession(sid);
      } catch {
        /* best effort */
      }
    }
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  // HLS playlists + segments and the keyed player page are registered before
  // the auth gate (which would otherwise 302 them to /login).
  if (hls.enabled) {
    const KEY_RE = /^[a-f0-9]{24,64}$/;

    const serveHls = (dir, req, res) => {
      const file = req.params.file;
      if (!/^[\w.-]+\.(m3u8|ts)$/.test(file)) return res.status(404).end();
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) return res.status(404).end();
      const isPlaylist = file.endsWith('.m3u8');
      res.set('Cache-Control', isPlaylist ? 'no-cache' : 'public, max-age=30');
      res.type(isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      res.sendFile(full);
    };

    // Default channel (airs everything). HLS players can't send the session
    // cookie, so when auth is on access is by NAADS_STREAM_TOKEN or a
    // logged-in user/admin session.
    const defaultAuthOk = async (req) => {
      if (!auth.authEnabled()) return true;
      const tok = process.env.NAADS_STREAM_TOKEN;
      if (tok && req.query.token === tok) return true;
      const sid = auth.readSessionCookie(req);
      if (!sid) return false;
      const s = await auth.getSession(sid);
      return !!s && (s.role === 'user' || s.role === 'admin');
    };
    app.get('/hls/:file', async (req, res) => {
      if (!(await defaultAuthOk(req))) return res.status(401).send('stream access denied');
      serveHls(path.join(hls.CFG.dir, hls.DEFAULT_KEY), req, res);
    });

    // Personal channel: the unguessable key is the only credential -- no
    // login. Bound-to-user keys track that user's saved broadcast prefs.
    app.get('/hls/s/:key/:file', async (req, res) => {
      const key = req.params.key;
      if (!KEY_RE.test(key)) return res.status(404).end();
      let row;
      try {
        row = await getStreamKey(key);
      } catch (e) {
        return res.status(500).end();
      }
      if (!row) return res.status(404).end();
      Promise.resolve(touchStreamKey(key)).catch(() => {});
      const dir = hls.ensureChannel(key, hls.makeKeyFilter(row));
      if (!dir) return res.status(503).send('stream capacity reached; try again shortly');
      serveHls(dir, req, res);
    });

    app.get('/s/:key', async (req, res) => {
      const key = req.params.key;
      let ok = KEY_RE.test(key);
      if (ok) {
        try {
          ok = !!(await getStreamKey(key));
        } catch {
          ok = false;
        }
      }
      if (!ok) return res.status(404).type('html').send('<p>Unknown stream link.</p>');
      res.type('html').send(streamPage({ src: `/hls/s/${key}/live.m3u8`, title: 'Personal Alert Stream' }));
    });
  }

  // --- the gate: everything below requires a session when auth is on ---
  app.use(auth.middleware());

  // /broadcast.html would otherwise be served straight off disk by
  // express.static, side-stepping the role check on /broadcast.
  app.use((req, res, next) => {
    if (req.path === '/broadcast.html') return res.redirect(308, '/broadcast');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/me', (req, res) => {
    if (!auth.authEnabled()) return res.json({ authEnabled: false, guestEnabled: false, streamEnabled: hls.enabled });
    res.json({
      authEnabled: true,
      guestEnabled: auth.guestEnabled(),
      streamEnabled: hls.enabled,
      username: req.user.username,
      role: req.user.role,
      canBroadcast: req.user.role === 'user' || req.user.role === 'admin',
    });
  });

  app.get('/api/stats', async (req, res) => {
    try {
      res.json(await stats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/search', async (req, res) => {
    const { q, event, severity, urgency, status, from, to, language } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const broadcastImmediate = parseBoolParam(req.query.broadcastImmediate);
    const wirelessImmediate = parseBoolParam(req.query.wirelessImmediate);
    const filters = { q, event, severity, urgency, status, from, to, language, broadcastImmediate, wirelessImmediate };
    try {
      const results = await searchAlerts({ ...filters, limit, offset });
      const total = await countAlerts(filters);
      res.json({ count: results.length, total, limit, offset, results });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/alert/:id/xml', async (req, res) => {
    try {
      const xml = await getAlertRawXml(req.params.id);
      if (!xml) return res.status(404).send('Not found');
      res.type('application/xml').send(xml);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // Serves a CAP <resource> attachment (e.g. broadcast audio) referenced
  // from a search result. Embedded (base64) resources are streamed
  // directly; resources that were only linked by external URL are
  // redirected there instead of proxied.
  app.get('/api/resource/:id', async (req, res) => {
    try {
      const resource = await getResourceById(req.params.id);
      if (!resource) return res.status(404).send('Not found');
      if (resource.data) {
        res.type(resource.mime_type || 'application/octet-stream');
        res.send(resource.data);
      } else if (resource.uri) {
        res.redirect(resource.uri);
      } else {
        res.status(404).send('No data available for this resource');
      }
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- live broadcast feed ---

  app.get('/broadcast', (req, res) => {
    if (auth.authEnabled() && !auth.hasBroadcastAccess(req)) {
      return res.status(403).type('html').send(broadcastDeniedPage());
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'broadcast.html'));
  });

  // Server-Sent Events: one `alert` event per newly-received alert, plus a
  // periodic comment so intermediaries don't close an idle connection. The
  // optional query filters are a coarse pre-filter; the page still applies
  // its own location gate to decide what auto-plays.
  app.get('/api/stream', (req, res) => {
    if (!auth.requireBroadcast(req, res)) return;

    // Express routes HEAD to this GET handler; answer it without opening the
    // never-ending stream body.
    if (req.method === 'HEAD') {
      return res.set('Content-Type', 'text/event-stream').status(200).end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    const wantBI = parseBoolParam(req.query.broadcastImmediate);
    const wantWI = parseBoolParam(req.query.wirelessImmediate);
    const wantEvent = String(req.query.event || '').toLowerCase();
    const wantSeverity = String(req.query.severity || '');

    const onAlert = (alert) => {
      if (wantBI && alert.broadcastImmediate !== true) return;
      if (wantWI && alert.wirelessImmediate !== true) return;
      if (wantEvent && !String(alert.event || '').toLowerCase().includes(wantEvent)) return;
      if (wantSeverity && alert.severity !== wantSeverity) return;
      res.write(`event: alert\ndata: ${JSON.stringify(alert)}\n\n`);
    };
    alertBus.on('alert', onAlert);

    const keepalive = setInterval(() => res.write(`: keepalive ${Date.now()}\n\n`), 25000);
    req.on('close', () => {
      clearInterval(keepalive);
      alertBus.off('alert', onAlert);
    });
  });

  // Serves one of the fixed broadcast clips (pre-tone / tone / post-message).
  // HEAD is used by the monitor page to discover which are available.
  const sendClip = (req, res) => {
    if (!auth.requireBroadcast(req, res)) return;
    const clip = BROADCAST_CLIPS[req.params.slot];
    if (clip === undefined) return res.status(404).send('Unknown clip');
    if (!clip) return res.status(404).send('Not configured');
    res.type(path.extname(clip) || '.mp3');
    res.sendFile(clip);
  };
  app.get('/api/broadcast-audio/:slot', sendClip);
  app.head('/api/broadcast-audio/:slot', sendClip);

  app.get('/api/broadcast-prefs', async (req, res) => {
    if (!auth.authEnabled()) return res.json({});
    if (!auth.requireBroadcast(req, res)) return;
    try {
      res.json((await auth.getBroadcastPrefs(req.user.id)) || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/broadcast-prefs', async (req, res) => {
    if (!auth.authEnabled()) return res.json(req.body && typeof req.body === 'object' ? req.body : {});
    if (!auth.requireBroadcast(req, res)) return;
    const prefs = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    try {
      await auth.setBroadcastPrefs(req.user.id, prefs);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Operator-triggered test: replays a stored alert through the live bus so
  // it exercises the whole monitor + HLS pipeline. Bypasses every filter
  // (`manualTest`) and is lightly rate-limited. `?id=` picks the alert
  // (default NAADS_TEST_ALERT_ID / 815048); `?raw=1` keeps its real
  // status/headline instead of showing it as a grey TEST card.
  let lastBroadcastTest = 0;
  app.post('/api/broadcast-test', async (req, res) => {
    if (auth.authEnabled() && !auth.requireBroadcast(req, res)) return;
    if (Date.now() - lastBroadcastTest < 8000) {
      return res.status(429).json({ error: 'a test was just sent — wait a few seconds' });
    }
    const id = req.query.id || (req.body && req.body.id) || process.env.NAADS_TEST_ALERT_ID || '815048';
    const raw = /^(1|true|yes)$/i.test(req.query.raw || (req.body && req.body.raw) || '');
    try {
      const alert = await getAlertForBroadcast(id, { language: process.env.NAADS_BROADCAST_LANG || 'en' });
      if (!alert) return res.status(404).json({ error: `alert ${id} not in the database` });
      lastBroadcastTest = Date.now();
      alertBus.emit('alert', {
        ...alert,
        ...(raw ? {} : { status: 'Test', headline: `TEST — ${alert.headline || alert.event || 'broadcast monitor'}` }),
        manualTest: true,
        receivedAt: new Date().toISOString(),
      });
      res.json({ ok: true, emitted: alert.id, raw });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Browser player for the default HLS channel + personal-stream key
  // management (segments/playlists are served by the pre-gate routes above).
  if (hls.enabled) {
    app.get('/stream', (req, res) => {
      if (auth.authEnabled() && !auth.hasBroadcastAccess(req)) {
        return res.status(403).type('html').send(broadcastDeniedPage());
      }
      res.type('html').send(streamPage({ token: process.env.NAADS_STREAM_TOKEN || '' }));
    });

    // A personal stream key: an unguessable URL that airs only alerts
    // matching a filter, with no login. `fromPrefs` binds it to the caller's
    // account so it follows their saved monitor filter; otherwise the posted
    // `filter` (or {}) is stored on the key.
    app.post('/api/stream-keys', async (req, res) => {
      if (auth.authEnabled() && !auth.requireBroadcast(req, res)) return;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const key = crypto.randomBytes(20).toString('hex');
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
      let userId = null;
      let filter = null;
      if (body.fromPrefs && req.user) userId = req.user.id;
      else filter = body.filter && typeof body.filter === 'object' && !Array.isArray(body.filter) ? body.filter : {};
      try {
        const row = await createStreamKey({ key, userId, filter, label });
        res.json({ key: row.key, url: `/hls/s/${row.key}/live.m3u8`, page: `/s/${row.key}`, boundToUser: !!userId, label: row.label });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.get('/api/stream-keys', async (req, res) => {
      if (auth.authEnabled() && !auth.requireBroadcast(req, res)) return;
      try {
        const rows =
          auth.authEnabled() && req.user.role !== 'admin' ? await listStreamKeys(req.user.id) : await listAllStreamKeys();
        res.json({
          keys: rows.map((r) => ({
            key: r.key,
            label: r.label,
            boundToUser: !!r.user_id,
            username: r.username,
            createdAt: r.created_at,
            lastUsedAt: r.last_used_at,
            url: `/hls/s/${r.key}/live.m3u8`,
            page: `/s/${r.key}`,
          })),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.delete('/api/stream-keys/:key', async (req, res) => {
      if (auth.authEnabled() && !auth.requireBroadcast(req, res)) return;
      try {
        if (auth.authEnabled() && req.user.role !== 'admin') {
          const mine = await listStreamKeys(req.user.id);
          if (!mine.some((r) => r.key === req.params.key)) return res.status(404).json({ error: 'not found' });
        }
        await deleteStreamKey(req.params.key);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  // Dev-only: replay a stored alert through the live bus so the whole
  // pipeline is testable without waiting for a real one.
  app.post('/api/dev/emit-alert', async (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found');
    if (!auth.requireAdmin(req, res)) return;
    const id = req.query.id || (req.body && req.body.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const alert = await getAlertForBroadcast(id, { language: process.env.NAADS_BROADCAST_LANG || 'en' });
      if (!alert) return res.status(404).json({ error: 'alert not found' });
      alert.receivedAt = new Date().toISOString();
      alertBus.emit('alert', alert);
      res.json({ ok: true, emitted: alert.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- admin: user management (CLI `npm run user` is the primary path) ---

  app.get('/admin', (req, res) => {
    if (auth.authEnabled() && !auth.isAdmin(req)) return res.status(403).type('html').send(broadcastDeniedPage('admin'));
    res.type('html').send(adminPage());
  });

  app.get('/api/users', async (req, res) => {
    if (!auth.requireAdmin(req, res)) return;
    try {
      res.json({ users: await auth.listUsers() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', async (req, res) => {
    if (!auth.requireAdmin(req, res)) return;
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const role = String((req.body && req.body.role) || 'user');
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (username === auth.GUEST_USERNAME) return res.status(400).json({ error: 'reserved username' });
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be user or admin' });
    try {
      if (await auth.getUserByUsername(username)) return res.status(409).json({ error: 'username already exists' });
      await auth.createUser(username, password, role);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users/:username/password', async (req, res) => {
    if (!auth.requireAdmin(req, res)) return;
    const password = String((req.body && req.body.password) || '');
    if (!password) return res.status(400).json({ error: 'password required' });
    try {
      const changed = await auth.setPassword(req.params.username, password);
      if (!changed) return res.status(404).json({ error: 'no such user' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users/:username/role', async (req, res) => {
    if (!auth.requireAdmin(req, res)) return;
    const role = String((req.body && req.body.role) || '');
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be user or admin' });
    try {
      const users = await auth.listUsers();
      const target = users.find((u) => u.username === req.params.username);
      if (!target) return res.status(404).json({ error: 'no such user' });
      const admins = users.filter((u) => u.role === 'admin');
      if (target.role === 'admin' && role !== 'admin' && admins.length <= 1) {
        return res.status(409).json({ error: 'cannot demote the last admin' });
      }
      await auth.setRole(req.params.username, role);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/users/:username', async (req, res) => {
    if (!auth.requireAdmin(req, res)) return;
    if (req.params.username === auth.GUEST_USERNAME) return res.status(400).json({ error: 'reserved username' });
    try {
      const users = await auth.listUsers();
      const target = users.find((u) => u.username === req.params.username);
      if (!target) return res.status(404).json({ error: 'no such user' });
      const admins = users.filter((u) => u.role === 'admin');
      if (target.role === 'admin' && admins.length <= 1) {
        return res.status(409).json({ error: 'cannot delete the last admin' });
      }
      await auth.deleteUser(req.params.username);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

function startServer(port = process.env.PORT || 3000) {
  const app = createServer();
  return app.listen(port, () => {
    console.log(`[server] search UI at http://localhost:${port}`);
    console.log(`[server] live broadcast monitor at http://localhost:${port}/broadcast`);
  });
}

module.exports = { createServer, startServer };
