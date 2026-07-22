#!/usr/bin/env node
'use strict';

// Simple CLI search tool over the local alert database.
// Usage:
//   node bin/search.js "tornado warning"
//   node bin/search.js --event Tornado --severity Extreme --from 2024-01-01
//   node bin/search.js --broadcast-immediate --wireless-immediate
//   node bin/search.js --language fr
//
// Unlike the web UI, --language has no default here (omitting it searches
// all languages) to keep this consistent with every other filter flag.
const { searchAlerts } = require('../src/db');

// These are presence flags (no following value), unlike --event etc.
const BOOLEAN_FLAGS = {
  'broadcast-immediate': 'broadcastImmediate',
  'wireless-immediate': 'wirelessImmediate',
};

function parseArgs(argv) {
  const opts = { limit: 20 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS[key]) {
        opts[BOOLEAN_FLAGS[key]] = true;
      } else {
        opts[key] = argv[++i];
      }
    } else {
      rest.push(arg);
    }
  }
  if (rest.length) opts.q = rest.join(' ');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = await searchAlerts(opts);

  if (!results.length) {
    console.log('No matching alerts.');
    return;
  }

  for (const a of results) {
    const flags = [a.broadcast_immediate && 'BI', a.wireless_immediate && 'WI'].filter(Boolean);
    const flagTag = flags.length ? ` [${flags.join(',')}]` : '';
    console.log(`\n[${a.sent}] (${a.language || '?'}) ${a.event || '(no event)'} — ${a.severity}/${a.urgency}/${a.certainty}${flagTag}`);
    console.log(`  ${a.headline || ''}`);
    if (a.area_desc) console.log(`  Area: ${a.area_desc}`);
    console.log(`  id=${a.id} identifier=${a.identifier} sender=${a.sender}`);
  }
  console.log(`\n${results.length} result(s).`);
}

// Explicit exit matters when using the Postgres backend: an open
// connection pool keeps the event loop (and the process) alive otherwise.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
