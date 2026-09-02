'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// All of this is inert unless NAADS_AUTH is set: authEnabled() gates the
// middleware and every guard, so an unconfigured install behaves exactly as
// it did before accounts existed.

const GUEST_USERNAME = 'guest';
const COOKIE_NAME = 'naads_session';
const BCRYPT_ROUNDS = 10;
const ROLES = ['guest', 'user', 'admin'];

// A real hash of a throwaway secret: verifyPassword() runs a compare against
// this when the username is unknown, so a missing user costs about the same
// wall-clock time as a wrong password (blunts username enumeration).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

const truthy = (v) => /^(1|true|yes|on)$/i.test(v || '');

function authEnabled() {
  return truthy(process.env.NAADS_AUTH);
}

function guestEnabled() {
  return authEnabled() && (process.env.NAADS_GUEST || '') !== '0';
}

function secureCookies() {
  return truthy(process.env.NAADS_AUTH_SECURE);
}

function sessionTtlMs() {
  const hours = Number(process.env.NAADS_SESSION_TTL_HOURS) || 720; // 30 days
  return Math.max(1, hours) * 60 * 60 * 1000;
}

// --- passwords ---

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  // An empty hash (the reserved guest row) must never verify.
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

// --- users (thin wrappers; callers never touch ./db directly) ---

async function createUser(username, plainPassword, role = 'user') {
  const passHash = await hashPassword(plainPassword);
  return db.createUser({ username, passHash, role });
}

const getUserByUsername = (username) => db.getUserByUsername(username);
const getUserById = (id) => db.getUserById(id);
const listUsers = () => db.listUsers();
const countUsers = () => db.countUsers(); // excludes the reserved guest row
const setRole = (username, role) => db.setUserRole(username, role);
const deleteUser = (username) => db.deleteUser(username);
const getBroadcastPrefs = (id) => db.getUserBroadcastPrefs(id);
const setBroadcastPrefs = (id, prefs) => db.setUserBroadcastPrefs(id, prefs);

async function setPassword(username, plainPassword) {
  return db.updateUserPassword(username, await hashPassword(plainPassword));
}

/**
 * Upserts the reserved `guest` account that no-credential guest sessions
 * point at. Its pass_hash is empty, so it can never be logged into with a
 * password.
 */
async function ensureGuestUser() {
  const existing = await getUserByUsername(GUEST_USERNAME);
  if (existing) {
    if (existing.role !== 'guest') await db.setUserRole(GUEST_USERNAME, 'guest');
    return existing;
  }
  return db.createUser({ username: GUEST_USERNAME, passHash: '', role: 'guest' });
}

// --- sessions ---

async function startSession(userId, userAgent) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionTtlMs()).toISOString();
  await db.createSession({ id, userId, expiresAt, userAgent: (userAgent || '').slice(0, 500) });
  return { id, expiresAt };
}

const getSession = (id) => db.getSessionWithUser(id);
const destroySession = (id) => db.destroySession(id);
const deleteExpiredSessions = () => db.deleteExpiredSessions();

// --- cookie helpers (hand-rolled to avoid a cookie-parser dependency) ---

function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res, id, expiresAt) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secureCookies()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookies()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// --- login throttle (in-memory, per IP + username) ---

const attempts = new Map();
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttleKey(req, username) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';
  return `${ip}:${username || ''}`;
}

function loginBlocked(req, username) {
  const rec = attempts.get(throttleKey(req, username));
  return !!rec && Date.now() - rec.first <= THROTTLE_WINDOW_MS && rec.count >= MAX_ATTEMPTS;
}

function noteLoginFailure(req, username) {
  const key = throttleKey(req, username);
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > THROTTLE_WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

function noteLoginSuccess(req, username) {
  attempts.delete(throttleKey(req, username));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.first > THROTTLE_WINDOW_MS) attempts.delete(key);
  }
}, THROTTLE_WINDOW_MS).unref();

// --- request-time role checks ---

async function resolveUser(req) {
  const sid = readSessionCookie(req);
  if (!sid) return null;
  const session = await getSession(sid);
  if (!session) return null;
  return {
    id: session.userId,
    username: session.username,
    role: session.role,
    sessionId: session.id,
    broadcastPrefs: session.broadcastPrefs,
  };
}

/**
 * Express middleware. No-op when auth is disabled. Otherwise attaches
 * `req.user` from the session cookie, or rejects: 401 JSON for `/api/*`,
 * a redirect to `/login` for everything else.
 */
function middleware() {
  return async (req, res, next) => {
    if (!authEnabled()) return next();
    let user;
    try {
      user = await resolveUser(req);
    } catch (err) {
      return res.status(500).json({ error: 'auth check failed' });
    }
    if (user) {
      req.user = user;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'authentication required' });
    return res.redirect(302, '/login');
  };
}

function hasBroadcastAccess(req) {
  if (!authEnabled()) return true;
  return !!req.user && (req.user.role === 'user' || req.user.role === 'admin');
}

function isAdmin(req) {
  if (!authEnabled()) return true;
  return !!req.user && req.user.role === 'admin';
}

/** API guard: returns true if allowed, else sends 401/403 and returns false. */
function requireRoles(req, res, roles) {
  if (!authEnabled()) return true;
  if (req.user && roles.includes(req.user.role)) return true;
  const code = req.user ? 403 : 401;
  res.status(code).json({ error: req.user ? 'insufficient permissions' : 'authentication required' });
  return false;
}

const requireBroadcast = (req, res) => requireRoles(req, res, ['user', 'admin']);
const requireAdmin = (req, res) => requireRoles(req, res, ['admin']);

module.exports = {
  GUEST_USERNAME,
  ROLES,
  authEnabled,
  guestEnabled,
  hashPassword,
  verifyPassword,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  countUsers,
  setPassword,
  setRole,
  deleteUser,
  getBroadcastPrefs,
  setBroadcastPrefs,
  ensureGuestUser,
  startSession,
  getSession,
  destroySession,
  deleteExpiredSessions,
  readSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  loginBlocked,
  noteLoginFailure,
  noteLoginSuccess,
  middleware,
  hasBroadcastAccess,
  isAdmin,
  requireBroadcast,
  requireAdmin,
};
