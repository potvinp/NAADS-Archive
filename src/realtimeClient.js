'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { parseCapAlert } = require('./capParser');

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // NAADS sends one every 60s
const HEARTBEAT_TIMEOUT_MS = 3 * HEARTBEAT_INTERVAL_MS; // reconnect if none for 3 min
const MAX_BACKOFF_MS = 30 * 1000;
const MAX_BUFFER_CHARS = 10 * 1024 * 1024; // safety cap against a runaway/malformed stream

/**
 * TCP client for a single NAADS Internet TCP Streaming Feed endpoint
 * (streaming1/streaming2.naad-adna.pelmorex.com:8080). Per the NAADS LMD
 * User Guide: it's a raw, unframed stream of concatenated CAP-CP XML
 * documents (each delimited only by its own <alert>...</alert> tags, with
 * an optional leading <?xml ...?> declaration), plus a CAP-CP "heartbeat"
 * alert sent once a minute so clients can detect a dead connection.
 *
 * Emits:
 *   'connected', 'disconnected'
 *   'alert'     (parsedAlert, rawXml)
 *   'heartbeat' (parsedAlert, rawXml)
 *   'error'     (err)
 */
class NaadStreamClient extends EventEmitter {
  constructor(name, host, port = 8080) {
    super();
    this.name = name;
    this.host = host;
    this.port = port;
    this.socket = null;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.lastHeartbeatAt = null;
    this.watchdog = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.socket) this.socket.destroy();
  }

  _connect() {
    if (this.stopped) return;
    this.socket = net.createConnection({ host: this.host, port: this.port });

    this.socket.on('connect', () => {
      this.reconnectAttempts = 0;
      this.lastHeartbeatAt = Date.now();
      this.buffer = '';
      this.decoder = new StringDecoder('utf8');
      this.emit('connected');
      this._startWatchdog();
    });

    this.socket.on('data', (chunk) => this._onData(chunk));

    this.socket.on('error', (err) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.emit('disconnected');
      if (this.watchdog) clearInterval(this.watchdog);
      this._scheduleReconnect();
    });
  }

  _startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        this.emit('error', new Error(`No heartbeat for ${HEARTBEAT_TIMEOUT_MS}ms, reconnecting`));
        this.socket.destroy();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    setTimeout(() => this._connect(), delay);
  }

  _onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.emit('error', new Error('Stream buffer exceeded safety limit; dropping buffer'));
      this.buffer = '';
      return;
    }
    this._extractMessages();
  }

  _extractMessages() {
    let searchFrom = 0;
    for (;;) {
      const startIdx = this.buffer.indexOf('<alert', searchFrom);
      if (startIdx === -1) break;
      const endTagIdx = this.buffer.indexOf('</alert>', startIdx);
      if (endTagIdx === -1) break;
      const endIdx = endTagIdx + '</alert>'.length;

      let msgStart = startIdx;
      const preceding = this.buffer.slice(0, startIdx);
      const declMatch = preceding.match(/<\?xml[^?]*\?>\s*$/);
      if (declMatch) msgStart = startIdx - declMatch[0].length;

      const rawMessage = this.buffer.slice(msgStart, endIdx);
      searchFrom = endIdx;
      this._handleMessage(rawMessage);
    }
    this.buffer = this.buffer.slice(searchFrom);
  }

  _handleMessage(rawXml) {
    const parsed = parseCapAlert(rawXml);
    if (!parsed) return;
    if (parsed.isHeartbeat) {
      this.lastHeartbeatAt = Date.now();
      this.emit('heartbeat', parsed, rawXml);
    } else {
      this.emit('alert', parsed, rawXml);
    }
  }
}

module.exports = { NaadStreamClient };
