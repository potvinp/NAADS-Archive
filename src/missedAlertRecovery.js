'use strict';

const { parseCapAlert } = require('./capParser');
const { insertAlert, alertExists } = require('./db');

const USER_AGENT = 'naads-archive-bot/1.0 (+https://alerts.pelmorex.com/ NAADS archive client)';

// Primary (Oakville) and secondary (Montreal) short-term repository hosts.
// Alerts referenced by a heartbeat's <references> list are kept here for a
// few days, per the NAADS LMD User Guide, Appendix 1.
const REPO_HOSTS = ['capcp1.naad-adna.pelmorex.com', 'capcp2.naad-adna.pelmorex.com'];

function substitute(part) {
  return part.replace(/-/g, '_').replace(/\+/g, 'p').replace(/:/g, '_');
}

function buildRecoveryUrls({ sender, identifier, sent }) {
  const sentDate = encodeURIComponent(sent.slice(0, 10)); // YYYY-MM-DD
  const sentPart = encodeURIComponent(substitute(sent));
  const idPart = encodeURIComponent(substitute(identifier));
  return REPO_HOSTS.map((host) => `http://${host}/${sentDate}/${sentPart}I${idPart}.xml`);
}

async function fetchFromRepo(reference) {
  const urls = buildRecoveryUrls(reference);
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) return res.text();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No repo hosts available');
}

/**
 * Given a parsed heartbeat's list of recent-alert references, fetch and
 * store any that are missing from the database. This is how a listener
 * catches alerts it missed during a disconnect (per LMD User Guide p.24).
 */
async function recoverMissedAlerts(references, { source = 'realtime-recovery' } = {}) {
  let recovered = 0;
  for (const ref of references) {
    if (!ref.identifier || !ref.sender) continue;
    try {
      if (await alertExists(ref.identifier, ref.sender)) continue;
      const xml = await fetchFromRepo(ref);
      const parsed = parseCapAlert(xml);
      if (!parsed) continue;
      const result = await insertAlert(parsed, xml, source);
      if (result.inserted) recovered++;
    } catch (err) {
      console.error(`[recovery] failed to recover ${ref.identifier}: ${err.message}`);
    }
  }
  return recovered;
}

module.exports = { recoverMissedAlerts, buildRecoveryUrls };
