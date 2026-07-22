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
`);

const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (identifier, sender, sent, status, msg_type, scope, source, code, note, references_raw, is_heartbeat, raw_xml, fetched_from)
  VALUES (@identifier, @sender, @sent, @status, @msg_type, @scope, @source, @code, @note, @references_raw, @is_heartbeat, @raw_xml, @fetched_from)
  ON CONFLICT(identifier, sender) DO NOTHING
`);

const insertInfoStmt = db.prepare(`
  INSERT INTO alert_info (alert_id, language, category, event, response_type, urgency, severity, certainty,
    effective, onset, expires, sender_name, headline, description, instruction, web, area_desc, geocodes,
    broadcast_immediate, wireless_immediate)
  VALUES (@alert_id, @language, @category, @event, @response_type, @urgency, @severity, @certainty,
    @effective, @onset, @expires, @sender_name, @headline, @description, @instruction, @web, @area_desc, @geocodes,
    @broadcast_immediate, @wireless_immediate)
`);

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

// --- Flag backfill (for alerts stored before BI/WI parameter parsing existed) ---

const candidateFlagAlertsStmt = db.prepare(`
  SELECT id, raw_xml FROM alerts
  WHERE raw_xml LIKE '%Broadcast_Immediately%' OR raw_xml LIKE '%Broadcast_Intrusive%' OR raw_xml LIKE '%WirelessImmediate%'
  ORDER BY id ASC LIMIT ? OFFSET ?
`);
const countCandidateFlagAlertsStmt = db.prepare(`
  SELECT COUNT(*) c FROM alerts
  WHERE raw_xml LIKE '%Broadcast_Immediately%' OR raw_xml LIKE '%Broadcast_Intrusive%' OR raw_xml LIKE '%WirelessImmediate%'
`);
const alertInfoFlagsStmt = db.prepare(`SELECT id, broadcast_immediate, wireless_immediate FROM alert_info WHERE alert_id = ? ORDER BY id ASC`);
const updateFlagsStmt = db.prepare(`UPDATE alert_info SET broadcast_immediate = @broadcast_immediate, wireless_immediate = @wireless_immediate WHERE id = @id`);

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
      if (infoRows[i].broadcast_immediate === newBI && infoRows[i].wireless_immediate === newWI) continue;
      updateFlagsStmt.run({ id: infoRows[i].id, broadcast_immediate: newBI, wireless_immediate: newWI });
      updated++;
    }
    return updated;
  });

  return run();
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

module.exports = {
  insertAlert,
  alertExists,
  getPollState,
  setPollState,
  searchAlerts,
  countAlerts,
  getAlertRawXml,
  getResourceById,
  getCandidateAlertsForResourceBackfill,
  countCandidateAlertsForResourceBackfill,
  backfillResourcesForAlert,
  getCandidateAlertsForFlagBackfill,
  countCandidateAlertsForFlagBackfill,
  backfillFlagsForAlert,
  stats,
};
