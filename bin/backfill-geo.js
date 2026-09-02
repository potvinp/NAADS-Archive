#!/usr/bin/env node
'use strict';

// Backfills structured area geometry (CAP <polygon> / <circle>) into the
// alert_info.polygons / .circles columns for alerts stored before this
// parsing existed. Re-parses each candidate alert's already-stored raw XML
// -- no network access needed, since the original CAP-CP document was kept
// in full in `alerts.raw_xml`.
//
// Like bin/backfill-flags.js this always recomputes rather than skipping,
// since a NULL column is ambiguous between "never parsed" and "parsed, no
// geometry". Recomputing from the same raw XML is idempotent, so it's safe
// to stop and re-run.
//
// Usage:
//   node bin/backfill-geo.js
const { parseCapAlert } = require('../src/capParser');
const {
  getCandidateAlertsForGeoBackfill,
  countCandidateAlertsForGeoBackfill,
  backfillGeoForAlert,
} = require('../src/db');

const BATCH_SIZE = 500;

async function run() {
  const total = await countCandidateAlertsForGeoBackfill();
  if (total === 0) {
    console.log('No alerts mention a <polygon> or <circle> in their raw XML -- nothing to backfill.');
    return;
  }
  console.log(`Found ${total} alert(s) whose raw XML mentions area geometry; recomputing polygons/circles...`);

  let offset = 0;
  let checked = 0;
  let alertsUpdated = 0;
  let infosUpdated = 0;
  let failed = 0;

  for (;;) {
    const batch = await getCandidateAlertsForGeoBackfill(BATCH_SIZE, offset);
    if (!batch.length) break;

    for (const { id, raw_xml: rawXml } of batch) {
      checked++;
      const parsed = parseCapAlert(rawXml);
      if (!parsed) { failed++; continue; }
      try {
        const updated = await backfillGeoForAlert(id, parsed.infos);
        if (updated > 0) {
          alertsUpdated++;
          infosUpdated += updated;
        }
      } catch (err) {
        failed++;
        console.error(`[backfill-geo] alert ${id}: ${err.message}`);
      }
    }

    offset += batch.length;
    console.log(`  checked ${checked}/${total}...`);
  }

  console.log(
    `\nDone. Checked ${checked} alert(s), wrote geometry on ${alertsUpdated} alert(s) ` +
    `(${infosUpdated} info block(s) changed), ${failed} failed.`
  );
}

// Explicit exit matters when using the Postgres backend: an open
// connection pool keeps the event loop (and the process) alive otherwise.
run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
