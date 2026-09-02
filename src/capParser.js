'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) => ['info', 'area', 'eventCode', 'parameter', 'geocode', 'polygon', 'circle', 'resource'].includes(name),
});

function textOf(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    // e.g. EC trusted-feed alerts repeat <code> for multiple profile codes
    const parts = value.map(textOf).filter(Boolean);
    return parts.length ? parts.join(',') : null;
  }
  if (typeof value === 'object') {
    // fast-xml-parser represents empty/self-closing elements as {}
    return null;
  }
  return String(value);
}

function parseAreaDesc(area) {
  if (!area) return null;
  return (area.areaDesc && textOf(area.areaDesc)) || null;
}

function parseGeocodes(area) {
  if (!area || !area.geocode) return null;
  const geocodes = Array.isArray(area.geocode) ? area.geocode : [area.geocode];
  const values = geocodes.map((g) => textOf(g && g.value)).filter(Boolean);
  return values.length ? values.join(',') : null;
}

/**
 * Parses one CAP <polygon> ("lat,lon lat,lon ..." space-separated pairs)
 * into [[lat, lon], ...]. Returns null unless it has at least 3 valid
 * points (a degenerate ring is useless for point-in-polygon tests).
 */
function parsePolygon(str) {
  if (!str || typeof str !== 'string') return null;
  const points = str
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [lat, lon] = pair.split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
    })
    .filter(Boolean);
  return points.length >= 3 ? points : null;
}

function parsePolygons(area) {
  if (!area || !area.polygon) return [];
  const list = Array.isArray(area.polygon) ? area.polygon : [area.polygon];
  return list.map((p) => parsePolygon(textOf(p))).filter(Boolean);
}

/**
 * Parses one CAP <circle> ("lat,lon radiusKm") into { lat, lon, radiusKm }.
 * Per the CAP spec the radius is in kilometres.
 */
function parseCircle(str) {
  if (!str || typeof str !== 'string') return null;
  const [center, radiusRaw] = str.trim().split(/\s+/);
  if (!center) return null;
  const [lat, lon] = center.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const radiusKm = Number(radiusRaw);
  return { lat, lon, radiusKm: Number.isFinite(radiusKm) ? radiusKm : 0 };
}

function parseCircles(area) {
  if (!area || !area.circle) return [];
  const list = Array.isArray(area.circle) ? area.circle : [area.circle];
  return list.map((c) => parseCircle(textOf(c))).filter(Boolean);
}

/**
 * Parses an <info> block's <resource> attachments (audio/image/etc). Per
 * the CAP-CP spec, an attachment may be embedded as base64 in <derefUri>,
 * linked externally via <uri>, or both.
 */
function parseResources(info) {
  if (!info.resource) return [];
  const resources = Array.isArray(info.resource) ? info.resource : [info.resource];
  return resources.map((r) => ({
    resourceDesc: textOf(r.resourceDesc),
    mimeType: textOf(r.mimeType),
    size: r.size !== undefined ? parseInt(textOf(r.size), 10) || null : null,
    uri: textOf(r.uri),
    derefUri: textOf(r.derefUri),
    digest: textOf(r.digest),
  }));
}

/**
 * Parses an <info> block's <parameter> elements into { valueName, value }
 * pairs. Per the LMD User Guide Appendix 3, these carry the SOREM
 * Broadcast Immediate / Wireless Immediate flags (among other things).
 */
function parseParameters(info) {
  if (!info.parameter) return [];
  const params = Array.isArray(info.parameter) ? info.parameter : [info.parameter];
  return params.map((p) => ({ valueName: textOf(p.valueName), value: textOf(p.value) }));
}

/**
 * Derives the Broadcast Immediate (BI) and Wireless Immediate (WI) flags
 * from an info block's parsed <parameter> list. NAADS-originated alerts use
 * "layer:SOREM:1.0:Broadcast_Immediately" / "layer:SOREM:2.0:WirelessImmediate"
 * (Appendix 3); trusted-feed alerts (e.g. Environment Canada) instead use
 * "layer:EC-MSC-SMC:1.0:Broadcast_Intrusive" for the broadcast flag, so both
 * are matched by suffix. Returns null (rather than false) for either flag
 * when its parameter is absent altogether, since that's different from an
 * explicit "No".
 */
function parseImmediateFlags(parameters) {
  let broadcastImmediate = null;
  let wirelessImmediate = null;
  for (const { valueName, value } of parameters) {
    if (!valueName) continue;
    const isYes = /^yes$/i.test((value || '').trim());
    if (/Broadcast_Immediately$|Broadcast_Intrusive$/i.test(valueName)) {
      broadcastImmediate = isYes;
    } else if (/WirelessImmediate$/i.test(valueName)) {
      wirelessImmediate = isYes;
    }
  }
  return { broadcastImmediate, wirelessImmediate };
}

/**
 * The "layer:SOREM:1.0:Broadcast_Text" <parameter>, if present: the exact
 * script NAADS feeds to its text-to-speech engine to generate the alert's
 * broadcast audio. It's the authoritative on-air wording (often differing
 * from the public <description>), so the broadcast feed shows this verbatim.
 * Matched by suffix so a future SOREM layer revision still resolves.
 */
function parseBroadcastText(parameters) {
  for (const { valueName, value } of parameters) {
    if (valueName && /:Broadcast_Text$/i.test(valueName) && value) return value;
  }
  return null;
}

/**
 * Parses a raw CAP-CP XML alert message (as received from the NAADS archive
 * or TCP streaming feed) into a plain object suitable for storage.
 * Returns null if the XML does not look like a CAP <alert> document.
 */
function parseCapAlert(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    return null;
  }

  const alert = doc.alert;
  if (!alert || !alert.identifier || !alert.sender || !alert.sent) return null;

  const sender = textOf(alert.sender) || '';
  const status = textOf(alert.status) || '';
  const isHeartbeat = status === 'System' && /NAADS-Heartbeat/i.test(sender);

  const rawInfos = alert.info ? (Array.isArray(alert.info) ? alert.info : [alert.info]) : [];
  const infos = rawInfos.map((info) => {
    const areas = info.area ? (Array.isArray(info.area) ? info.area : [info.area]) : [];
    const areaDesc = areas.map(parseAreaDesc).filter(Boolean).join('; ') || null;
    const geocodes = areas.map(parseGeocodes).filter(Boolean).join(',') || null;
    const polygons = areas.flatMap(parsePolygons);
    const circles = areas.flatMap(parseCircles);
    const parameters = parseParameters(info);
    const { broadcastImmediate, wirelessImmediate } = parseImmediateFlags(parameters);
    const broadcastText = parseBroadcastText(parameters);
    return {
      language: textOf(info.language),
      category: textOf(info.category),
      event: textOf(info.event),
      responseType: textOf(info.responseType),
      urgency: textOf(info.urgency),
      severity: textOf(info.severity),
      certainty: textOf(info.certainty),
      effective: textOf(info.effective),
      onset: textOf(info.onset),
      expires: textOf(info.expires),
      senderName: textOf(info.senderName),
      headline: textOf(info.headline),
      description: textOf(info.description),
      instruction: textOf(info.instruction),
      web: textOf(info.web),
      areaDesc,
      geocodes,
      polygons,
      circles,
      broadcastImmediate,
      wirelessImmediate,
      broadcastText,
      resources: parseResources(info),
    };
  });

  return {
    identifier: textOf(alert.identifier),
    sender,
    sent: textOf(alert.sent),
    status,
    msgType: textOf(alert.msgType),
    scope: textOf(alert.scope),
    source: textOf(alert.source),
    code: textOf(alert.code),
    note: textOf(alert.note),
    references: textOf(alert.references),
    isHeartbeat,
    infos,
  };
}

/**
 * Parses the <references> field of a NAADS heartbeat into a list of
 * { sender, identifier, sent } entries describing recently transmitted alerts.
 * Format: "sender,identifier,sent sender,identifier,sent ..." (space separated
 * entries, comma separated fields, per the NAADS LMD User Guide Appendix 1).
 */
function parseHeartbeatReferences(referencesRaw) {
  if (!referencesRaw) return [];
  const tokens = referencesRaw.trim().split(/\s+/);
  const entries = [];
  for (const token of tokens) {
    const parts = token.split(',');
    if (parts.length !== 3) continue;
    const [sender, identifier, sent] = parts;
    entries.push({ sender, identifier, sent });
  }
  return entries;
}

module.exports = { parseCapAlert, parseHeartbeatReferences };
