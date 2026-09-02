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
- a search UI + JSON API at `http://localhost:3000` (`PORT` env var to change),
- a live **broadcast monitor** at `http://localhost:3000/broadcast` (see
  [Live broadcast feed](#live-broadcast-feed)).

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

## Backfilling area geometry onto existing alerts

The broadcast feed's location filter matches against each alert's CAP
`<polygon>` / `<circle>` geometry, parsed into `alert_info.polygons` /
`alert_info.circles` automatically for any alert fetched from now on. For
alerts stored before this existed:

```bash
npm run backfill-geo        # node bin/backfill-geo.js
```

Same no-network, re-parse-the-stored-raw-XML approach as
`backfill-resources`; like `backfill-flags` it always recomputes (a `NULL`
column is ambiguous between "never parsed" and "no geometry"), so it's
idempotent and safe to stop and re-run.

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

The same `<parameter>` list also carries `layer:SOREM:1.0:Broadcast_Text` —
the exact script NAADS feeds to its text-to-speech engine to produce the
broadcast audio. It's parsed into the `broadcast_text` column and shown
verbatim on the [broadcast feed](#live-broadcast-feed)'s emergency card
(the public `<description>` often differs).

Alerts already in the database from before this was added will show `NULL`
for the flags and `broadcast_text` until reprocessed:

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

## Live broadcast feed

Open `http://localhost:3000/broadcast` for a live monitor that plays alerts
as the real-time listeners receive them — the OpenBroadcaster
"emergency alert automation" idea: for a **broadcast-immediate** alert it
plays a fixed sequence, then shows the alert text with any image/video
attachment:

```
Pre-Tone.wav  →  Tone-v2.mp3 (Alert Ready signal)  →  the alert's broadcast
audio <resource> (TTS)  →  Post-Message.wav
```

Non-broadcast-immediate alerts that pass the filter just play their audio
(if any) and show the text. Browsers block autoplay until a gesture, so the
page has an **Arm & go on air** button the operator clicks once. **Send test
alert** replays a stored alert (`NAADS_TEST_ALERT_ID`, default `815048`) as
a `Test`-status message through the monitor and every HLS stream, bypassing
all filters — an end-to-end check of the audio sequence and cards.

While an alert is on air it fills the panel as a full-bleed card styled
after the CAP visual alert shown on Canadian TV — the message in large
centred type with an auto-advancing `1 / N` page counter. It's **red** and
headed **EMERGENCY ALERT** only when Broadcast Immediate or Wireless
Immediate is set; **amber** (headed with the event) for other alerts;
**grey** (headed **TEST ALERT**) for `status = Test`. The card shows
`layer:SOREM:1.0:Broadcast_Text` (the script the on-air TTS reads) when
present, otherwise the public `<description>`; the audio player and any
image sit below it. Re-issued / cancelled weather warnings (headline
"… changed" or "… ended") are dropped from the feed and the stream
entirely, and a **Play test alerts** filter toggle (on by default) excludes
test messages from auto-play and personal streams.

**Audio files.** The three fixed clips are bundled in `audio/`
(`Tone-v2.mp3`, `Pre-Tone.wav`, `Post-Message.wav`). Override any of them
with `NAADS_ALERT_TONE`, `NAADS_PRE_TONE`, `NAADS_POST_MESSAGE` (point at a
missing file to skip that step). `NAADS_BROADCAST_LANG` (default `en`) picks
which CAP `<info>` language block the feed uses.

**Location filter.** A panel on the page limits which alerts *auto-play*
(everything still lands in the on-page feed with a manual "Play now"):

- **Scope** — all alerts / Broadcast-Immediate only / BI + Wireless-Immediate.
- **Provinces / territories** — matched against the leading digits of each
  alert's CAP SGC geocodes.
- **Custom SGC prefixes** — comma-separated, matched the same way.
- **Point + radius** — auto-play if the alert's `<polygon>`/`<circle>`
  geometry contains, or comes within the radius of, a lat/long you set
  (or "Use my location"). Run [`npm run backfill-geo`](#backfilling-area-geometry-onto-existing-alerts)
  once so older alerts have geometry to match.

With no province, prefix, or point set, everything in scope auto-plays. When
criteria *are* set, an alert auto-plays if it matches a prefix **or** the
point. Preferences are saved per user server-side when auth is on, otherwise
in the browser's `localStorage`.

**API.** `GET /api/stream` is a Server-Sent Events feed — one `alert` event
per newly-received alert (JSON: identifier, headline/description/instruction,
`broadcastText`, severity, `broadcastImmediate`/`wirelessImmediate`,
`geocodes`, `polygons`, `circles`, and `resources` with `/api/resource/:id`
ids). Optional coarse
query filters: `broadcastImmediate`, `wirelessImmediate`, `event`,
`severity`. Only the real-time listeners feed this; the archive poller does
not (it would replay stale day-batches).

### Continuous HLS alert channel

Set **`NAADS_STREAM=1`** (needs `ffmpeg` + `ffprobe` on `PATH`) for a 24/7
audio+video program a station automation system, VLC, OBS or a browser can
pull:

- `GET /hls/live.m3u8` (+ `s<n>.ts` segments) — a sliding-window live
  playlist. Between alerts it loops a **slate** (a "no active alert" card +
  silence); when an alert arrives on the [alertBus](src/alertBus.js) it
  splices in `Pre-Tone → Alert Ready tone → the alert's TTS audio →
  Post-Message` over the alert card showing the SOREM `Broadcast_Text`
  (red **EMERGENCY ALERT** for Broadcast/Wireless Immediate, amber for other
  alerts, grey for tests), then returns to the slate. Pre-Tone / tone /
  Post-Message wrap **emergency alerts only**; other alerts just play their
  own TTS under the card. There's no single long-lived encoder — but every
  segment (slate and alert) is stream-copied onto one **continuous PTS
  timeline** at publish time, so the playlist carries no
  `#EXT-X-DISCONTINUITY` and hls.js never flushes its buffer at a
  slate↔alert seam (which was clipping the intro tone and the end message).
  Slate segments are paced a few (`NAADS_STREAM_LOOKAHEAD_SEGMENTS`) ahead of
  real time; the moment an alert is ready its whole pre-rendered block is
  published at once, so the entire alert lands in the player's buffer and
  can't stall mid-alert.
- `GET /stream` — a browser player page (hls.js) for humans.

Implementation is [`src/hlsStream.js`](src/hlsStream.js): each ~6s piece is
its own `ffmpeg`-built MPEG-TS segment; the alert card is drawn with
`drawtext` over a solid colour (no headless browser, no extra npm deps),
word-wrapped in Node. The slate and each alert's rendered block are built
once and shared across channels.

**Personal streams.** The **Personal stream** panel on `/broadcast` mints an
**unguessable capability URL** — `/hls/s/<random>/live.m3u8` (and a `/s/<random>`
player page) that needs **no login** and airs *only* the alerts matching a
filter. When signed in, "Create stream link" binds the key to your account
so it follows the location/scope filter you set on the monitor (re-read
every ~20s); signed out, it snapshots the current filter onto the key.
Anyone with the link can watch — revoke it to invalidate; the panel keeps
the secret part of the URL masked until you click **Show link** (Copy still
copies the real one). Keys and their filters live in the `stream_keys`
table, so they **survive a restart** — only the video segments are
transient; a channel that was in use is re-created automatically on startup,
otherwise on the next request. Keyed channels are reaped after
`NAADS_STREAM_IDLE_MINUTES` (10) of no requests; `NAADS_STREAM_MAX_CHANNELS`
(24) caps concurrent ones. API: `POST`/`GET`/`DELETE /api/stream-keys` (own
keys; admins see all).

**Config** (all optional): `NAADS_STREAM_SIZE` (`1280x720`),
`NAADS_STREAM_FPS` (`15`), `NAADS_STREAM_SEGMENT_SECONDS` (`6`),
`NAADS_STREAM_WINDOW` (`24`), `NAADS_STREAM_LOOKAHEAD_SEGMENTS` (`3`),
`NAADS_STREAM_MIN_ALERT_SECONDS` (`20`),
`NAADS_STREAM_BI_ONLY=1` (default channel airs broadcast-immediate only),
`NAADS_STREAM_IDLE_MINUTES`, `NAADS_STREAM_MAX_CHANNELS`,
`NAADS_STREAM_FONT` / `NAADS_STREAM_FONT_MONO` (auto-detected on most
Linux), `NAADS_STREAM_DIR` (transient working dir, default a subdir of the
OS temp dir — override only if `/tmp` is too small or `noexec`).

**Auth.** The per-key URLs are the credential and never require a session.
The **default** channel (`/hls/live.m3u8`, airs everything) does: HLS
players can't send the session cookie, so when auth is on set
**`NAADS_STREAM_TOKEN`** and pass `?token=…`, or use a logged-in
`user`/`admin` browser session. The `/stream` page requires a session when
auth is on; `/s/<key>` does not.

**Still rough:** the on-air card is static per alert (the browser
[monitor](#live-broadcast-feed) keeps full `1/N` pagination); there's no
raw always-on `/stream.ts` endpoint (HLS only); and long messages are
truncated to fit one card. `/api/resource/:id` still streams embedded bytes
without HTTP `Range` (fine for `ffmpeg`; would break `<video>` scrubbing of
an embedded video, which NAADS alerts don't currently carry).

## Authentication (optional, multi-user)

Auth is **fully opt-in**. With `NAADS_AUTH` unset the app is open exactly as
before. Set `NAADS_AUTH=1` and every route requires a session; three roles:

| role  | search UI & API | broadcast feed | user management |
|-------|:---:|:---:|:---:|
| guest | ✔ | — | — |
| user  | ✔ | ✔ (own saved filter) | — |
| admin | ✔ | ✔ | ✔ |

**guest** is a no-credentials "Continue as guest" button on the login page
(on by default when auth is enabled; `NAADS_GUEST=0` to remove it).

**Create the first account** (works whether or not auth is on, so you can't
lock yourself out):

```bash
npm run user add alice --admin       # prompts for a password (or set NAADS_NEW_PASSWORD)
npm run user list
npm run user role alice user
npm run user passwd alice
npm run user rm alice
```

For headless/Docker startup, set `NAADS_ADMIN_USER` / `NAADS_ADMIN_PASS` and
an admin is created on first boot if no accounts exist. Admins can also
manage users at `/admin`.

Sessions are a DB-backed cookie (`HttpOnly`, `SameSite=Lax`; add `Secure`
with `NAADS_AUTH_SECURE=1` when serving over HTTPS), lifetime
`NAADS_SESSION_TTL_HOURS` (default 720). The `users` / `sessions` tables are
created automatically like the rest of the schema. `/healthz` is
unauthenticated so container health checks keep working.

## Notes

- This app only reads public NAADS alert feeds; it does not verify the CAP
  digital signatures described in the LMD User Guide's Appendix 4 (signature
  verification requires a SOAP call to Pelmorex's DSS service). All alerts
  are stored with their signatures intact in `raw_xml` for anyone who wants
  to verify them independently.
- The archive site's day-listing endpoint isn't a documented public API —
  it's the same form POST the archive's own web page uses — so it could
  change without notice.
