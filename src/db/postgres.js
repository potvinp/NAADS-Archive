'use strict';

const { Pool } = require('pg');

// pg reads PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT itself when no config
// is passed, so DATABASE_URL is just the common-case override.
const pool = new Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined
);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS alerts (
  id             SERIAL PRIMARY KEY,
  identifier     TEXT NOT NULL,
  sender         TEXT NOT NULL,
  sent           TEXT NOT NULL,
  status         TEXT,
  msg_type       TEXT,
  scope          TEXT,
  source         TEXT,
  code           TEXT,
  note           TEXT,
  references_raw TEXT,
  is_heartbeat   BOOLEAN NOT NULL DEFAULT FALSE,
  raw_xml        TEXT NOT NULL,
  fetched_from   TEXT NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (identifier, sender)
);

CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent);
CREATE INDEX IF NOT EXISTS idx_alerts_identifier ON alerts(identifier);

CREATE TABLE IF NOT EXISTS alert_info (
  id            SERIAL PRIMARY KEY,
  alert_id      INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  language      TEXT,
  category      TEXT,
  event         TEXT,
  response_type TEXT,
  urgency       TEXT,
  severity      TEXT,
  certainty     TEXT,
  effective     TEXT,
  onset         TEXT,
  expires       TEXT,
  sender_name   TEXT,
  headline      TEXT,
  description   TEXT,
  instruction   TEXT,
  web           TEXT,
  area_desc     TEXT,
  geocodes      TEXT,
  broadcast_immediate BOOLEAN,
  wireless_immediate  BOOLEAN,
  polygons      TEXT,
  circles       TEXT,
  broadcast_text TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(headline, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(event, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(instruction, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(area_desc, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(sender_name, '')), 'C')
  ) STORED
);

-- ADD COLUMN IF NOT EXISTS is a no-op on a fresh CREATE TABLE above and a
-- real migration on a database created before a given column existed --
-- CREATE TABLE IF NOT EXISTS alone does NOT retrofit new columns onto an
-- already-existing table, so newly-added columns belong here, not just in
-- the CREATE TABLE block, or existing databases would break on the indexes
-- below that reference them.
ALTER TABLE alert_info ADD COLUMN IF NOT EXISTS broadcast_immediate BOOLEAN;
ALTER TABLE alert_info ADD COLUMN IF NOT EXISTS wireless_immediate BOOLEAN;
-- Structured area geometry (JSON text): polygons [[[lat,lon],...],...],
-- circles [{lat,lon,radiusKm},...]. Used by the live broadcast feed's
-- location filter; the flattened area_desc/geocodes columns are kept for
-- search.
ALTER TABLE alert_info ADD COLUMN IF NOT EXISTS polygons TEXT;
ALTER TABLE alert_info ADD COLUMN IF NOT EXISTS circles TEXT;
-- "layer:SOREM:1.0:Broadcast_Text": the exact script NAADS TTS reads on air.
ALTER TABLE alert_info ADD COLUMN IF NOT EXISTS broadcast_text TEXT;

CREATE INDEX IF NOT EXISTS idx_info_alert_id ON alert_info(alert_id);
CREATE INDEX IF NOT EXISTS idx_info_event ON alert_info(event);
CREATE INDEX IF NOT EXISTS idx_info_severity ON alert_info(severity);
CREATE INDEX IF NOT EXISTS idx_info_urgency ON alert_info(urgency);
CREATE INDEX IF NOT EXISTS idx_info_broadcast_immediate ON alert_info(broadcast_immediate);
CREATE INDEX IF NOT EXISTS idx_info_wireless_immediate ON alert_info(wireless_immediate);
CREATE INDEX IF NOT EXISTS idx_info_search_vector ON alert_info USING GIN(search_vector);

-- CAP <resource> blocks (audio/image/etc attachments), embedded as base64
-- ("derefUri") and/or linked by external URL ("uri"), per info block.
CREATE TABLE IF NOT EXISTS alert_resource (
  id            SERIAL PRIMARY KEY,
  info_id       INTEGER NOT NULL REFERENCES alert_info(id) ON DELETE CASCADE,
  resource_desc TEXT,
  mime_type     TEXT,
  size          INTEGER,
  uri           TEXT,
  data          BYTEA,
  digest        TEXT
);

CREATE INDEX IF NOT EXISTS idx_resource_info_id ON alert_resource(info_id);

CREATE TABLE IF NOT EXISTS poll_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Optional auth (only consulted when NAADS_AUTH is set; see src/auth.js).
-- The reserved username 'guest' backs no-credential guest sessions and has
-- an empty pass_hash (unusable for password login).
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  pass_hash       TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user',
  broadcast_prefs TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Capability URLs for a personal HLS stream: whoever holds the key can pull
-- /hls/s/<key>/live.m3u8 with no login.
CREATE TABLE IF NOT EXISTS stream_keys (
  key          TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  filter       TEXT,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stream_keys_user_id ON stream_keys(user_id);
`;

// Schema setup runs once per process, lazily on first query, and is cached
// so every exported function can safely await it without re-running DDL.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(SCHEMA_SQL).catch((err) => {
      schemaReady = null; // allow a retry on the next call if setup failed
      throw err;
    });
  }
  return schemaReady;
}

// Serialize parsed polygon/circle arrays for storage; null (not "[]") when
// the info block carries no geometry, so a NULL column is unambiguous.
function geomJson(value) {
  return value && value.length ? JSON.stringify(value) : null;
}

function parseGeom(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Inserts an info block's resources (see capParser.parseResources) under
 * the given alert_info id, using the given client (so it participates in
 * the caller's transaction). Mirrors sqlite.js's insertResources.
 */
async function insertResources(client, infoId, resources) {
  let inserted = 0;
  for (const resource of resources || []) {
    await client.query(
      `INSERT INTO alert_resource (info_id, resource_desc, mime_type, size, uri, data, digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        infoId,
        resource.resourceDesc || null,
        resource.mimeType || null,
        resource.size || null,
        resource.uri || null,
        resource.derefUri ? Buffer.from(resource.derefUri, 'base64') : null,
        resource.digest || null,
      ]
    );
    inserted++;
  }
  return inserted;
}

async function findExistingAlertId(client, identifier, sender) {
  const res = await client.query('SELECT id FROM alerts WHERE identifier = $1 AND sender = $2', [identifier, sender]);
  return res.rows[0]?.id ?? null;
}

/**
 * Insert a parsed CAP alert (see capParser.js) if not already present.
 * Returns { inserted: boolean, id: number|null }
 */
async function insertAlert(parsedAlert, rawXml, fetchedFrom) {
  await ensureSchema();
  const existingId = await findExistingAlertId(pool, parsedAlert.identifier, parsedAlert.sender);
  if (existingId) return { inserted: false, id: existingId };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const alertRes = await client.query(
      `INSERT INTO alerts (identifier, sender, sent, status, msg_type, scope, source, code, note, references_raw, is_heartbeat, raw_xml, fetched_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (identifier, sender) DO NOTHING
       RETURNING id`,
      [
        parsedAlert.identifier,
        parsedAlert.sender,
        parsedAlert.sent,
        parsedAlert.status || null,
        parsedAlert.msgType || null,
        parsedAlert.scope || null,
        parsedAlert.source || null,
        parsedAlert.code || null,
        parsedAlert.note || null,
        parsedAlert.references || null,
        !!parsedAlert.isHeartbeat,
        rawXml,
        fetchedFrom,
      ]
    );

    if (alertRes.rows.length === 0) {
      await client.query('ROLLBACK');
      const id = await findExistingAlertId(pool, parsedAlert.identifier, parsedAlert.sender);
      return { inserted: false, id };
    }

    const alertId = alertRes.rows[0].id;
    for (const infoBlock of parsedAlert.infos) {
      const infoRes = await client.query(
        `INSERT INTO alert_info (alert_id, language, category, event, response_type, urgency, severity, certainty,
           effective, onset, expires, sender_name, headline, description, instruction, web, area_desc, geocodes,
           broadcast_immediate, wireless_immediate, polygons, circles, broadcast_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING id`,
        [
          alertId,
          infoBlock.language || null,
          infoBlock.category || null,
          infoBlock.event || null,
          infoBlock.responseType || null,
          infoBlock.urgency || null,
          infoBlock.severity || null,
          infoBlock.certainty || null,
          infoBlock.effective || null,
          infoBlock.onset || null,
          infoBlock.expires || null,
          infoBlock.senderName || null,
          infoBlock.headline || null,
          infoBlock.description || null,
          infoBlock.instruction || null,
          infoBlock.web || null,
          infoBlock.areaDesc || null,
          infoBlock.geocodes || null,
          infoBlock.broadcastImmediate ?? null,
          infoBlock.wirelessImmediate ?? null,
          geomJson(infoBlock.polygons),
          geomJson(infoBlock.circles),
          infoBlock.broadcastText || null,
        ]
      );
      await insertResources(client, infoRes.rows[0].id, infoBlock.resources);
    }

    await client.query('COMMIT');
    return { inserted: true, id: alertId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function alertExists(identifier, sender) {
  await ensureSchema();
  return !!(await findExistingAlertId(pool, identifier, sender));
}

async function getPollState(key) {
  await ensureSchema();
  const res = await pool.query('SELECT value FROM poll_state WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

async function setPollState(key, value) {
  await ensureSchema();
  await pool.query(
    `INSERT INTO poll_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

/**
 * Builds the shared FROM/WHERE/values for a filtered alert search, used by
 * both searchAlerts() (a page of rows) and countAlerts() (total match count)
 * so pagination can report how many pages exist.
 */
function buildSearchQuery({ q, event, severity, urgency, status, from, to, language, broadcastImmediate, wirelessImmediate } = {}) {
  const clauses = [];
  const values = [];
  let fromClause = 'alert_info i JOIN alerts a ON a.id = i.alert_id';

  if (q && q.trim()) {
    values.push(q);
    clauses.push(`i.search_vector @@ websearch_to_tsquery('english', $${values.length})`);
  }
  if (event) { values.push(`%${event}%`); clauses.push(`i.event ILIKE $${values.length}`); }
  if (severity) { values.push(severity); clauses.push(`i.severity = $${values.length}`); }
  if (urgency) { values.push(urgency); clauses.push(`i.urgency = $${values.length}`); }
  if (status) { values.push(status); clauses.push(`a.status = $${values.length}`); }
  if (from) { values.push(from); clauses.push(`a.sent::timestamptz >= $${values.length}::timestamptz`); }
  if (to) { values.push(to); clauses.push(`a.sent::timestamptz <= $${values.length}::timestamptz`); }
  // Alert language codes are like "en-CA"/"fr-CA" (plus rare third-language
  // codes) -- match by prefix so a plain "en"/"fr" selector works regardless
  // of region suffix.
  if (language) { values.push(`${language}%`); clauses.push(`i.language ILIKE $${values.length}`); }
  if (broadcastImmediate) clauses.push('i.broadcast_immediate = TRUE');
  if (wirelessImmediate) clauses.push('i.wireless_immediate = TRUE');
  clauses.push('a.is_heartbeat = FALSE');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { fromClause, where, values };
}

/**
 * Full text + filtered search over alert_info joined with alerts.
 */
async function searchAlerts({ limit = 50, offset = 0, ...filters } = {}) {
  await ensureSchema();
  const { fromClause, where, values } = buildSearchQuery(filters);
  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const sql = `
    SELECT a.id, a.identifier, a.sender, a.sent, a.status, a.msg_type, a.scope, a.source, a.fetched_from,
           i.id AS info_id, i.language, i.category, i.event, i.urgency, i.severity, i.certainty,
           i.effective, i.expires, i.headline, i.description, i.instruction, i.area_desc,
           i.broadcast_immediate, i.wireless_immediate
    FROM ${fromClause}
    ${where}
    ORDER BY a.sent::timestamptz DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;
  const rows = (await pool.query(sql, [...values, limit, offset])).rows;

  const resourcesByInfoId = await getResourcesByInfoIds(rows.map((r) => r.info_id));
  for (const row of rows) row.resources = resourcesByInfoId[row.info_id] || [];
  return rows;
}

/**
 * Fetches lightweight resource metadata (no blob bytes) for a set of
 * alert_info ids, grouped by info_id, for attaching to search results.
 */
async function getResourcesByInfoIds(infoIds) {
  const uniqueIds = [...new Set(infoIds)];
  if (!uniqueIds.length) return {};
  const rows = (await pool.query(
    `SELECT id, info_id, resource_desc, mime_type, size, uri, digest, (data IS NOT NULL) AS has_data
     FROM alert_resource
     WHERE info_id = ANY($1::int[])`,
    [uniqueIds]
  )).rows;

  const grouped = {};
  for (const row of rows) {
    (grouped[row.info_id] ||= []).push({
      id: row.id,
      resourceDesc: row.resource_desc,
      mimeType: row.mime_type,
      size: row.size,
      uri: row.uri,
      digest: row.digest,
      hasEmbeddedData: !!row.has_data,
    });
  }
  return grouped;
}

/**
 * Fetches a single resource's bytes/link for serving via /api/resource/:id.
 */
async function getResourceById(id) {
  await ensureSchema();
  const res = await pool.query('SELECT mime_type, uri, data FROM alert_resource WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// --- Resource backfill (for alerts stored before <resource> parsing existed) ---

/**
 * A page of alerts whose raw XML mentions a <resource> tag -- a cheap
 * pre-filter so the resource backfill script doesn't have to XML-parse
 * every alert in the database, just the small fraction with attachments.
 */
async function getCandidateAlertsForResourceBackfill(limit, offset) {
  await ensureSchema();
  const res = await pool.query(
    `SELECT id, raw_xml FROM alerts WHERE raw_xml LIKE '%<resource%' ORDER BY id ASC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

async function countCandidateAlertsForResourceBackfill() {
  await ensureSchema();
  const res = await pool.query(`SELECT COUNT(*)::int c FROM alerts WHERE raw_xml LIKE '%<resource%'`);
  return res.rows[0].c;
}

/**
 * Re-parses an already-stored alert's raw XML (via capParser.parseCapAlert)
 * and inserts any <resource> attachments not yet recorded for its info
 * blocks. Matches parsed info blocks to stored alert_info rows by position,
 * since both are built by iterating the document's <info> elements in
 * order. Safe to call repeatedly: info blocks that already have resource
 * rows are left untouched, so a re-run only fills in gaps.
 * Returns the number of resource rows inserted.
 */
async function backfillResourcesForAlert(alertId, parsedInfos) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    const infoRows = (await client.query(
      'SELECT id FROM alert_info WHERE alert_id = $1 ORDER BY id ASC',
      [alertId]
    )).rows;

    if (infoRows.length !== parsedInfos.length) {
      throw new Error(
        `info block count mismatch (stored ${infoRows.length}, parsed ${parsedInfos.length})`
      );
    }

    await client.query('BEGIN');
    let inserted = 0;
    for (let i = 0; i < infoRows.length; i++) {
      const resources = parsedInfos[i].resources || [];
      if (!resources.length) continue;
      const existing = await client.query('SELECT COUNT(*)::int c FROM alert_resource WHERE info_id = $1', [infoRows[i].id]);
      if (existing.rows[0].c > 0) continue; // already backfilled
      inserted += await insertResources(client, infoRows[i].id, resources);
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Flag backfill (for alerts stored before the SOREM <parameter> parsing
// existed): recomputes broadcast_immediate / wireless_immediate and the
// broadcast_text script, all from the same <parameter> list. ---

const FLAG_CANDIDATE_WHERE = `
  raw_xml LIKE '%Broadcast_Immediately%' OR raw_xml LIKE '%Broadcast_Intrusive%' OR raw_xml LIKE '%WirelessImmediate%' OR raw_xml LIKE '%Broadcast_Text%'
`;

/**
 * A page of alerts whose raw XML mentions one of the BI/WI parameter names
 * -- a cheap pre-filter so the flag backfill script doesn't have to
 * XML-parse every alert in the database.
 */
async function getCandidateAlertsForFlagBackfill(limit, offset) {
  await ensureSchema();
  const res = await pool.query(
    `SELECT id, raw_xml FROM alerts WHERE ${FLAG_CANDIDATE_WHERE} ORDER BY id ASC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

async function countCandidateAlertsForFlagBackfill() {
  await ensureSchema();
  const res = await pool.query(`SELECT COUNT(*)::int c FROM alerts WHERE ${FLAG_CANDIDATE_WHERE}`);
  return res.rows[0].c;
}

/**
 * Re-parses an already-stored alert's raw XML (via capParser.parseCapAlert)
 * and (re)computes its Broadcast Immediate / Wireless Immediate flags.
 * Unlike backfillResourcesForAlert(), this always overwrites rather than
 * skipping already-set values: broadcast_immediate/wireless_immediate are
 * plain nullable columns (not a separate table), so NULL is ambiguous
 * between "never checked" and "checked, no such parameter" -- there's no
 * reliable "already backfilled" signal to skip on. Recomputing is cheap and
 * idempotent (a no-op if the value hasn't changed), so this is safe to
 * call on every candidate alert, repeatedly.
 * Returns the number of alert_info rows whose flags actually changed.
 */
async function backfillFlagsForAlert(alertId, parsedInfos) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    const infoRows = (await client.query(
      'SELECT id, broadcast_immediate, wireless_immediate, broadcast_text FROM alert_info WHERE alert_id = $1 ORDER BY id ASC',
      [alertId]
    )).rows;

    if (infoRows.length !== parsedInfos.length) {
      throw new Error(
        `info block count mismatch (stored ${infoRows.length}, parsed ${parsedInfos.length})`
      );
    }

    await client.query('BEGIN');
    let updated = 0;
    for (let i = 0; i < infoRows.length; i++) {
      const newBI = parsedInfos[i].broadcastImmediate ?? null;
      const newWI = parsedInfos[i].wirelessImmediate ?? null;
      const newText = parsedInfos[i].broadcastText || null;
      if (
        infoRows[i].broadcast_immediate === newBI &&
        infoRows[i].wireless_immediate === newWI &&
        (infoRows[i].broadcast_text || null) === newText
      ) continue;
      await client.query(
        'UPDATE alert_info SET broadcast_immediate = $1, wireless_immediate = $2, broadcast_text = $3 WHERE id = $4',
        [newBI, newWI, newText, infoRows[i].id]
      );
      updated++;
    }
    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Geometry backfill (for alerts stored before polygon/circle parsing) ---

const GEO_CANDIDATE_WHERE = `raw_xml LIKE '%<polygon%' OR raw_xml LIKE '%<circle%'`;

async function getCandidateAlertsForGeoBackfill(limit, offset) {
  await ensureSchema();
  const res = await pool.query(
    `SELECT id, raw_xml FROM alerts WHERE ${GEO_CANDIDATE_WHERE} ORDER BY id ASC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

async function countCandidateAlertsForGeoBackfill() {
  await ensureSchema();
  const res = await pool.query(`SELECT COUNT(*)::int c FROM alerts WHERE ${GEO_CANDIDATE_WHERE}`);
  return res.rows[0].c;
}

/**
 * Re-parses an already-stored alert's raw XML and (re)writes its structured
 * polygon/circle geometry. Overwrites rather than skipping (like the flag
 * backfill), and is idempotent, so safe to re-run.
 * Returns the number of alert_info rows whose geometry actually changed.
 */
async function backfillGeoForAlert(alertId, parsedInfos) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    const infoRows = (await client.query(
      'SELECT id, polygons, circles FROM alert_info WHERE alert_id = $1 ORDER BY id ASC',
      [alertId]
    )).rows;

    if (infoRows.length !== parsedInfos.length) {
      throw new Error(
        `info block count mismatch (stored ${infoRows.length}, parsed ${parsedInfos.length})`
      );
    }

    await client.query('BEGIN');
    let updated = 0;
    for (let i = 0; i < infoRows.length; i++) {
      const newPoly = geomJson(parsedInfos[i].polygons);
      const newCirc = geomJson(parsedInfos[i].circles);
      if ((infoRows[i].polygons ?? null) === newPoly && (infoRows[i].circles ?? null) === newCirc) continue;
      await client.query(
        'UPDATE alert_info SET polygons = $1, circles = $2 WHERE id = $3',
        [newPoly, newCirc, infoRows[i].id]
      );
      updated++;
    }
    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One alert shaped for the live broadcast feed (see src/alertBus.js): the
 * alert plus a single <info> block (preferring the given language prefix,
 * else the first) with its attachments and parsed area geometry. Separate
 * from searchAlerts() so the hot search path is untouched.
 */
async function getAlertForBroadcast(id, { language } = {}) {
  await ensureSchema();
  const alertRes = await pool.query(
    `SELECT id, identifier, sender, sent, status, source, msg_type, scope FROM alerts WHERE id = $1 AND is_heartbeat = FALSE`,
    [id]
  );
  const alert = alertRes.rows[0];
  if (!alert) return null;

  const infos = (await pool.query(`SELECT * FROM alert_info WHERE alert_id = $1 ORDER BY id ASC`, [id])).rows;
  if (!infos.length) return null;

  let info = infos[0];
  if (language) {
    const want = language.toLowerCase();
    const pref = infos.find((r) => (r.language || '').toLowerCase().startsWith(want));
    if (pref) info = pref;
  }

  const resourcesByInfoId = await getResourcesByInfoIds([info.id]);
  const resources = resourcesByInfoId[info.id] || [];

  return {
    id: alert.id,
    identifier: alert.identifier,
    sender: alert.sender,
    sent: alert.sent,
    status: alert.status,
    source: alert.source,
    language: info.language,
    event: info.event,
    headline: info.headline,
    description: info.description,
    instruction: info.instruction,
    severity: info.severity,
    urgency: info.urgency,
    certainty: info.certainty,
    areaDesc: info.area_desc,
    broadcastText: info.broadcast_text || null,
    broadcastImmediate: info.broadcast_immediate ?? null,
    wirelessImmediate: info.wireless_immediate ?? null,
    geocodes: info.geocodes ? info.geocodes.split(',').map((s) => s.trim()).filter(Boolean) : [],
    polygons: parseGeom(info.polygons),
    circles: parseGeom(info.circles),
    resources: resources.map((r) => ({
      id: r.id,
      mimeType: r.mimeType,
      resourceDesc: r.resourceDesc,
      uri: r.uri,
      size: r.size,
      hasEmbeddedData: r.hasEmbeddedData,
    })),
  };
}

/**
 * Total number of distinct alerts matching the given filters (ignoring
 * limit/offset). Uses COUNT(DISTINCT a.id) rather than COUNT(*): the query
 * joins through alert_info, which has one row per <info> block, so a
 * bilingual alert (e.g. en-CA + fr-CA) would otherwise be counted twice
 * even though it's a single alert -- visible as "alerts found" not
 * matching /api/stats' "alerts indexed" when no language filter narrows
 * it down to one block per alert.
 */
async function countAlerts(filters = {}) {
  await ensureSchema();
  const { fromClause, where, values } = buildSearchQuery(filters);
  const res = await pool.query(`SELECT COUNT(DISTINCT a.id)::int c FROM ${fromClause} ${where}`, values);
  return res.rows[0].c;
}

async function getAlertRawXml(id) {
  await ensureSchema();
  const res = await pool.query('SELECT raw_xml FROM alerts WHERE id = $1', [id]);
  return res.rows[0]?.raw_xml ?? null;
}

async function stats() {
  await ensureSchema();
  const total = (await pool.query('SELECT COUNT(*)::int c FROM alerts WHERE is_heartbeat = FALSE')).rows[0].c;
  const bySource = (await pool.query(
    'SELECT fetched_from, COUNT(*)::int c FROM alerts WHERE is_heartbeat = FALSE GROUP BY fetched_from'
  )).rows;
  const latest = (await pool.query(
    'SELECT sent FROM alerts WHERE is_heartbeat = FALSE ORDER BY sent::timestamptz DESC LIMIT 1'
  )).rows[0];
  return { total, bySource, latestSent: latest ? latest.sent : null };
}

// --- Auth: users + sessions (only consulted when NAADS_AUTH is set) ---
// Password hashing/verification lives in src/auth.js; this layer only
// stores and reads. broadcast_prefs holds the operator's saved location /
// auto-play filter as a JSON string.

async function createUser({ username, passHash, role = 'user' }) {
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO users (username, pass_hash, role) VALUES ($1, $2, $3)
     RETURNING id, username, pass_hash, role, broadcast_prefs, created_at`,
    [username, passHash, role]
  );
  return res.rows[0];
}

async function getUserByUsername(username) {
  await ensureSchema();
  const res = await pool.query(
    'SELECT id, username, pass_hash, role, broadcast_prefs, created_at FROM users WHERE username = $1',
    [username]
  );
  return res.rows[0] || null;
}

async function getUserById(id) {
  await ensureSchema();
  const res = await pool.query(
    'SELECT id, username, pass_hash, role, broadcast_prefs, created_at FROM users WHERE id = $1',
    [id]
  );
  return res.rows[0] || null;
}

async function listUsers() {
  await ensureSchema();
  return (await pool.query('SELECT id, username, role, created_at FROM users ORDER BY username ASC')).rows;
}

async function countUsers() {
  await ensureSchema();
  return (await pool.query(`SELECT COUNT(*)::int c FROM users WHERE role <> 'guest'`)).rows[0].c;
}

async function updateUserPassword(username, passHash) {
  await ensureSchema();
  return (await pool.query('UPDATE users SET pass_hash = $1 WHERE username = $2', [passHash, username])).rowCount;
}

async function setUserRole(username, role) {
  await ensureSchema();
  return (await pool.query('UPDATE users SET role = $1 WHERE username = $2', [role, username])).rowCount;
}

async function deleteUser(username) {
  await ensureSchema();
  return (await pool.query('DELETE FROM users WHERE username = $1', [username])).rowCount;
}

async function getUserBroadcastPrefs(id) {
  const user = await getUserById(id);
  if (!user || !user.broadcast_prefs) return null;
  try {
    return JSON.parse(user.broadcast_prefs);
  } catch {
    return null;
  }
}

async function setUserBroadcastPrefs(id, prefs) {
  await ensureSchema();
  return (await pool.query('UPDATE users SET broadcast_prefs = $1 WHERE id = $2', [
    prefs == null ? null : JSON.stringify(prefs),
    id,
  ])).rowCount;
}

async function createSession({ id, userId, expiresAt, userAgent }) {
  await ensureSchema();
  await pool.query(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, $3::timestamptz, $4)',
    [id, userId, expiresAt, userAgent || null]
  );
  return { id, userId, expiresAt };
}

async function getSessionWithUser(id) {
  await ensureSchema();
  const res = await pool.query(
    `SELECT s.id, s.user_id, s.expires_at, u.username, u.role, u.broadcast_prefs
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;
  let prefs = null;
  if (row.broadcast_prefs) {
    try {
      prefs = JSON.parse(row.broadcast_prefs);
    } catch {
      prefs = null;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    role: row.role,
    broadcastPrefs: prefs,
    expiresAt: row.expires_at,
  };
}

async function destroySession(id) {
  await ensureSchema();
  return (await pool.query('DELETE FROM sessions WHERE id = $1', [id])).rowCount;
}

async function deleteExpiredSessions() {
  await ensureSchema();
  return (await pool.query('DELETE FROM sessions WHERE expires_at <= now()')).rowCount;
}

// --- stream keys (personal HLS capability URLs) ---

function parseKeyFilter(row) {
  if (!row) return null;
  let filter = null;
  if (row.filter) {
    try {
      filter = JSON.parse(row.filter);
    } catch {
      filter = null;
    }
  }
  return { ...row, filter };
}

async function createStreamKey({ key, userId = null, filter = null, label = null }) {
  await ensureSchema();
  const res = await pool.query(
    `INSERT INTO stream_keys (key, user_id, filter, label) VALUES ($1, $2, $3, $4)
     RETURNING key, user_id, filter, label, created_at, last_used_at`,
    [key, userId, filter == null ? null : JSON.stringify(filter), label]
  );
  return parseKeyFilter(res.rows[0]);
}

async function getStreamKey(key) {
  await ensureSchema();
  const res = await pool.query(
    'SELECT key, user_id, filter, label, created_at, last_used_at FROM stream_keys WHERE key = $1',
    [key]
  );
  return parseKeyFilter(res.rows[0]);
}

async function listStreamKeys(userId) {
  await ensureSchema();
  const res = await pool.query(
    'SELECT key, user_id, filter, label, created_at, last_used_at FROM stream_keys WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return res.rows.map(parseKeyFilter);
}

async function listAllStreamKeys() {
  await ensureSchema();
  const res = await pool.query(
    `SELECT s.key, s.user_id, s.filter, s.label, s.created_at, s.last_used_at, u.username
     FROM stream_keys s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC`
  );
  return res.rows.map(parseKeyFilter);
}

async function deleteStreamKey(key) {
  await ensureSchema();
  return (await pool.query('DELETE FROM stream_keys WHERE key = $1', [key])).rowCount;
}

async function touchStreamKey(key) {
  await ensureSchema();
  return (await pool.query('UPDATE stream_keys SET last_used_at = now() WHERE key = $1', [key])).rowCount;
}

async function setStreamKeyFilter(key, filter) {
  await ensureSchema();
  return (await pool.query('UPDATE stream_keys SET filter = $1 WHERE key = $2', [
    filter == null ? null : JSON.stringify(filter),
    key,
  ])).rowCount;
}

module.exports = {
  insertAlert,
  alertExists,
  getPollState,
  setPollState,
  searchAlerts,
  countAlerts,
  getAlertRawXml,
  getAlertForBroadcast,
  getResourceById,
  getCandidateAlertsForResourceBackfill,
  countCandidateAlertsForResourceBackfill,
  backfillResourcesForAlert,
  getCandidateAlertsForFlagBackfill,
  countCandidateAlertsForFlagBackfill,
  backfillFlagsForAlert,
  getCandidateAlertsForGeoBackfill,
  countCandidateAlertsForGeoBackfill,
  backfillGeoForAlert,
  stats,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  countUsers,
  updateUserPassword,
  setUserRole,
  deleteUser,
  getUserBroadcastPrefs,
  setUserBroadcastPrefs,
  createSession,
  getSessionWithUser,
  destroySession,
  deleteExpiredSessions,
  createStreamKey,
  getStreamKey,
  listStreamKeys,
  listAllStreamKeys,
  deleteStreamKey,
  touchStreamKey,
  setStreamKeyFilter,
};
