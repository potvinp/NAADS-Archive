'use strict';

// Continuous HLS "alert channels": 24/7 audio+video programs that a station
// automation system, VLC, OBS or a browser can pull. Between alerts a channel
// loops a slate (a "no active alert" card + silence); when an alert arrives on
// the alertBus and passes that channel's filter, it splices in the on-air
// sequence (Pre-Tone -> Alert Ready tone -> the alert's TTS audio ->
// Post-Message) over a red EMERGENCY ALERT card showing the SOREM
// Broadcast_Text, then returns to the slate.
//
//   - The default channel at /hls/live.m3u8 airs everything.
//   - Per-key channels at /hls/s/<key>/live.m3u8 air only alerts matching the
//     key's filter (a personal, unguessable, no-login URL -- see server.js).
//
// Each ~6s piece is an independent MPEG-TS segment and the .m3u8 is a
// sliding window this module rewrites, so there is no single long-lived
// encoder to keep alive and content switches are just #EXT-X-DISCONTINUITY.
// The slate and each alert's rendered block are built once and shared across
// channels. Enabled only when NAADS_STREAM is set; needs ffmpeg + ffprobe.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const alertBus = require('./alertBus');
const { BROADCAST_CLIPS } = require('./broadcastClips');
const { getResourceById, getUserBroadcastPrefs, listAllStreamKeys } = require('./db');
const { airs, isTestAlert, isEmergency } = require('./streamFilter');

const truthy = (v) => /^(1|true|yes|on)$/i.test(v || '');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const CFG = {
  enabled: truthy(process.env.NAADS_STREAM),
  // Purely transient (segments are regenerated every boot). Default to the
  // OS tmpdir so a read-only or foreign-owned bind-mounted ./data can't
  // break startup -- override with NAADS_STREAM_DIR.
  dir: process.env.NAADS_STREAM_DIR || path.join(os.tmpdir(), 'naads-hls'),
  size: /^\d+x\d+$/.test(process.env.NAADS_STREAM_SIZE || '') ? process.env.NAADS_STREAM_SIZE : '1280x720',
  fps: Math.max(5, Number(process.env.NAADS_STREAM_FPS) || 15),
  seg: Math.max(2, Number(process.env.NAADS_STREAM_SEGMENT_SECONDS) || 6),
  window: Math.max(6, Number(process.env.NAADS_STREAM_WINDOW) || 24),
  lookaheadSegments: Math.max(1, Number(process.env.NAADS_STREAM_LOOKAHEAD_SEGMENTS) || 3),
  minAlertSeconds: Math.max(10, Number(process.env.NAADS_STREAM_MIN_ALERT_SECONDS) || 20),
  minPageSec: Math.max(3, Number(process.env.NAADS_STREAM_PAGE_SECONDS) || 8),
  leadSilenceSec: Math.max(0, Number(process.env.NAADS_STREAM_LEAD_SILENCE) || 2.5),
  idleMinutes: Math.max(1, Number(process.env.NAADS_STREAM_IDLE_MINUTES) || 10),
  maxChannels: Math.max(1, Number(process.env.NAADS_STREAM_MAX_CHANNELS) || 24),
  lang: process.env.NAADS_BROADCAST_LANG || 'en',
  font:
    process.env.NAADS_STREAM_FONT ||
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/System/Library/Fonts/Helvetica.ttc'].find((p) => fs.existsSync(p)) ||
    null,
  fontMono:
    process.env.NAADS_STREAM_FONT_MONO ||
    ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'].find((p) => fs.existsSync(p)) ||
    null,
};

const [W, H] = CFG.size.split('x').map(Number);
const DEFAULT_KEY = '_default';
const SHARED = () => path.join(CFG.dir, '_shared');
const slateFile = () => path.join(SHARED(), 'slate.ts');

const log = (...a) => console.log('[hls]', ...a);

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-400)}`));
    });
  });
}

async function probeDuration(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(String(out).trim()) || 0;
}

// --- card rendering ----------------------------------------------------

function wrap(text, cols) {
  const lines = [];
  for (const para of String(text || '').replace(/\r/g, '').split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && line.length + 1 + word.length > cols) { lines.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
  }
  return lines;
}

const COMMON_V = ['-r', String(CFG.fps), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', String(CFG.fps * 2), '-sc_threshold', '0'];
const COMMON_A = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'];

function drawtext(file, { font, size, y, x = '(w-text_w)/2', color = 'white', lineSpacing }) {
  const parts = [`fontfile=${font}`, `textfile=${file}`, `fontcolor=${color}`, `fontsize=${size}`, `x=${x}`, `y=${y}`];
  if (lineSpacing != null) parts.push(`line_spacing=${lineSpacing}`);
  return 'drawtext=' + parts.join(':');
}

// Body text layout on an alert card: kept generous (bigger type, fewer
// chars per line) so it reads from across a room on a TV -- which also
// means long alerts spill onto extra pages sooner.
const BODY_SIZE = Math.round(H / 25);
const BODY_COLS = Math.max(24, Number(process.env.NAADS_STREAM_PAGE_COLS) || 46);
const BODY_LINE_H = Math.round(BODY_SIZE * 1.7);
const BODY_TOP = Math.round(H * 0.28);
const BODY_MAX_H = Math.round(H * 0.5);

function bodyLinesPerCard() {
  return Math.max(3, Number(process.env.NAADS_STREAM_PAGE_LINES) || Math.floor(BODY_MAX_H / BODY_LINE_H));
}

// Split already-wrapped body lines into cards of at most `perCard` lines.
function paginateLines(lines, perCard) {
  if (!lines.length) return [['']];
  const pages = [];
  for (let i = 0; i < lines.length; i += perCard) pages.push(lines.slice(i, i + perCard));
  return pages;
}

async function renderCard(pngPath, workDir, { bg, kicker, headline, bodyLines, footer, page }) {
  const put = (name, txt) => {
    const f = path.join(workDir, name);
    fs.writeFileSync(f, txt);
    return f;
  };
  const kickerSize = Math.round(H / 12);
  const headSize = Math.round(H / 26);
  const footSize = Math.round(H / 40);

  const vf = [
    drawtext(put('kicker.txt', kicker), { font: CFG.font, size: kickerSize, y: Math.round(H * 0.08) }),
  ];
  if (headline) {
    vf.push(drawtext(put('headline.txt', wrap(headline, 60).join('\n')), { font: CFG.font, size: headSize, y: Math.round(H * 0.08 + kickerSize * 1.4), color: '0xF2F2F2' }));
  }
  vf.push(drawtext(put('body.txt', bodyLines.join('\n')), { font: CFG.fontMono || CFG.font, size: BODY_SIZE, y: BODY_TOP, lineSpacing: Math.round(BODY_SIZE * 0.7) }));
  if (footer) {
    vf.push(drawtext(put('footer.txt', wrap(footer, 90).join('\n')), { font: CFG.font, size: footSize, y: `h-text_h-${Math.round(H * 0.06)}`, color: '0xE6E6E6' }));
  }
  if (page && page.total > 1) {
    vf.push(
      drawtext(put('page.txt', `${page.n} / ${page.total}`), {
        font: CFG.font, size: footSize, color: '0xE6E6E6',
        x: `w-text_w-${Math.round(W * 0.04)}`, y: `h-text_h-${Math.round(H * 0.055)}`,
      })
    );
  }

  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}`, '-vf', vf.join(','), '-frames:v', '1', pngPath]);
}

async function toWav(src, dst, seconds) {
  if (src) await run(FFMPEG, ['-y', '-i', src, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', dst]);
  else await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(seconds), '-c:a', 'pcm_s16le', dst]);
  return dst;
}

async function fetchTts(alert, workDir) {
  const res = (alert.resources || []).find((r) => (r.mimeType || '').startsWith('audio/'));
  if (!res) return null;
  const dst = path.join(workDir, 'tts.src');
  try {
    const row = await getResourceById(res.id);
    if (row && row.data) { fs.writeFileSync(dst, row.data); return dst; }
    if (row && row.uri) {
      const r = await fetch(row.uri);
      if (r.ok) { fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer())); return dst; }
    }
  } catch (e) {
    log('tts fetch failed:', e.message);
  }
  return null;
}

// --- shared assets ---------------------------------------------------

async function buildSlate() {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'naads-slate-'));
  try {
    const png = path.join(wd, 'slate.png');
    await renderCard(png, wd, {
      bg: '0x0B0B0C',
      kicker: 'NAADS ALERT MONITOR',
      headline: '',
      bodyLines: ['No active broadcast alert.', 'Standing by on the NAADS real-time feed.'],
      footer: '',
    });
    fs.mkdirSync(SHARED(), { recursive: true });
    await run(FFMPEG, [
      '-y', '-loop', '1', '-framerate', String(CFG.fps), '-i', png,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(CFG.seg), ...COMMON_V, ...COMMON_A,
      '-muxpreload', '0', '-muxdelay', '0', '-f', 'mpegts', slateFile(),
    ]);
  } finally {
    fs.rm(wd, { recursive: true, force: true }, () => {});
  }
}

// Resolves once the shared slate segment exists; channels wait on it before
// ticking so one created during the startup window doesn't fail its copies.
let slateReady = null;

// Rendered alert blocks, shared across channels. Map<alertId, {promise, at}>.
const blockCache = new Map();

async function buildAlertBlock(alert) {
  const outDir = path.join(SHARED(), 'blocks', String(alert.id));
  fs.mkdirSync(outDir, { recursive: true });
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'naads-alert-'));
  try {
    // Grey for tests; red + "EMERGENCY ALERT" only when Broadcast/Wireless
    // Immediate is set; amber for everything else.
    const test = isTestAlert(alert);
    const emerg = isEmergency(alert);
    const onAir = alert.broadcastText || [alert.description, alert.instruction].filter(Boolean).join('\n\n');
    const cardOpts = {
      bg: test ? '0x3F3F46' : emerg ? '0xC8102E' : '0xB45309',
      kicker: test ? 'TEST ALERT' : emerg ? 'EMERGENCY ALERT' : (alert.event || 'ALERT').toUpperCase(),
      headline: (alert.headline || '').toUpperCase(),
      footer: [alert.event, alert.areaDesc, alert.sent].filter(Boolean).join('  -  '),
    };
    const wrapped = wrap((onAir || 'No message text provided.').toUpperCase(), BODY_COLS);

    // Pre-tone, the Alert Ready tone, and Post-Message wrap an alert only
    // when it's an emergency (Broadcast/Wireless Immediate). Everything else
    // is just its own TTS audio (if any) under the card.
    const parts = [];
    let i = 0;
    // Lead with silence so the audio-decoder reset hls.js does at the
    // #EXT-X-DISCONTINUITY (slate -> alert) lands on silence instead of
    // clipping the start of Pre-Tone.
    parts.push(await toWav(null, path.join(wd, `a${i++}.wav`), CFG.leadSilenceSec));
    if (emerg && BROADCAST_CLIPS['pre-tone']) parts.push(await toWav(BROADCAST_CLIPS['pre-tone'], path.join(wd, `a${i++}.wav`)));
    if (emerg && BROADCAST_CLIPS.tone) parts.push(await toWav(BROADCAST_CLIPS.tone, path.join(wd, `a${i++}.wav`)));
    const tts = await fetchTts(alert, wd);
    parts.push(await toWav(tts, path.join(wd, `a${i++}.wav`), CFG.minAlertSeconds));
    if (emerg && BROADCAST_CLIPS['post-message']) parts.push(await toWav(BROADCAST_CLIPS['post-message'], path.join(wd, `a${i++}.wav`)));

    const listFile = path.join(wd, 'concat.txt');
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    let audio = path.join(wd, 'audio.wav');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', audio]);

    let dur = await probeDuration(audio);
    // Trailing silence (mirrors the lead) then pad to the minimum on-air
    // time. With a continuous timeline (no discontinuity) the pad is just
    // insurance against segment-boundary rounding.
    const padTo = Math.max(dur + CFG.leadSilenceSec, CFG.minAlertSeconds);
    const padded = path.join(wd, 'audio-pad.wav');
    await run(FFMPEG, ['-y', '-i', audio, '-af', `apad=whole_dur=${padTo.toFixed(2)}`, '-c:a', 'pcm_s16le', padded]);
    audio = padded;
    dur = await probeDuration(audio);

    // Now that the block's total duration is known, split the message into
    // as many cards as it needs (long alerts scroll onto new pages instead
    // of being truncated), capped so each card shows at least minPageSec.
    let pageLines = paginateLines(wrapped, bodyLinesPerCard());
    if (pageLines.length > 1) {
      const maxPages = Math.max(1, Math.floor(dur / CFG.minPageSec));
      if (pageLines.length > maxPages) {
        pageLines = paginateLines(wrapped, Math.ceil(wrapped.length / maxPages));
      }
    }
    const pagePngs = [];
    for (let p = 0; p < pageLines.length; p++) {
      const f = path.join(wd, `card${p}.png`);
      await renderCard(f, wd, { ...cardOpts, bodyLines: pageLines[p], page: { n: p + 1, total: pageLines.length } });
      pagePngs.push(f);
    }

    // Encode the whole block once to an exact-length MPEG-TS, then cut it
    // into segments with `-reset_timestamps 1` so each segment's PTS starts
    // at ~0 -- the channel then places every segment (slate and alert
    // alike) on one monotonic timeline at publish time, so the playlist
    // needs no #EXT-X-DISCONTINUITY and hls.js never flushes its buffer.
    const blockTs = path.join(wd, 'block.ts');
    if (pagePngs.length === 1) {
      await run(FFMPEG, [
        '-y', '-loop', '1', '-framerate', String(CFG.fps), '-i', pagePngs[0], '-i', audio,
        ...COMMON_V, ...COMMON_A, '-map', '0:v:0', '-map', '1:a:0', '-t', dur.toFixed(3),
        '-muxpreload', '0', '-muxdelay', '0', '-f', 'mpegts', blockTs,
      ]);
    } else {
      // One image per page, each shown for an equal slice of the block, then
      // concatenated into the video track and muxed with the audio.
      const pageDur = dur / pagePngs.length + 0.05; // slight overshoot; -t clamps
      const args = ['-y'];
      for (const f of pagePngs) args.push('-loop', '1', '-t', pageDur.toFixed(3), '-i', f);
      args.push('-i', audio);
      const vin = pagePngs.map((_, k) => `[${k}:v]`).join('');
      args.push(
        '-filter_complex', `${vin}concat=n=${pagePngs.length}:v=1:a=0,fps=${CFG.fps},format=yuv420p[v]`,
        '-map', '[v]', '-map', `${pagePngs.length}:a:0`,
        ...COMMON_V.slice(2), // drop leading "-r <fps>"; the fps filter handles it
        ...COMMON_A, '-t', dur.toFixed(3),
        '-muxpreload', '0', '-muxdelay', '0', '-f', 'mpegts', blockTs
      );
      await run(FFMPEG, args);
    }
    await run(FFMPEG, [
      '-y', '-i', blockTs, '-map', '0', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(CFG.seg), '-segment_format', 'mpegts',
      '-reset_timestamps', '1', '-muxpreload', '0', '-muxdelay', '0',
      '-segment_list', path.join(outDir, 'ab.csv'), '-segment_list_type', 'csv',
      path.join(outDir, 'ab%04d.ts'),
    ]);

    const csv = fs.readFileSync(path.join(outDir, 'ab.csv'), 'utf8').trim().split('\n');
    const blocks = [];
    for (const line of csv) {
      const [name, start, end] = line.split(',');
      if (!name || !name.endsWith('.ts')) continue;
      blocks.push({ file: path.join(outDir, name.trim()), dur: Math.max(0.1, Number(end) - Number(start)) });
    }
    return blocks;
  } finally {
    fs.rm(wd, { recursive: true, force: true }, () => {});
  }
}

function getAlertBlocks(alert) {
  let e = blockCache.get(alert.id);
  if (!e) {
    e = { at: Date.now(), promise: buildAlertBlock(alert).catch((err) => { log('alert block build failed:', err.message); return []; }) };
    blockCache.set(alert.id, e);
  }
  return e.promise;
}

function sweepBlocks() {
  const ttl = (CFG.window * CFG.seg + 300) * 1000;
  for (const [id, e] of blockCache) {
    if (Date.now() - e.at > ttl) {
      blockCache.delete(id);
      fs.rm(path.join(SHARED(), 'blocks', String(id)), { recursive: true, force: true }, () => {});
    }
  }
}

// --- a single channel ------------------------------------------------

class Channel {
  constructor(key, getFilter) {
    this.key = key;
    this.getFilter = getFilter; // () => filter object (may change over time)
    this.dir = key === DEFAULT_KEY ? path.join(CFG.dir, DEFAULT_KEY) : path.join(CFG.dir, 's', key);
    this.seq = 0;
    this.firstSeq = 0;
    this.segments = []; // { name, dur }
    this.alertQueue = []; // { file, dur }
    this.lastUsed = Date.now();
    this.ticker = null;
    this.stopped = false;
    this.pumping = false;
    this.startedAt = 0;
    this.publishedSec = 0; // total media time published; also the next segment's PTS offset
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    (slateReady || Promise.resolve()).then(() => {
      if (this.stopped) return;
      this.startedAt = Date.now();
      this.pump(); // fill the initial lookahead buffer
      this.ticker = setInterval(() => this.pump(), 1000);
    });
  }

  stop() {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    fs.rm(this.dir, { recursive: true, force: true }, () => {});
  }

  touch() {
    this.lastUsed = Date.now();
  }

  playlist() {
    const target = Math.ceil(Math.max(CFG.seg, ...this.segments.map((s) => s.dur), 1));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${this.firstSeq}`];
    for (const s of this.segments) {
      lines.push(`#EXTINF:${s.dur.toFixed(3)},`);
      lines.push(s.name);
    }
    return lines.join('\n') + '\n';
  }

  // Stream-copy the source segment onto this channel's continuous timeline
  // (PTS offset by everything published so far), so the playlist has no
  // discontinuities and hls.js plays it as one seamless stream.
  async publish(srcFile, dur) {
    if (this.stopped) return;
    const name = `s${this.seq}.ts`;
    const dest = path.join(this.dir, name);
    await run(FFMPEG, [
      '-y', '-i', srcFile, '-map', '0', '-c', 'copy',
      '-muxpreload', '0', '-muxdelay', '0',
      '-output_ts_offset', this.publishedSec.toFixed(3), '-f', 'mpegts', dest,
    ]);
    if (this.stopped) { fs.rm(dest, { force: true }, () => {}); return; }
    this.segments.push({ name, dur });
    this.seq += 1;
    this.publishedSec += dur;
    while (this.segments.length > CFG.window) {
      const gone = this.segments.shift();
      this.firstSeq += 1;
      fs.rm(path.join(this.dir, gone.name), { force: true }, () => {});
    }
    fs.writeFileSync(path.join(this.dir, 'live.m3u8'), this.playlist());
  }

  async publishOne() {
    if (this.alertQueue.length) {
      const s = this.alertQueue.shift();
      await this.publish(s.file, s.dur);
      fs.rm(s.file, { force: true }, () => {}); // the staged q-*.ts copy
    } else {
      await this.publish(slateFile(), CFG.seg);
    }
  }

  // Keep the playlist a bit ahead of real playback time so timer drift, GC
  // pauses and network jitter can't starve the player. Normally we stay
  // `lookahead` segments ahead; while an alert is queued we buffer much
  // further (the whole pre-rendered block, up to what the window can retain
  // behind the live edge) so the alert can't stall mid-play. Paced against
  // the wall clock, so it self-corrects.
  async pump() {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      const lookaheadSec = CFG.lookaheadSegments * CFG.seg;
      const maxAheadSec = Math.max(lookaheadSec, (CFG.window - CFG.lookaheadSegments - 2) * CFG.seg);
      let guard = 0;
      for (;;) {
        if (this.stopped || guard++ >= 400) break;
        const nowSec = (Date.now() - this.startedAt) / 1000;
        const desiredAhead = this.alertQueue.length ? maxAheadSec : lookaheadSec;
        if (this.publishedSec - nowSec >= desiredAhead) break;
        if (!this.alertQueue.length && this.publishedSec - nowSec >= lookaheadSec) break;
        await this.publishOne();
      }
    } catch (e) {
      log(`[${this.key}] pump error:`, e.message);
    } finally {
      this.pumping = false;
    }
  }

  async offerAlert(alert) {
    let filter;
    try {
      filter = await this.getFilter();
    } catch {
      filter = {};
    }
    if (!airs(filter, alert)) return;
    const blocks = await getAlertBlocks(alert);
    // Stage a private copy of each shared block segment for this channel.
    for (let i = 0; i < blocks.length; i++) {
      const stage = path.join(this.dir, `q-${alert.id}-${i}-${Date.now()}.ts`);
      try {
        fs.copyFileSync(blocks[i].file, stage);
        this.alertQueue.push({ file: stage, dur: blocks[i].dur });
      } catch (e) {
        log(`[${this.key}] stage failed:`, e.message);
      }
    }
    if (this.ticker) this.pump(); // start buffering the alert now, not on the next tick
  }
}

// --- manager -------------------------------------------------------

const channels = new Map();
let running = false;
let reaper = null;

function channelExists(key) {
  return channels.has(key);
}

/**
 * Look up (or lazily create) a channel. `getFilter` is a function returning
 * the filter object; for a user-bound key it re-reads that user's prefs so
 * edits on the monitor follow through to the stream. Returns the channel's
 * directory, or null if the channel cap is reached.
 */
function ensureChannel(key, getFilter) {
  let ch = channels.get(key);
  if (ch) {
    ch.touch();
    return ch.dir;
  }
  if (!running) return null;
  if (channels.size >= CFG.maxChannels) {
    log(`channel cap (${CFG.maxChannels}) reached; refusing ${key}`);
    return null;
  }
  ch = new Channel(key, getFilter);
  channels.set(key, ch);
  ch.start();
  log(`channel ${key} started (${channels.size} live)`);
  return ch.dir;
}

function onAlert(alert) {
  if (!running) return;
  sweepBlocks();
  for (const ch of channels.values()) {
    ch.offerAlert(alert).catch((e) => log(`[${ch.key}] offerAlert:`, e.message));
  }
}

function reap() {
  const cutoff = Date.now() - CFG.idleMinutes * 60 * 1000;
  for (const [key, ch] of channels) {
    if (key === DEFAULT_KEY) continue;
    if (ch.lastUsed < cutoff) {
      ch.stop();
      channels.delete(key);
      log(`channel ${key} reaped (idle)`);
    }
  }
}

function start() {
  if (!CFG.enabled) return () => {};
  if (!CFG.font) {
    console.warn('[hls] NAADS_STREAM set but no usable font found (set NAADS_STREAM_FONT); stream disabled');
    return () => {};
  }
  // Only the transient media (segments, slate, per-channel dirs) lives here;
  // stream keys and their filters are in the database and are untouched.
  // Clean the contents best-effort -- never fail startup if the dir itself
  // can't be removed (e.g. a foreign-owned bind mount).
  try {
    fs.mkdirSync(CFG.dir, { recursive: true });
    for (const entry of fs.readdirSync(CFG.dir)) {
      fs.rmSync(path.join(CFG.dir, entry), { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`[hls] could not clean ${CFG.dir}: ${e.message} (continuing)`);
  }
  running = true;

  slateReady = buildSlate();
  slateReady
    .then(async () => {
      const defaultFilter = truthy(process.env.NAADS_STREAM_BI_ONLY) ? { scope: 'bi' } : {};
      ensureChannel(DEFAULT_KEY, () => defaultFilter);
      alertBus.on('alert', onAlert);
      reaper = setInterval(reap, 60 * 1000);
      log(`live at /hls/live.m3u8  (${CFG.size} @ ${CFG.fps}fps, ${CFG.seg}s segments)`);
      await warmRecentKeys();
    })
    .catch((e) => {
      running = false;
      console.error('[hls] failed to start:', e.message);
    });

  return function stop() {
    running = false;
    if (reaper) clearInterval(reaper);
    alertBus.off('alert', onAlert);
    for (const ch of channels.values()) ch.stop();
    channels.clear();
  };
}

// Builds a `getFilter` that re-reads a user's saved broadcast prefs (so a
// personal stream tracks edits made on the monitor), refreshed at most every
// 20s. A key not bound to a user uses its own stored filter JSON.
function makeUserFilter(userId) {
  let cache = {};
  let at = 0;
  return async () => {
    if (Date.now() - at > 20000) {
      try {
        cache = (await getUserBroadcastPrefs(userId)) || {};
      } catch {
        /* keep last */
      }
      at = Date.now();
    }
    return cache;
  };
}

// The right getFilter for a stream_keys row (see db.getStreamKey).
function makeKeyFilter(row) {
  return row.user_id ? makeUserFilter(row.user_id) : async () => row.filter || {};
}

// After a restart, proactively re-create channels for keys that were in use
// recently so a link someone was watching keeps working without waiting for
// a fresh request. The keys/filters themselves were never lost -- they're in
// the stream_keys table.
async function warmRecentKeys() {
  let rows;
  try {
    rows = await listAllStreamKeys();
  } catch (e) {
    log('warm-up skipped:', e.message);
    return;
  }
  const cutoff = Date.now() - CFG.idleMinutes * 60 * 1000;
  const recent = rows.filter((r) => r.last_used_at && new Date(r.last_used_at).getTime() >= cutoff);
  let warmed = 0;
  for (const r of recent) {
    if (channels.size >= CFG.maxChannels) break;
    if (ensureChannel(r.key, makeKeyFilter(r))) warmed += 1;
  }
  if (warmed) log(`warmed ${warmed} recently-used stream channel(s)`);
}

module.exports = {
  start,
  enabled: CFG.enabled,
  CFG,
  DEFAULT_KEY,
  ensureChannel,
  channelExists,
  makeUserFilter,
  makeKeyFilter,
};
