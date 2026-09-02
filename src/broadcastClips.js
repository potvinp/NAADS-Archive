'use strict';

const path = require('path');
const fs = require('fs');

// The fixed audio clips wrapping a broadcast-immediate alert, in play order:
//   pre-tone      -> station lead-in, before the attention signal
//   tone          -> the Alert Ready attention signal
//   (TTS)         -> the alert's own broadcast-audio <resource>
//   post-message  -> outro, after the TTS message
// Each resolves to an explicit env override, else a bundled default, else
// null (that step is skipped). Shared by the browser monitor's routes
// (src/server.js) and the HLS muxer (src/hlsStream.js).
function resolveClip(envVar, ...bundledRelPaths) {
  const explicit = process.env[envVar];
  if (explicit) return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  for (const rel of bundledRelPaths) {
    const p = path.join(__dirname, '..', rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const BROADCAST_CLIPS = {
  'pre-tone': resolveClip('NAADS_PRE_TONE', 'audio/Pre-Tone.wav'),
  tone: resolveClip('NAADS_ALERT_TONE', 'audio/Tone-v2.mp3', 'Tone-v2.mp3'),
  'post-message': resolveClip('NAADS_POST_MESSAGE', 'audio/Post-Message.wav'),
};

module.exports = { BROADCAST_CLIPS, resolveClip };
