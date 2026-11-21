// O-cultO relay server.
//
// This server is deliberately "dumb":
//   * It never sees plaintext: clients encrypt end-to-end before sending.
//   * It never writes anything to disk and keeps no message history.
//   * It does not log messages, room ids or IP addresses.
//   * A room exists only in memory while at least one person is connected,
//     and holds at most two people.
// All it does is pass opaque encrypted blobs from one socket to the other.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MAX_FRAME_BYTES = 64 * 1024; // one encrypted message
const MAX_MSGS_PER_10S = 50; // simple per-connection flood limit
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function securityHeaders(req) {
  const host = req.headers.host || '';
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !MIME[path.extname(full)]) {
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

/** roomId -> Set<WebSocket>; in memory only. */
const rooms = new Map();

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function leave(ws) {
  const room = ws.roomId && rooms.get(ws.roomId);
  if (!room) return;
  room.delete(ws);
  for (const peer of room) send(peer, { type: 'peer-left' });
  if (room.size === 0) rooms.delete(ws.roomId);
  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.window = { start: Date.now(), count: 0 };

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    // Flood limit.
    const now = Date.now();
    if (now - ws.window.start > 10_000) ws.window = { start: now, count: 0 };
    if (++ws.window.count > MAX_MSGS_PER_10S) return ws.close(1008, 'rate limit');
    if (isBinary) return ws.close(1003, 'text only');

    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return ws.close(1007, 'bad json'); }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (ws.roomId || typeof msg.room !== 'string' || !ROOM_ID_RE.test(msg.room)) {
        return send(ws, { type: 'error', reason: 'bad-room' });
      }
      let room = rooms.get(msg.room);
      if (!room) rooms.set(msg.room, (room = new Set()));
      if (room.size >= 2) return send(ws, { type: 'error', reason: 'room-full' });
      room.add(ws);
      ws.roomId = msg.room;
      send(ws, { type: 'joined', peers: room.size - 1 });
      for (const peer of room) if (peer !== ws) send(peer, { type: 'peer-joined' });
      return;
    }

    if (msg.type === 'relay') {
      const room = ws.roomId && rooms.get(ws.roomId);
      if (!room || typeof msg.data !== 'string') return;
      // Forward the opaque, already-encrypted payload. Nothing is stored.
      for (const peer of room) if (peer !== ws) send(peer, { type: 'relay', data: msg.data });
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
