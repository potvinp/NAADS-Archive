'use strict';

const { parseCapAlert } = require('./capParser');
const { insertAlert, alertExists, getPollState, setPollState } = require('./db');

const BASE_URL = 'https://alertsarchive.pelmorex.com';
const FORM_URL = `${BASE_URL}/en.php`;
const USER_AGENT = 'naads-archive-bot/1.0 (+https://alerts.pelmorex.com/ NAADS archive client)';

const FETCH_RETRIES = 3;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRY_DELAY_MS = 500;

function fmtDate(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() with a timeout and retries (exponential backoff) on any HTTP
 * error status or on a network/timeout failure. Throws the last error
 * once retries are exhausted.
 */
async function fetchWithRetry(url, options = {}, { errorLabel, retries = FETCH_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
      lastErr = new Error(`${errorLabel}: HTTP ${res.status}`);
    } catch (err) {
      lastErr = err.name === 'TimeoutError' || err.name === 'AbortError'
        ? new Error(`${errorLabel}: timed out after ${FETCH_TIMEOUT_MS}ms`)
        : err;
    }
    if (attempt < retries) await sleep(FETCH_RETRY_DELAY_MS * 2 ** attempt);
  }
  throw lastErr;
}

/**
 * Fetch the archive's per-day HTML fragment and extract the list of
 * { href, filename } entries linking to individual CAP XML files.
 * The archive page (en.php) exposes a form that, on POST with the target
 * date, re-renders itself with a <div id="archived_files"> block containing
 * <li><a href="/archive/YYYY-MM-DD/....xml">...</a></li> entries.
 */
async function fetchDayListing(dateStr) {
  const body = new URLSearchParams({ datepicker: dateStr, dtp_input1: dateStr });
  const res = await fetchWithRetry(FORM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: body.toString(),
  }, { errorLabel: `Archive request failed for ${dateStr}` });
  const html = await res.text();

  const match = html.match(/<div id="archived_files">([\s\S]*?)<\/div>/);
  if (!match) return [];

  const container = match[1];
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
  const entries = [];
  let m;
  while ((m = linkRe.exec(container)) !== null) {
    const href = m[1].replace(/&amp;/g, '&');
    const filename = m[2].replace(/&amp;/g, '&');
    entries.push({ href, filename });
  }
  return entries;
}

async function fetchAlertXml(href) {
  const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } }, { errorLabel: `Failed to fetch ${url}` });
  return res.text();
}

/**
 * Poll a single calendar date, downloading and storing any alerts not
 * already present in the database. Returns counts for observability.
 */
async function pollDate(dateStr, { delayMs = 150 } = {}) {
  const entries = await fetchDayListing(dateStr);
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      // Cheap skip: identifier/sender aren't known until parsed, so we always
      // fetch the XML, but downloads are small (a few KB) and infrequent.
      const xml = await fetchAlertXml(entry.href);
      const parsed = parseCapAlert(xml);
      if (!parsed) { failed++; continue; }
      if (await alertExists(parsed.identifier, parsed.sender)) { skipped++; continue; }
      const result = await insertAlert(parsed, xml, 'archive');
      if (result.inserted) inserted++; else skipped++;
    } catch (err) {
      failed++;
      console.error(`[archive] ${dateStr} ${entry.filename}: ${err.message}`);
    }
    if (delayMs) await sleep(delayMs);
  }

  return { date: dateStr, total: entries.length, inserted, skipped, failed };
}

/**
 * Backfill an inclusive range of calendar dates (UTC), oldest first.
 */
async function backfillRange(startDate, endDate, opts = {}) {
  const results = [];
  const failedDates = [];
  const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  while (cur <= end) {
    const dateStr = fmtDate(cur);
    try {
      const result = await pollDate(dateStr, opts);
      results.push(result);
      console.log(`[archive] ${dateStr}: ${result.inserted} new, ${result.skipped} existing, ${result.failed} failed (of ${result.total})`);
      if (result.failed > 0) failedDates.push(dateStr);
    } catch (err) {
      // Day listing itself failed even after fetchWithRetry's retries; skip
      // the date rather than aborting the whole range.
      console.error(`[archive] ${dateStr}: failed - ${err.message}`);
      failedDates.push(dateStr);
    }
    await setPollState('archive_backfill_cursor', dateStr);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return { results, failedDates };
}

/**
 * Start periodic polling of "today" (and yesterday, to catch alerts that
 * land in the archive after local midnight rollover). Returns a stop function.
 */
function startPolling({ intervalMinutes = 15 } = {}) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    for (const d of [yesterday, now]) {
      const dateStr = fmtDate(d);
      try {
        const result = await pollDate(dateStr);
        if (result.inserted > 0) {
          console.log(`[archive] poll ${dateStr}: ${result.inserted} new alerts`);
        }
      } catch (err) {
        console.error(`[archive] poll failed for ${dateStr}: ${err.message}`);
      }
    }
  }

  tick();
  const handle = setInterval(tick, intervalMinutes * 60 * 1000);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

module.exports = { pollDate, backfillRange, startPolling, fetchDayListing, fmtDate };
