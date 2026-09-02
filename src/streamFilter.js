'use strict';

// Decides whether a given alert belongs on a filtered feed (a personal HLS
// stream, or the browser monitor's auto-play gate). The filter object is the
// same shape the monitor saves as broadcast prefs:
//   { scope: 'all'|'bi'|'biwi', provinces: ['ON', ...], prefixes: ['3520', ...],
//     lat: number|null, lon: number|null, radiusKm: number }
// The monitor also carries `autoplay`; a dedicated stream ignores it (the
// stream always airs what matches).

// Statistics Canada SGC leading digits by province/territory.
const SGC = {
  NL: '10', PE: '11', NS: '12', NB: '13', QC: '24', ON: '35',
  MB: '46', SK: '47', AB: '48', BC: '59', YT: '60', NT: '61', NU: '62',
};

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ring: [[lat,lon], ...]; p: [lat,lon]. Ray casting.
function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    const hit = (yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function activePrefixes(filter) {
  const fromProv = (filter.provinces || []).map((c) => SGC[c]).filter(Boolean);
  return [...new Set([...fromProv, ...(filter.prefixes || [])])];
}

function alertHitsPoint(filter, alert) {
  if (filter.lat == null || filter.lon == null) return false;
  const p = [Number(filter.lat), Number(filter.lon)];
  const r = Math.max(0, Number(filter.radiusKm) || 0);
  for (const c of alert.circles || []) {
    if (haversineKm(p, [c.lat, c.lon]) <= (c.radiusKm || 0) + r) return true;
  }
  for (const poly of alert.polygons || []) {
    if (pointInPolygon(p, poly)) return true;
    if (r > 0 && poly.some((v) => haversineKm(p, v) <= r)) return true;
  }
  return false;
}

function isTestAlert(alert) {
  return alert.status === 'Test' || /\btest\b/i.test(alert.event || '');
}

// EC re-issues / cancels a weather warning with a headline like "squall
// warning changed" or "... ended" -- not useful on a broadcast feed.
// Suppressed everywhere (web monitor and HLS).
function isUpdateNoise(alert) {
  return /\b(changed|ended)\b/i.test(alert.headline || '');
}

// Whether the alert meets the intrusive-distribution bar (SOREM Broadcast /
// Wireless Immediate) -- drives the red "EMERGENCY ALERT" card.
function isEmergency(alert) {
  return alert.broadcastImmediate === true || alert.wirelessImmediate === true;
}

/**
 * True if `alert` should air on a feed configured with `filter`.
 * An empty / missing filter airs everything except the always-suppressed
 * "... changed" updates. `filter.includeTests === false` also drops tests.
 */
function airs(filter, alert) {
  const f = filter || {};
  if (alert.manualTest) return true; // operator-triggered diagnostic: always air
  if (isUpdateNoise(alert)) return false;
  if (isTestAlert(alert) && f.includeTests === false) return false;
  if (f.scope === 'bi' && alert.broadcastImmediate !== true) return false;
  if (f.scope === 'biwi' && !isEmergency(alert)) return false;

  const prefixes = activePrefixes(f);
  const hasGeo = f.lat != null && f.lon != null;
  if (!prefixes.length && !hasGeo) return true;

  const geocodes = alert.geocodes || [];
  const prefixMatch = prefixes.some((pfx) => geocodes.some((g) => String(g).startsWith(pfx)));
  return prefixMatch || alertHitsPoint(f, alert);
}

module.exports = { airs, isTestAlert, isUpdateNoise, isEmergency, SGC };
