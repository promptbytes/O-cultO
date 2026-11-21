// O-cultO relay server.
//
// This server is deliberately "dumb":
//   * It never sees plaintext: clients encrypt end-to-end before sending,
//     including the set-up messages for voice calls.
//   * It never writes anything to disk and keeps no message history.
//   * It does not log messages, room ids or IP addresses.
//   * A room exists only in memory while at least one person is connected.
//     A private chat holds 2 people, a group up to 8.
// All it does is pass opaque encrypted blobs between the sockets in a room.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MAX_FRAME_BYTES = 256 * 1024; // one encrypted message or file piece
const MAX_MSGS_PER_10S = 400; // per-connection flood limits
const MAX_BYTES_PER_10S = 64 * 1024 * 1024;
// A receiver this far behind is dropped, so a slow or stalled connection
// can't make the server hold a pile of data in memory.
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

// Voice calls are off unless ENABLE_CALLS=1. Without STUN/TURN servers they
// rarely connect between different networks, so they're hidden by default.
const CALLS_ENABLED = process.env.ENABLE_CALLS === '1';
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const CAPACITY = { pair: 2, group: 8 };

// STUN/TURN servers that help voice calls get through home routers and
// mobile networks. Empty by default so no third party learns anyone's IP;
// set ICE_SERVERS to a JSON array, e.g. '[{"urls":"stun:turn.example.org"}]'.
let ICE_SERVERS = [];
try {
  ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || '[]');
  if (!Array.isArray(ICE_SERVERS)) throw new Error('not an array');
} catch {
  console.error('ICE_SERVERS must be a JSON array; ignoring it.');
  ICE_SERVERS = [];
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Host names are limited to safe characters so they can't inject anything
// into the security policy below.
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** The public host name, even behind a hosting proxy that rewrites Host. */
function publicHost(req) {
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (HOST_RE.test(forwarded)) return forwarded;
  const host = String(req.headers.host || '');
  return HOST_RE.test(host) ? host : '';
}

function securityHeaders(req) {
  const host = publicHost(req);
  const headers = {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      host ? `connect-src 'self' ws://${host} wss://${host}` : "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  };
  if (req.headers['x-forwarded-proto'] === 'https') {
    headers['Strict-Transport-Security'] = 'max-age=31536000';
  }
  return headers;
}

// Third-party browser files, served from our own origin so the strict
// Content-Security-Policy never has to trust an outside CDN.
const VENDOR = {
  '/vendor/qrcode.js': require.resolve('qrcode-generator/qrcode.js'),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { ...securityHeaders(req), 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url.pathname === '/config.json') {
    res.writeHead(200, { ...securityHeaders(req), 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ calls: CALLS_ENABLED, iceServers: CALLS_ENABLED ? ICE_SERVERS : [] }));
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = VENDOR[file] || path.normalize(path.join(PUBLIC_DIR, file));
  if ((!VENDOR[file] && !full.startsWith(PUBLIC_DIR + path.sep)) || !MIME[path.extname(full)]) {
    res.writeHead(404, securityHeaders(req));
    return res.end('Not found');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, securityHeaders(req));
      return res.end('Not found');
    }
    res.writeHead(200, { ...securityHeaders(req), 'Content-Type': MIME[path.extname(full)] });
    res.end(data);
  });
});

/** roomId -> { mode, peers: Map<id, WebSocket> }; in memory only. */
const rooms = new Map();

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate();
  ws.send(JSON.stringify(obj));
}

function leave(ws) {
  const room = ws.roomId && rooms.get(ws.roomId);
  if (!room) return;
  room.peers.delete(ws.peerId);
  for (const peer of room.peers.values()) send(peer, { type: 'peer-left', id: ws.peerId });
  if (room.peers.size === 0) rooms.delete(ws.roomId);
  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  // A random id for this connection only, so people in a room can address
  // each other. It says nothing about who anyone is.
  ws.peerId = crypto.randomBytes(9).toString('base64url');
  ws.window = { start: Date.now(), count: 0, bytes: 0 };

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    const now = Date.now();
    if (now - ws.window.start > 10_000) ws.window = { start: now, count: 0, bytes: 0 };
    ws.window.bytes += raw.length;
    if (++ws.window.count > MAX_MSGS_PER_10S || ws.window.bytes > MAX_BYTES_PER_10S) {
      return ws.close(1008, 'rate limit');
    }
    if (isBinary) return ws.close(1003, 'text only');

    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return ws.close(1007, 'bad json'); }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const mode = msg.mode === 'group' ? 'group' : 'pair';
      if (ws.roomId || typeof msg.room !== 'string' || !ROOM_ID_RE.test(msg.room)) {
        return send(ws, { type: 'error', reason: 'bad-room' });
      }
      let room = rooms.get(msg.room);
      if (!room) rooms.set(msg.room, (room = { mode, peers: new Map() }));
      if (room.mode !== mode) return send(ws, { type: 'error', reason: 'bad-room' });
      if (room.peers.size >= CAPACITY[mode]) return send(ws, { type: 'error', reason: 'room-full' });
      const others = [...room.peers.keys()];
      room.peers.set(ws.peerId, ws);
      ws.roomId = msg.room;
      send(ws, { type: 'joined', id: ws.peerId, peers: others });
      for (const [id, peer] of room.peers) if (id !== ws.peerId) send(peer, { type: 'peer-joined', id: ws.peerId });
      return;
    }

    if (msg.type === 'relay') {
      const room = ws.roomId && rooms.get(ws.roomId);
      if (!room || typeof msg.data !== 'string') return;
      const out = { type: 'relay', from: ws.peerId, data: msg.data };
      // Forward the opaque, already-encrypted payload. Nothing is stored.
      if (typeof msg.to === 'string') {
        const peer = room.peers.get(msg.to);
        if (peer && peer !== ws) send(peer, out);
      } else {
        for (const peer of room.peers.values()) if (peer !== ws) send(peer, out);
      }
      return;
    }

    if (msg.type === 'leave') return leave(ws);
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Drop dead connections so empty rooms disappear quickly.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();
wss.on('close', () => clearInterval(heartbeat));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    // The only thing this server ever prints.
    console.log(`O-cultO relay listening on http://localhost:${PORT}`);
  });
}

module.exports = { server, wss, rooms };
