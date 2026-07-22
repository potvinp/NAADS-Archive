#!/usr/bin/env node
'use strict';

// Backfills CAP <resource> attachments (e.g. broadcast audio, images) for
// alerts that were already stored before resource parsing existed. This
// re-parses each candidate alert's already-stored raw XML -- no network
// access is needed, since the original CAP-CP document (attachments and
// all) was kept in full in the `alerts.raw_xml` column from the start.
//
// Safe to re-run: an alert's info block is only touched if it doesn't
// already have resource rows recorded, so this only ever fills in gaps.
//
// Usage:
//   node bin/backfill-resources.js
const { parseCapAlert } = require('../src/capParser');
const {
  getCandidateAlertsForResourceBackfill,
  countCandidateAlertsForResourceBackfill,
  backfillResourcesForAlert,
} = require('../src/db');

const BATCH_SIZE = 500;

async function run() {
  const total = await countCandidateAlertsForResourceBackfill();
  if (total === 0) {
    console.log('No alerts mention <resource> in their raw XML -- nothing to backfill.');
    return;
  }
  console.log(`Found ${total} alert(s) whose raw XML mentions <resource>; checking for missing attachment rows...`);

  let offset = 0;
  let checked = 0;
  let alertsUpdated = 0;
  let resourcesInserted = 0;
  let failed = 0;

  for (;;) {
    const batch = await getCandidateAlertsForResourceBackfill(BATCH_SIZE, offset);
    if (!batch.length) break;

    for (const { id, raw_xml: rawXml } of batch) {
      checked++;
      const parsed = parseCapAlert(rawXml);
      if (!parsed) { failed++; continue; }
      try {
        const inserted = await backfillResourcesForAlert(id, parsed.infos);
        if (inserted > 0) {
          alertsUpdated++;
          resourcesInserted += inserted;
        }
      } catch (err) {
        failed++;
        console.error(`[backfill-resources] alert ${id}: ${err.message}`);
      }
    }

    offset += batch.length;
    console.log(`  checked ${checked}/${total}...`);
  }

  console.log(
    `\nDone. Checked ${checked} alert(s), added resources to ${alertsUpdated} alert(s) ` +
    `(${resourcesInserted} resource row(s) inserted), ${failed} failed.`
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
