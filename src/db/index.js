'use strict';

// Loaded here (rather than per-entrypoint) so every script that requires
// ./db -- the long-running server, the CLI tools, the backfill jobs --
// picks up a local .env file with zero extra wiring.
require('dotenv').config();

// Postgres is used when explicitly requested (DB_CLIENT=postgres) or when
// connection info is present (DATABASE_URL, or the PG* vars the `pg`
// package itself understands); otherwise this falls back to the bundled
// SQLite file, so a fresh checkout works with zero configuration.
const wantsPostgres =
  process.env.DB_CLIENT === 'postgres' ||
  (!process.env.DB_CLIENT && !!(process.env.DATABASE_URL || process.env.PGHOST || process.env.PGDATABASE));

const backend = wantsPostgres ? './postgres' : './sqlite';
console.log(`[db] using ${wantsPostgres ? 'PostgreSQL' : 'SQLite'} backend`);

module.exports = require(backend);
