#!/usr/bin/env node
'use strict';

// Backfill the local database from the NAADS alerts archive.
// Usage:
//   node bin/backfill.js 2024-01-01 2024-12-31
//   node bin/backfill.js 2024-01-01        (through today)
const { backfillRange } = require('../src/archivePoller');

const [startArg, endArg] = process.argv.slice(2);
if (!startArg) {
  console.error('Usage: node bin/backfill.js <start-date YYYY-MM-DD> [end-date YYYY-MM-DD]');
  process.exit(1);
}

const start = new Date(startArg + 'T00:00:00Z');
const end = endArg ? new Date(endArg + 'T00:00:00Z') : new Date();

if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
  console.error('Invalid date(s). Use YYYY-MM-DD format.');
  process.exit(1);
}

// Explicit exit matters when using the Postgres backend: an open
// connection pool keeps the event loop (and the process) alive otherwise.
backfillRange(start, end)
  .then(({ results, failedDates }) => {
    const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
    console.log(`\nBackfill complete: ${totalInserted} new alerts across ${results.length} day(s).`);
    if (failedDates.length) {
      console.log(`Dates with failed downloads (retries exhausted): ${failedDates.join(', ')}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
