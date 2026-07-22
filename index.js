'use strict';

const { startRealtimeListeners } = require('./src/realtime');
const { startPolling } = require('./src/archivePoller');
const { startServer } = require('./src/server');

console.log('Starting NAADS Archive: real-time listeners, archive poller, and search server...');

const stopRealtime = startRealtimeListeners();
const stopPolling = startPolling({ intervalMinutes: Number(process.env.ARCHIVE_POLL_MINUTES) || 15 });
const httpServer = startServer(process.env.PORT || 3000);

function shutdown() {
  console.log('\nShutting down...');
  stopRealtime();
  stopPolling();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
