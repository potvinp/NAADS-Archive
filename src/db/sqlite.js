'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.NAADS_DB_PATH || path.join(DATA_DIR, 'alerts.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier    TEXT NOT NULL,
  sender        TEXT NOT NULL,
  sent          TEXT NOT NULL,
  status        TEXT,
  msg_type      TEXT,
  scope         TEXT,
  source        TEXT,
  code          TEXT,
  note          TEXT,
  references_raw TEXT,
  is_heartbeat  INTEGER NOT NULL DEFAULT 0,
  raw_xml       TEXT NOT NULL,
  fetched_from  TEXT NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(identifier, sender)
);

CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent);
CREATE INDEX IF NOT EXISTS idx_alerts_identifier ON alerts(identifier);
-- "sent" is stored as the raw CAP <sent> string (ISO 8601 with its original
-- UTC offset, e.g. "2026-07-22T00:02:31-07:00"), so a plain text ORDER BY
-- sorts lexicographically rather than chronologically -- an alert sent at
-- 07:02 UTC via a "-07:00" offset text-sorts *before* one sent at 06:23 UTC
-- via a "-00:00" offset. datetime() normalizes the offset away to UTC, so
-- this expression index lets queries order/filter by the real instant
-- without a table-wide sort.
CREATE INDEX IF NOT EXISTS idx_alerts_sent_dt ON alerts (datetime(sent));

CREATE TABLE IF NOT EXISTS alert_info (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  broadcast_immediate INTEGER,
  wireless_immediate  INTEGER
);
`);

// SQLite has no "ALTER TABLE ADD COLUMN IF NOT EXISTS"; CREATE TABLE IF NOT
// EXISTS above only creates the table on a fresh database and is a no-op on
// one that already exists (so it never retrofits new columns). Any column
// added after the table's first release needs an explicit check-and-add
// migration here, run before the indexes below that reference it.
function ensureColumn(table, column, definition) {
  const existingColumns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existingColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('alert_info', 'broadcast_immediate', 'INTEGER');
ensureColumn('alert_info', 'wireless_immediate', 'INTEGER');
// Structured area geometry (JSON): polygons as [[[lat,lon],...],...],
// circles as [{lat,lon,radiusKm},...]. Parsed from CAP <polygon>/<circle>
// and used by the live broadcast feed's location filter. The flattened
// area_desc/geocodes columns above are left as-is for search.
ensureColumn('alert_info', 'polygons', 'TEXT');
ensureColumn('alert_info', 'circles', 'TEXT');
// "layer:SOREM:1.0:Broadcast_Text" -- the exact script NAADS TTS reads on
// air; shown verbatim on the broadcast feed's emergency card.
ensureColumn('alert_info', 'broadcast_text', 'TEXT');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_info_alert_id ON alert_info(alert_id);
CREATE INDEX IF NOT EXISTS idx_info_event ON alert_info(event);
CREATE INDEX IF NOT EXISTS idx_info_severity ON alert_info(severity);
CREATE INDEX IF NOT EXISTS idx_info_broadcast_immediate ON alert_info(broadcast_immediate);
CREATE INDEX IF NOT EXISTS idx_info_wireless_immediate ON alert_info(wireless_immediate);
CREATE INDEX IF NOT EXISTS idx_info_urgency ON alert_info(urgency);

-- CAP <resource> blocks (audio/image/etc attachments), embedded as base64
-- ("derefUri") and/or linked by external URL ("uri"), per info block.
CREATE TABLE IF NOT EXISTS alert_resource (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  info_id       INTEGER NOT NULL REFERENCES alert_info(id) ON DELETE CASCADE,
  resource_desc TEXT,
  mime_type     TEXT,
  size          INTEGER,
  uri           TEXT,
  data          BLOB,
  digest        TEXT
);

CREATE INDEX IF NOT EXISTS idx_resource_info_id ON alert_resource(info_id);

CREATE VIRTUAL TABLE IF NOT EXISTS alert_info_fts USING fts5(
  headline, description, instruction, area_desc, event, sender_name,
  content='alert_info', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS alert_info_ai AFTER INSERT ON alert_info BEGIN
  INSERT INTO alert_info_fts(rowid, headline, description, instruction, area_desc, event, sender_name)
  VALUES (new.id, new.headline, new.description, new.instruction, new.area_desc, new.event, new.sender_name);
END;

CREATE TRIGGER IF NOT EXISTS alert_info_ad AFTER DELETE ON alert_info BEGIN
  INSERT INTO alert_info_fts(alert_info_fts, rowid, headline, description, instruction, area_desc, event, sender_name)
  VALUES ('delete', old.id, old.headline, old.description, old.instruction, old.area_desc, old.event, old.sender_name);
END;

CREATE TABLE IF NOT EXISTS poll_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Optional auth (only consulted when NAADS_AUTH is set; see src/auth.js).
-- One row per account. The reserved username 'guest' backs no-credential
-- guest sessions and has an empty pass_hash (unusable for password login).
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  pass_hash       TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user',
  broadcast_prefs TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Capability URLs for a personal HLS stream: whoever holds the key can pull
-- /hls/s/<key>/live.m3u8 with no login. Bound to a user (filter follows their
-- saved broadcast prefs) or standalone (filter is the stored JSON).
CREATE TABLE IF NOT EXISTS stream_keys (
  key          TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  filter       TEXT,
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_stream_keys_user_id ON stream_keys(user_id);
`);

const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (identifier, sender, sent, status, msg_type, scope, source, code, note, references_raw, is_heartbeat, raw_xml, fetched_from)
  VALUES (@identifier, @sender, @sent, @status, @msg_type, @scope, @source, @code, @note, @references_raw, @is_heartbeat, @raw_xml, @fetched_from)
  ON CONFLICT(identifier, sender) DO NOTHING
`);

const insertInfoStmt = db.prepare(`
  INSERT INTO alert_info (alert_id, language, category, event, response_type, urgency, severity, certainty,
    effective, onset, expires, sender_name, headline, description, instruction, web, area_desc, geocodes,
    broadcast_immediate, wireless_immediate, polygons, circles, broadcast_text)
  VALUES (@alert_id, @language, @category, @event, @response_type, @urgency, @severity, @certainty,
    @effective, @onset, @expires, @sender_name, @headline, @description, @instruction, @web, @area_desc, @geocodes,
    @broadcast_immediate, @wireless_immediate, @polygons, @circles, @broadcast_text)
`);

// Serialize the parsed polygon/circle arrays for storage; null (not "[]")
// when the info block carries no geometry, so a NULL column is unambiguous.
function geomJson(value) {
  return value && value.length ? JSON.stringify(value) : null;
}

// SQLite has no native boolean type; store the tri-state (true/false/unknown)
// flag as 1/0/NULL.
function boolToInt(v) {
  return v === null || v === undefined ? null : (v ? 1 : 0);
}

const insertResourceStmt = db.prepare(`
  INSERT INTO alert_resource (info_id, resource_desc, mime_type, size, uri, data, digest)
  VALUES (@info_id, @resource_desc, @mime_type, @size, @uri, @data, @digest)
`);

const existsStmt = db.prepare(`SELECT id FROM alerts WHERE identifier = ? AND sender = ?`);

/**
 * Inserts an info block's resources (see capParser.parseResources) under
 * the given alert_info id. Shared by insertAlert() (new alerts) and
 * backfillResourcesForAlert() (re-parsing already-stored raw XML).
 */
function insertResources(infoId, resources) {
  let inserted = 0;
  for (const resource of resources || []) {
    insertResourceStmt.run({
      info_id: infoId,
      resource_desc: resource.resourceDesc || null,
      mime_type: resource.mimeType || null,
      size: resource.size || null,
      uri: resource.uri || null,
      data: resource.derefUri ? Buffer.from(resource.derefUri, 'base64') : null,
      digest: resource.digest || null,
    });
    inserted++;
  }
  return inserted;
}

/**
 * Insert a parsed CAP alert (see capParser.js) if not already present.
 * Returns { inserted: boolean, id: number|null }
 */
function insertAlert(parsedAlert, rawXml, fetchedFrom) {
  const existing = existsStmt.get(parsedAlert.identifier, parsedAlert.sender);
  if (existing) return { inserted: false, id: existing.id };

  const info = insertAlertStmt.run({
    identifier: parsedAlert.identifier,
    sender: parsedAlert.sender,
    sent: parsedAlert.sent,
    status: parsedAlert.status || null,
    msg_type: parsedAlert.msgType || null,
    scope: parsedAlert.scope || null,
    source: parsedAlert.source || null,
    code: parsedAlert.code || null,
    note: parsedAlert.note || null,
    references_raw: parsedAlert.references || null,
    is_heartbeat: parsedAlert.isHeartbeat ? 1 : 0,
    raw_xml: rawXml,
    fetched_from: fetchedFrom,
  });

  if (info.changes === 0) {
    const row = existsStmt.get(parsedAlert.identifier, parsedAlert.sender);
    return { inserted: false, id: row ? row.id : null };
  }

  const alertId = info.lastInsertRowid;
  for (const infoBlock of parsedAlert.infos) {
    const infoResult = insertInfoStmt.run({
      alert_id: alertId,
      language: infoBlock.language || null,
      category: infoBlock.category || null,
      event: infoBlock.event || null,
      response_type: infoBlock.responseType || null,
      urgency: infoBlock.urgency || null,
      severity: infoBlock.severity || null,
      certainty: infoBlock.certainty || null,
      effective: infoBlock.effective || null,
      onset: infoBlock.onset || null,
      expires: infoBlock.expires || null,
      sender_name: infoBlock.senderName || null,
      headline: infoBlock.headline || null,
      description: infoBlock.description || null,
      instruction: infoBlock.instruction || null,
      web: infoBlock.web || null,
      area_desc: infoBlock.areaDesc || null,
      geocodes: infoBlock.geocodes || null,
      broadcast_immediate: boolToInt(infoBlock.broadcastImmediate),
      wireless_immediate: boolToInt(infoBlock.wirelessImmediate),
      polygons: geomJson(infoBlock.polygons),
      circles: geomJson(infoBlock.circles),
      broadcast_text: infoBlock.broadcastText || null,
    });

    insertResources(infoResult.lastInsertRowid, infoBlock.resources);
  }

  return { inserted: true, id: alertId };
}

function alertExists(identifier, sender) {
  return !!existsStmt.get(identifier, sender);
}

const getPollStateStmt = db.prepare(`SELECT value FROM poll_state WHERE key = ?`);
const setPollStateStmt = db.prepare(`
  INSERT INTO poll_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getPollState(key) {
  const row = getPollStateStmt.get(key);
  return row ? row.value : null;
}

function setPollState(key, value) {
  setPollStateStmt.run(key, value);
}

/**
 * Builds the shared FROM/WHERE/params for a filtered alert search, used by
 * both searchAlerts() (a page of rows) and countAlerts() (total match count)
 * so pagination can report how many pages exist.
 */
function buildSearchQuery({ q, event, severity, urgency, status, from, to, language, broadcastImmediate, wirelessImmediate } = {}) {
  const clauses = [];
  const params = {};
  let fromClause = 'alert_info i JOIN alerts a ON a.id = i.alert_id';

  if (q && q.trim()) {
    fromClause = 'alert_info_fts f JOIN alert_info i ON i.id = f.rowid JOIN alerts a ON a.id = i.alert_id';
    clauses.push('alert_info_fts MATCH @q');
    params.q = q;
  }
  if (event) { clauses.push('i.event LIKE @event'); params.event = `%${event}%`; }
  if (severity) { clauses.push('i.severity = @severity'); params.severity = severity; }
  if (urgency) { clauses.push('i.urgency = @urgency'); params.urgency = urgency; }
  if (status) { clauses.push('a.status = @status'); params.status = status; }
  if (from) { clauses.push('datetime(a.sent) >= datetime(@from)'); params.from = from; }
  if (to) { clauses.push('datetime(a.sent) <= datetime(@to)'); params.to = to; }
  // Alert language codes are like "en-CA"/"fr-CA" (plus rare third-language
  // codes) -- match by prefix so a plain "en"/"fr" selector works regardless
  // of region suffix.
  if (language) { clauses.push('i.language LIKE @language'); params.language = `${language}%`; }
  if (broadcastImmediate) clauses.push('i.broadcast_immediate = 1');
  if (wirelessImmediate) clauses.push('i.wireless_immediate = 1');
  clauses.push('a.is_heartbeat = 0');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { fromClause, where, params };
}

/**
 * Full text + filtered search over alert_info joined with alerts.
 */
function searchAlerts({ limit = 50, offset = 0, ...filters } = {}) {
  const { fromClause, where, params } = buildSearchQuery(filters);
  const sql = `
    SELECT a.id, a.identifier, a.sender, a.sent, a.status, a.msg_type, a.scope, a.source, a.fetched_from,
           i.id AS info_id, i.language, i.category, i.event, i.urgency, i.severity, i.certainty,
           i.effective, i.expires, i.headline, i.description, i.instruction, i.area_desc,
           i.broadcast_immediate, i.wireless_immediate
    FROM ${fromClause}
    ${where}
    ORDER BY datetime(a.sent) DESC
    LIMIT @limit OFFSET @offset
  `;
  params.limit = limit;
  params.offset = offset;
  const rows = db.prepare(sql).all(params);

  const resourcesByInfoId = getResourcesByInfoIds(rows.map((r) => r.info_id));
  for (const row of rows) {
    row.resources = resourcesByInfoId[row.info_id] || [];
    // Normalize SQLite's 1/0/NULL back to a real boolean/null so API
    // consumers see the same shape regardless of storage backend.
    row.broadcast_immediate = row.broadcast_immediate === null ? null : !!row.broadcast_immediate;
    row.wireless_immediate = row.wireless_immediate === null ? null : !!row.wireless_immediate;
  }
  return rows;
}

/**
 * Fetches lightweight resource metadata (no blob bytes) for a set of
 * alert_info ids, grouped by info_id, for attaching to search results.
 */
function getResourcesByInfoIds(infoIds) {
  const uniqueIds = [...new Set(infoIds)];
  if (!uniqueIds.length) return {};
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, info_id, resource_desc, mime_type, size, uri, digest, (data IS NOT NULL) AS has_data
    FROM alert_resource
    WHERE info_id IN (${placeholders})
  `).all(...uniqueIds);

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
function getResourceById(id) {
  return db.prepare('SELECT mime_type, uri, data FROM alert_resource WHERE id = ?').get(id);
}

// --- Resource backfill (for alerts stored before <resource> parsing existed) ---

const candidateResourceAlertsStmt = db.prepare(`
  SELECT id, raw_xml FROM alerts WHERE raw_xml LIKE '%<resource%' ORDER BY id ASC LIMIT ? OFFSET ?
`);
const countCandidateResourceAlertsStmt = db.prepare(`
  SELECT COUNT(*) c FROM alerts WHERE raw_xml LIKE '%<resource%'
`);
const alertInfoIdsStmt = db.prepare(`SELECT id FROM alert_info WHERE alert_id = ? ORDER BY id ASC`);
const countResourcesForInfoStmt = db.prepare(`SELECT COUNT(*) c FROM alert_resource WHERE info_id = ?`);

/**
 * A page of alerts whose raw XML mentions a <resource> tag -- a cheap
 * pre-filter so the resource backfill script doesn't have to XML-parse
 * every alert in the database, just the small fraction with attachments.
 */
function getCandidateAlertsForResourceBackfill(limit, offset) {
  return candidateResourceAlertsStmt.all(limit, offset);
}

function countCandidateAlertsForResourceBackfill() {
  return countCandidateResourceAlertsStmt.get().c;
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
function backfillResourcesForAlert(alertId, parsedInfos) {
  const infoRows = alertInfoIdsStmt.all(alertId);
  if (infoRows.length !== parsedInfos.length) {
    throw new Error(
      `info block count mismatch (stored ${infoRows.length}, parsed ${parsedInfos.length})`
    );
  }

  const run = db.transaction(() => {
    let inserted = 0;
    for (let i = 0; i < infoRows.length; i++) {
      const resources = parsedInfos[i].resources || [];
      if (!resources.length) continue;
      if (countResourcesForInfoStmt.get(infoRows[i].id).c > 0) continue; // already backfilled
      inserted += insertResources(infoRows[i].id, resources);
    }
    return inserted;
  });

  return run();
}

// --- Flag backfill (for alerts stored before the SOREM <parameter> parsing
// existed): recomputes broadcast_immediate / wireless_immediate and the
// broadcast_text script, all from the same <parameter> list. ---

const FLAG_CANDIDATE_WHERE = `raw_xml LIKE '%Broadcast_Immediately%' OR raw_xml LIKE '%Broadcast_Intrusive%' OR raw_xml LIKE '%WirelessImmediate%' OR raw_xml LIKE '%Broadcast_Text%'`;
const candidateFlagAlertsStmt = db.prepare(`
  SELECT id, raw_xml FROM alerts WHERE ${FLAG_CANDIDATE_WHERE} ORDER BY id ASC LIMIT ? OFFSET ?
`);
const countCandidateFlagAlertsStmt = db.prepare(`SELECT COUNT(*) c FROM alerts WHERE ${FLAG_CANDIDATE_WHERE}`);
const alertInfoFlagsStmt = db.prepare(`SELECT id, broadcast_immediate, wireless_immediate, broadcast_text FROM alert_info WHERE alert_id = ? ORDER BY id ASC`);
const updateFlagsStmt = db.prepare(`UPDATE alert_info SET broadcast_immediate = @broadcast_immediate, wireless_immediate = @wireless_immediate, broadcast_text = @broadcast_text WHERE id = @id`);

/**
 * A page of alerts whose raw XML mentions one of the BI/WI parameter names
 * -- a cheap pre-filter so the flag backfill script doesn't have to
 * XML-parse every alert in the database.
 */
function getCandidateAlertsForFlagBackfill(limit, offset) {
  return candidateFlagAlertsStmt.all(limit, offset);
}

function countCandidateAlertsForFlagBackfill() {
  return countCandidateFlagAlertsStmt.get().c;
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
function backfillFlagsForAlert(alertId, parsedInfos) {
  const infoRows = alertInfoFlagsStmt.all(alertId);
  if (infoRows.length !== parsedInfos.length) {
    throw new Error(
      `info block count mismatch (stored ${infoRows.length}, parsed ${parsedInfos.length})`
    );
  }

  const run = db.transaction(() => {
    let updated = 0;
    for (let i = 0; i < infoRows.length; i++) {
      const newBI = boolToInt(parsedInfos[i].broadcastImmediate);
      const newWI = boolToInt(parsedInfos[i].wirelessImmediate);
      const newText = parsedInfos[i].broadcastText || null;
      if (
        infoRows[i].broadcast_immediate === newBI &&
        infoRows[i].wireless_immediate === newWI &&
        (infoRows[i].broadcast_text || null) === newText
      ) continue;
      updateFlagsStmt.run({ id: infoRows[i].id, broadcast_immediate: newBI, wireless_immediate: newWI, broadcast_text: newText });
      updated++;
    }
    return updated;
  });

  return run();
}

// --- Geometry backfill (for alerts stored before polygon/circle parsing) ---

const candidateGeoAlertsStmt = db.prepare(`
  SELECT id, raw_xml FROM alerts
  WHERE raw_xml LIKE '%<polygon%' OR raw_xml LIKE '%<circle%'
  ORDER BY id ASC LIMIT ? OFFSET ?
`);
const countCandidateGeoAlertsStmt = db.prepare(`
  SELECT COUNT(*) c FROM alerts WHERE raw_xml LIKE '%<polygon%' OR raw_xml LIKE '%<circle%'
`);
const alertInfoGeoStmt = db.prepare(`SELECT id, polygons, circles FROM alert_info WHERE alert_id = ? ORDER BY id ASC`);
const updateGeoStmt = db.prepare(`UPDATE alert_info SET polygons = @polygons, circles = @circles WHERE id = @id`);

function getCandidateAlertsForGeoBackfill(limit, offset) {
  return candidateGeoAlertsStmt.all(limit, offset);
}

function countCandidateAlertsForGeoBackfill() {
  return countCandidateGeoAlertsStmt.get().c;
}

/**
 * Re-parses an already-stored alert's raw XML and (re)writes its structured
 * polygon/circle geometry. Overwrites rather than skipping (like the flag
 * backfill): a NULL column is ambiguous between "never parsed" and "parsed,
 * no geometry". Idempotent, so safe to re-run.
 * Returns the number of alert_info rows whose geometry actually changed.
 */
function backfillGeoForAlert(alertId, parsedInfos) {
  const infoRows = alertInfoGeoStmt.all(alertId);
  if (infoRows.length !== parsedInfos.length) {
    throw new Error(
      `info block count mismatch (stored ${infoRows.length}, parsed ${parsedInfos.length})`
    );
  }

  const run = db.transaction(() => {
    let updated = 0;
    for (let i = 0; i < infoRows.length; i++) {
      const newPoly = geomJson(parsedInfos[i].polygons);
      const newCirc = geomJson(parsedInfos[i].circles);
      if ((infoRows[i].polygons || null) === newPoly && (infoRows[i].circles || null) === newCirc) continue;
      updateGeoStmt.run({ id: infoRows[i].id, polygons: newPoly, circles: newCirc });
      updated++;
    }
    return updated;
  });

  return run();
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
 * One alert shaped for the live broadcast feed (see src/alertBus.js): the
 * alert plus a single <info> block (preferring the given language prefix,
 * else the first) with its attachments and parsed area geometry. Separate
 * from searchAlerts() so the hot search path is untouched.
 */
function getAlertForBroadcast(id, { language } = {}) {
  const alert = db.prepare(
    `SELECT id, identifier, sender, sent, status, source, msg_type, scope FROM alerts WHERE id = ? AND is_heartbeat = 0`
  ).get(id);
  if (!alert) return null;

  const infos = db.prepare(`SELECT * FROM alert_info WHERE alert_id = ? ORDER BY id ASC`).all(id);
  if (!infos.length) return null;

  let info = infos[0];
  if (language) {
    const want = language.toLowerCase();
    const pref = infos.find((r) => (r.language || '').toLowerCase().startsWith(want));
    if (pref) info = pref;
  }

  const resources = getResourcesByInfoIds([info.id])[info.id] || [];

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
    broadcastImmediate: info.broadcast_immediate === null ? null : !!info.broadcast_immediate,
    wirelessImmediate: info.wireless_immediate === null ? null : !!info.wireless_immediate,
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
 * limit/offset), for computing page counts. Uses COUNT(DISTINCT a.id)
 * rather than COUNT(*): the query joins through alert_info, which has one
 * row per <info> block, so a bilingual alert (e.g. en-CA + fr-CA) would
 * otherwise be counted twice even though it's a single alert -- visible as
 * "alerts found" not matching /api/stats' "alerts indexed" when no
 * language filter narrows it down to one block per alert.
 */
function countAlerts(filters = {}) {
  const { fromClause, where, params } = buildSearchQuery(filters);
  const sql = `SELECT COUNT(DISTINCT a.id) c FROM ${fromClause} ${where}`;
  return db.prepare(sql).get(params).c;
}

function getAlertRawXml(id) {
  const row = db.prepare('SELECT raw_xml FROM alerts WHERE id = ?').get(id);
  return row ? row.raw_xml : null;
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM alerts WHERE is_heartbeat = 0').get().c;
  const bySource = db.prepare('SELECT fetched_from, COUNT(*) c FROM alerts WHERE is_heartbeat = 0 GROUP BY fetched_from').all();
  const latest = db.prepare('SELECT sent FROM alerts WHERE is_heartbeat = 0 ORDER BY datetime(sent) DESC LIMIT 1').get();
  return { total, bySource, latestSent: latest ? latest.sent : null };
}

// --- Auth: users + sessions (only consulted when NAADS_AUTH is set) ---
// Password hashing/verification lives in src/auth.js; this layer only
// stores and reads. broadcast_prefs holds the operator's saved location /
// auto-play filter as a JSON string.

const insertUserStmt = db.prepare(`INSERT INTO users (username, pass_hash, role) VALUES (@username, @pass_hash, @role)`);
const userByUsernameStmt = db.prepare(`SELECT id, username, pass_hash, role, broadcast_prefs, created_at FROM users WHERE username = ?`);
const userByIdStmt = db.prepare(`SELECT id, username, pass_hash, role, broadcast_prefs, created_at FROM users WHERE id = ?`);
const listUsersStmt = db.prepare(`SELECT id, username, role, created_at FROM users ORDER BY username ASC`);
const countUsersStmt = db.prepare(`SELECT COUNT(*) c FROM users WHERE role != 'guest'`);
const updateUserPasswordStmt = db.prepare(`UPDATE users SET pass_hash = @pass_hash WHERE username = @username`);
const setUserRoleStmt = db.prepare(`UPDATE users SET role = @role WHERE username = @username`);
const deleteUserStmt = db.prepare(`DELETE FROM users WHERE username = ?`);
const setBroadcastPrefsStmt = db.prepare(`UPDATE users SET broadcast_prefs = @broadcast_prefs WHERE id = @id`);

function createUser({ username, passHash, role = 'user' }) {
  const info = insertUserStmt.run({ username, pass_hash: passHash, role });
  return userByIdStmt.get(info.lastInsertRowid);
}
function getUserByUsername(username) {
  return userByUsernameStmt.get(username) || null;
}
function getUserById(id) {
  return userByIdStmt.get(id) || null;
}
function listUsers() {
  return listUsersStmt.all();
}
function countUsers() {
  return countUsersStmt.get().c;
}
function updateUserPassword(username, passHash) {
  return updateUserPasswordStmt.run({ username, pass_hash: passHash }).changes;
}
function setUserRole(username, role) {
  return setUserRoleStmt.run({ username, role }).changes;
}
function deleteUser(username) {
  return deleteUserStmt.run(username).changes;
}
function getUserBroadcastPrefs(id) {
  const row = userByIdStmt.get(id);
  if (!row || !row.broadcast_prefs) return null;
  try {
    return JSON.parse(row.broadcast_prefs);
  } catch {
    return null;
  }
}
function setUserBroadcastPrefs(id, prefs) {
  return setBroadcastPrefsStmt.run({ id, broadcast_prefs: prefs == null ? null : JSON.stringify(prefs) }).changes;
}

const insertSessionStmt = db.prepare(
  `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (@id, @user_id, @expires_at, @user_agent)`
);
const sessionWithUserStmt = db.prepare(`
  SELECT s.id, s.user_id, s.expires_at, u.username, u.role, u.broadcast_prefs
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ?
`);
const deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const deleteExpiredSessionsStmt = db.prepare(`DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')`);

function createSession({ id, userId, expiresAt, userAgent }) {
  insertSessionStmt.run({ id, user_id: userId, expires_at: expiresAt, user_agent: userAgent || null });
  return { id, userId, expiresAt };
}
function getSessionWithUser(id) {
  const row = sessionWithUserStmt.get(id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
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
function destroySession(id) {
  return deleteSessionStmt.run(id).changes;
}
function deleteExpiredSessions() {
  return deleteExpiredSessionsStmt.run().changes;
}

// --- stream keys (personal HLS capability URLs) ---

const insertStreamKeyStmt = db.prepare(
  `INSERT INTO stream_keys (key, user_id, filter, label) VALUES (@key, @user_id, @filter, @label)`
);
const streamKeyStmt = db.prepare(`SELECT key, user_id, filter, label, created_at, last_used_at FROM stream_keys WHERE key = ?`);
const streamKeysByUserStmt = db.prepare(`SELECT key, user_id, filter, label, created_at, last_used_at FROM stream_keys WHERE user_id = ? ORDER BY created_at DESC`);
const allStreamKeysStmt = db.prepare(`SELECT s.key, s.user_id, s.filter, s.label, s.created_at, s.last_used_at, u.username FROM stream_keys s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC`);
const deleteStreamKeyStmt = db.prepare(`DELETE FROM stream_keys WHERE key = ?`);
const touchStreamKeyStmt = db.prepare(`UPDATE stream_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = ?`);
const updateStreamKeyFilterStmt = db.prepare(`UPDATE stream_keys SET filter = @filter WHERE key = @key`);

function parseFilter(row) {
  if (!row) return row;
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

function createStreamKey({ key, userId = null, filter = null, label = null }) {
  insertStreamKeyStmt.run({ key, user_id: userId, filter: filter == null ? null : JSON.stringify(filter), label });
  return parseFilter(streamKeyStmt.get(key));
}
function getStreamKey(key) {
  return parseFilter(streamKeyStmt.get(key)) || null;
}
function listStreamKeys(userId) {
  return streamKeysByUserStmt.all(userId).map(parseFilter);
}
function listAllStreamKeys() {
  return allStreamKeysStmt.all().map(parseFilter);
}
function deleteStreamKey(key) {
  return deleteStreamKeyStmt.run(key).changes;
}
function touchStreamKey(key) {
  return touchStreamKeyStmt.run(key).changes;
}
function setStreamKeyFilter(key, filter) {
  return updateStreamKeyFilterStmt.run({ key, filter: filter == null ? null : JSON.stringify(filter) }).changes;
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
