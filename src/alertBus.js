'use strict';

const { EventEmitter } = require('events');

/**
 * Process-wide fan-out for alerts as they are received live.
 *
 * `src/realtime.js` emits `'alert'` (with the normalized payload from
 * db.getAlertForBroadcast) exactly once per newly-stored alert; `src/server.js`
 * subscribes and relays to connected `/api/stream` (SSE) clients. Kept as its
 * own module so a future continuous MPEG-TS / HLS muxer can subscribe to the
 * same stream without touching the listener or server wiring.
 *
 * Archive-poller alerts are intentionally NOT emitted here: the poller
 * re-scans whole days and would replay stale batches onto a "live" feed.
 */
const alertBus = new EventEmitter();

// A busy relay is fine; raise the ceiling so a handful of SSE clients plus a
// future muxer don't trip Node's default 10-listener leak warning.
alertBus.setMaxListeners(100);

module.exports = alertBus;
