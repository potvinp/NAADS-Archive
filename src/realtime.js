'use strict';

const { NaadStreamClient } = require('./realtimeClient');
const { insertAlert } = require('./db');
const { parseHeartbeatReferences } = require('./capParser');
const { recoverMissedAlerts } = require('./missedAlertRecovery');

// Both are live simultaneously under normal operation; the NAADS LMD User
// Guide recommends connecting to both for redundancy and discarding
// duplicates, which insertAlert() does via a (identifier, sender) UNIQUE
// constraint.
const ENDPOINTS = [
  { name: 'streaming1', host: 'streaming1.naad-adna.pelmorex.com' },
  { name: 'streaming2', host: 'streaming2.naad-adna.pelmorex.com' },
];

/**
 * Starts TCP listeners against both NAADS streaming feeds. Returns a stop()
 * function to close both connections.
 */
function startRealtimeListeners() {
  const clients = ENDPOINTS.map(({ name, host }) => new NaadStreamClient(name, host, 8080));

  for (const client of clients) {
    client.on('connected', () => console.log(`[realtime:${client.name}] connected to ${client.host}:${client.port}`));
    client.on('disconnected', () => console.log(`[realtime:${client.name}] disconnected, will retry`));
    client.on('error', (err) => console.error(`[realtime:${client.name}] ${err.message}`));

    client.on('alert', (parsed, rawXml) => {
      const receivedAt = new Date().toISOString();
      insertAlert(parsed, rawXml, `realtime-${client.name}`)
        .then((result) => {
          if (result.inserted) {
            console.log(`[realtime:${client.name}] new alert ${parsed.identifier} (${parsed.infos[0]?.event || 'unknown event'}) received at ${receivedAt}`);
          }
        })
        .catch((err) => console.error(`[realtime:${client.name}] failed to store alert ${parsed.identifier}: ${err.message}`));
    });

    client.on('heartbeat', (parsed) => {
      const refs = parseHeartbeatReferences(parsed.references);
      recoverMissedAlerts(refs, { source: `realtime-recovery-${client.name}` })
        .then((n) => {
          if (n > 0) console.log(`[realtime:${client.name}] recovered ${n} missed alert(s) via heartbeat`);
        })
        .catch((err) => console.error(`[realtime:${client.name}] recovery failed: ${err.message}`));
    });

    client.start();
  }

  return () => clients.forEach((c) => c.stop());
}

module.exports = { startRealtimeListeners };
