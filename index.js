'use strict';

const { startRealtimeListeners } = require('./src/realtime');
const { startPolling } = require('./src/archivePoller');
const { startServer } = require('./src/server');
const auth = require('./src/auth');
const hlsStream = require('./src/hlsStream');

console.log('Starting NAADS Archive: real-time listeners, archive poller, and search server...');

let sessionSweep = null;

// Auth is entirely opt-in: with NAADS_AUTH unset the app is wide open, as
// before. When it's on, make sure the pieces the server relies on exist.
async function initAuth() {
  if (!auth.authEnabled()) {
    console.log('[auth] disabled (set NAADS_AUTH=1 to require sign-in)');
    return;
  }
  await auth.ensureGuestUser();
  const accounts = await auth.countUsers();
  if (accounts === 0) {
    if (process.env.NAADS_ADMIN_USER && process.env.NAADS_ADMIN_PASS) {
      await auth.createUser(process.env.NAADS_ADMIN_USER, process.env.NAADS_ADMIN_PASS, 'admin');
      console.log(`[auth] bootstrapped admin "${process.env.NAADS_ADMIN_USER}" from NAADS_ADMIN_USER/PASS`);
    } else {
      console.warn('[auth] enabled but no accounts exist — run `npm run user add <name>` (then `npm run user role <name> admin`)');
    }
  }
  console.log(`[auth] enabled · guest access ${auth.guestEnabled() ? 'on' : 'off'}`);

  // Reap expired session rows periodically.
  await auth.deleteExpiredSessions().catch(() => {});
  sessionSweep = setInterval(() => {
    auth.deleteExpiredSessions().catch((err) => console.error(`[auth] session sweep failed: ${err.message}`));
  }, 6 * 60 * 60 * 1000);
  sessionSweep.unref();
}

const stopRealtime = startRealtimeListeners();
const stopPolling = startPolling({ intervalMinutes: Number(process.env.ARCHIVE_POLL_MINUTES) || 15 });
const stopStream = hlsStream.start(); // no-op unless NAADS_STREAM is set
const httpServer = startServer(process.env.PORT || 3000);

initAuth().catch((err) => console.error(`[auth] init failed: ${err.message}`));

function shutdown() {
  console.log('\nShutting down...');
  stopRealtime();
  stopPolling();
  stopStream();
  if (sessionSweep) clearInterval(sessionSweep);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
