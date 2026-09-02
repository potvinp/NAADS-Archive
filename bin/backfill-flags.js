#!/usr/bin/env node
'use strict';

// Backfills the SOREM CAP <parameter> fields (LMD User Guide Appendix 3) for
// alerts stored before this parsing existed: the Broadcast Immediate /
// Wireless Immediate flags and the layer:SOREM:1.0:Broadcast_Text on-air
// script. This re-parses each candidate alert's already-stored raw XML -- no
// network access is needed, since the original CAP-CP document was kept in
// full in `alerts.raw_xml`.
//
// Unlike bin/backfill-resources.js, this always recomputes (rather than
// skipping alerts that already have a value) since NULL is ambiguous here
// between "never checked" and "checked, no such parameter" -- see
// backfillFlagsForAlert() in src/db for details. Safe to re-run regardless:
// recomputing from the same raw XML is idempotent.
//
// Usage:
//   node bin/backfill-flags.js
const { parseCapAlert } = require('../src/capParser');
const {
  getCandidateAlertsForFlagBackfill,
  countCandidateAlertsForFlagBackfill,
  backfillFlagsForAlert,
} = require('../src/db');

const BATCH_SIZE = 500;

async function run() {
  const total = await countCandidateAlertsForFlagBackfill();
  if (total === 0) {
    console.log('No alerts mention a Broadcast Immediate / Wireless Immediate parameter in their raw XML -- nothing to backfill.');
    return;
  }
  console.log(`Found ${total} alert(s) whose raw XML mentions a BI/WI parameter; recomputing flags...`);

  let offset = 0;
  let checked = 0;
  let alertsUpdated = 0;
  let flagsUpdated = 0;
  let failed = 0;

  for (;;) {
    const batch = await getCandidateAlertsForFlagBackfill(BATCH_SIZE, offset);
    if (!batch.length) break;

    for (const { id, raw_xml: rawXml } of batch) {
      checked++;
      const parsed = parseCapAlert(rawXml);
      if (!parsed) { failed++; continue; }
      try {
        const updated = await backfillFlagsForAlert(id, parsed.infos);
        if (updated > 0) {
          alertsUpdated++;
          flagsUpdated += updated;
        }
      } catch (err) {
        failed++;
        console.error(`[backfill-flags] alert ${id}: ${err.message}`);
      }
    }

    offset += batch.length;
    console.log(`  checked ${checked}/${total}...`);
  }

  console.log(
    `\nDone. Checked ${checked} alert(s), updated flags on ${alertsUpdated} alert(s) ` +
    `(${flagsUpdated} info block(s) changed), ${failed} failed.`
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
