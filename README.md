# NAADS Archive

Builds and serves a searchable local database of Canadian public safety
alerts (CAP-CP format) from the Pelmorex **National Alert Aggregation &
Dissemination System (NAADS)**, by combining:

1. **Historical archive** — polls `https://alertsarchive.pelmorex.com/en.php`
   (the day-picker form on that page) and downloads every alert's raw CAP-CP
   XML file.
2. **Real-time feed** — maintains persistent TCP connections to both
   `streaming1.naad-adna.pelmorex.com:8080` (Oakville) and
   `streaming2.naad-adna.pelmorex.com:8080` (Montreal), per the [NAADS LMD
   User Guide](https://alerts.pelmorex.com/wp-content/uploads/2020/09/NAADS-LMD-User-Guide-R10.0.pdf).
   Connecting to both is the documented redundancy pattern; duplicates
   (identical `identifier`+`sender`) are discarded automatically.

Alerts are parsed and stored in a database — **SQLite** (`data/alerts.db`) by
default, or **PostgreSQL** if configured (see below) — with a full-text
search index over headline/description/instruction/area, plus columns for
event, severity, urgency, certainty, and timestamps so you can filter as well
as free-text search. The original raw XML for every alert is preserved.

## How the real-time feed works

- The feed is a raw, unframed TCP stream: CAP XML documents back-to-back,
  each delimited only by its own `<alert>...</alert>` tags (optionally
  preceded by an `<?xml ?>` declaration). There's no proprietary header.
- Pelmorex sends a CAP-formatted **heartbeat** once a minute
  (`<status>System</status>`, `<sender>NAADS-Heartbeat@...</sender>`) listing
  the last 10 alerts transmitted on that feed. This app uses that list to
  detect and backfill any alert it might have missed (fetched from the
  `capcp1`/`capcp2.naad-adna.pelmorex.com` short-term repository, which keeps
  alerts for a few days).
- If no heartbeat arrives for 3 minutes, the client assumes the connection is
  dead and reconnects with exponential backoff.

## Setup

```bash
npm install
```

## Storage backend: SQLite or PostgreSQL

By default the app uses a bundled SQLite file at `data/alerts.db` — zero
configuration needed. To use PostgreSQL instead, set `DATABASE_URL` (or the
individual `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGPORT` variables
that the `pg` driver reads natively), either in your shell or in a `.env`
file in the project root (loaded automatically):

```bash
# .env
DATABASE_URL=postgresql://user:password@localhost:5432/naads
```

The backend is auto-detected: Postgres is used whenever `DATABASE_URL` (or
`PGHOST`/`PGDATABASE`) is set. To force one explicitly regardless of what
else is set, use `DB_CLIENT=sqlite` or `DB_CLIENT=postgres`.

Both backends implement the exact same set of operations and are kept behind
one interface (`src/db/index.js` picks between `src/db/sqlite.js` and
`src/db/postgres.js`), so every feature — search, pagination, resource
playback, backfilling — works identically either way. Schema/tables are
created automatically on first use in both cases, and any columns added by
a later update to this app are also added automatically to an existing
database the next time it starts (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
on Postgres; an equivalent check-and-add for SQLite, which has no such
clause) — nothing to migrate by hand. The Postgres schema uses a generated
`tsvector` column for full-text search, which requires **PostgreSQL 12+**.

Note the two backends aren't interchangeable *storage* — switching
`DATABASE_URL` on and off points at two separate, independently-populated
databases. There's no built-in migration between them; if you start on
SQLite and later move to Postgres, you'd re-run the backfill scripts against
the new database.

## Running

```bash
npm start
```

This starts, concurrently:
- both real-time TCP listeners,
- an archive poller that re-checks today's (and yesterday's) archive listing
  every 15 minutes (`ARCHIVE_POLL_MINUTES` env var to change),
- a search UI + JSON API at `http://localhost:3000` (`PORT` env var to change).

## Running with Docker

```bash
docker compose up --build
```

This builds the image and starts the app on `http://localhost:3000`, using
the bundled SQLite backend persisted to `./data` on the host (bind-mounted
into the container). Backfill/search CLI scripts can be run against the
same running stack:

```bash
docker compose run --rm app node bin/backfill.js 2011-01-01 2026-07-19
docker compose run --rm app node bin/search.js "storm surge"
```

To use PostgreSQL instead, uncomment the `postgres` service's `DATABASE_URL`
and `depends_on` lines in `docker-compose.yml`, then start both services:

```bash
docker compose --profile postgres up --build
```

Without Compose, the image can be built and run directly:

```bash
docker build -t naads-archive .
docker run -p 3000:3000 -v "$(pwd)/data:/app/data" naads-archive
```

## Backfilling history

The archive goes back to 2011. To pull a date range in one shot:

```bash
node bin/backfill.js 2011-01-01 2026-07-19
```

This can take a long time (each day can have hundreds of alerts, each
fetched as a separate HTTP request with a small delay between requests to
be polite to Pelmorex's server) — safe to stop and re-run; already-stored
alerts are skipped.

## Backfilling attachments (audio/images) onto existing alerts

Attachments (`<resource>` blocks — e.g. broadcast audio, images) are parsed
and stored automatically for any alert fetched from now on. If you have
alerts in the database from before this was added, run:

```bash
node bin/backfill-resources.js
```

This re-parses each candidate alert's already-stored raw XML — no network
access needed, since the full original CAP-CP document was always kept in
`alerts.raw_xml`. It's a quick, cheap-prefiltered scan (only alerts whose raw
XML mentions `<resource>` are re-parsed) and safe to re-run: an alert is only
touched if it doesn't already have resource rows recorded.

## Searching

**Web UI**: open `http://localhost:3000` — free-text search plus filters for
event, severity, urgency, date range, language, and the Broadcast Immediate /
Wireless Immediate flags (see below), with pagination through results. Click
"raw CAP-CP XML" on any result to see the original message. Any attached
audio (embedded or linked) plays inline via an audio player; other
attachment types (images, etc.) show as a plain link.

**CLI**:
```bash
node bin/search.js "storm surge"
node bin/search.js --event Tornado --severity Extreme --from 2024-01-01
node bin/search.js --broadcast-immediate --wireless-immediate
node bin/search.js --language fr
```

### Language

NAADS alerts are commonly issued with a separate CAP `<info>` block per
language (e.g. one `en-CA` block and one `fr-CA` block in the same message,
each with its own headline/description). The `language` selector in the web
UI (and `--language`/`?language=` elsewhere) picks which language's block to
show; matching is by prefix, so `en`/`fr` cover any region suffix.

The web UI defaults this to **English** — as opposed to every other filter,
which defaults to "no filter" — since showing every language block for
every alert side by side is confusing more than useful for browsing. Select
"All languages" to go back to seeing every block. The CLI and `/api/search`
have no default (omit `--language`/`language=` to search every language),
so scripts calling either aren't silently filtered.

### Broadcast Immediate / Wireless Immediate flags

Per the LMD User Guide Appendix 3, an alert's `<info>` block can carry CAP
`<parameter>` entries flagging it for mandatory/intrusive distribution:
`layer:SOREM:1.0:Broadcast_Immediately` (radio/TV) and
`layer:SOREM:2.0:WirelessImmediate` (wireless public alert messages) —
trusted-feed sources like Environment Canada instead use
`layer:EC-MSC-SMC:1.0:Broadcast_Intrusive` for the broadcast flag, which is
matched too. Both are parsed into `broadcast_immediate`/`wireless_immediate`
columns (`true`/`false`/`NULL` — `NULL` when the alert has neither
parameter at all, distinct from an explicit "No"), filterable via the two
checkboxes in the web UI, the `broadcastImmediate`/`wirelessImmediate` query
params on `/api/search`, or `--broadcast-immediate`/`--wireless-immediate`
on the CLI. Matching results show `BI`/`WI` badges (web UI) or an
`[BI,WI]` tag (CLI).

Alerts already in the database from before this was added will show `NULL`
for both flags until reprocessed:

```bash
node bin/backfill-flags.js
```

Same no-network, re-parse-the-stored-raw-XML approach as
`bin/backfill-resources.js`, but where that script skips info blocks that
already have resource rows, this one always recomputes and overwrites: a
`NULL` flag is ambiguous between "never checked" and "checked, no such
parameter", so there's no reliable signal to skip on. Recomputing from the
same raw XML is idempotent, so it's still safe to stop and re-run.

**Directly via SQL**: the `alerts` table holds one row per unique alert (raw
XML included), `alert_info` holds one row per CAP `<info>` block (an alert
may have several, e.g. one per language), and `alert_resource` holds
attachments. Full-text search runs over an FTS5 virtual table
(`alert_info_fts`) on SQLite, or a generated `search_vector` column (GIN
index) on `alert_info` for Postgres.

Since search results are built by joining through `alert_info`, `/api/stats`'
"alerts indexed" (a straight count of the `alerts` table) and `/api/search`'s
"total"/"alerts found" (`COUNT(DISTINCT alerts.id)` over the filtered join)
are both counts of distinct alerts and should always agree when no filter
narrows things down — if you ever see them differ, that's a bug, not
expected behavior from multi-language alerts (which the `language` filter
above is the intended way to disambiguate, not something that should show
up as a mismatched count).

## Notes

- This app only reads public NAADS alert feeds; it does not verify the CAP
  digital signatures described in the LMD User Guide's Appendix 4 (signature
  verification requires a SOAP call to Pelmorex's DSS service). All alerts
  are stored with their signatures intact in `raw_xml` for anyone who wants
  to verify them independently.
- The archive site's day-listing endpoint isn't a documented public API —
  it's the same form POST the archive's own web page uses — so it could
  change without notice.
