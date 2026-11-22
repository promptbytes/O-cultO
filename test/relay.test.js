'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { server, rooms } = require('../server/server.js');

let base;
let url;
before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  url = `ws://127.0.0.1:${server.address().port}/ws`;
  r();
})));
after(() => new Promise((r) => server.close(r)));

function client() {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const w = waiters.shift();
    w ? w(m) : queue.push(m);
  });
  ws.next = () => new Promise((r) => (queue.length ? r(queue.shift()) : waiters.push(r)));
  ws.json = (o) => ws.send(JSON.stringify(o));
  return new Promise((r) => ws.on('open', () => r(ws)));
}

const room = (c) => c.repeat(24);
const settle = () => new Promise((r) => setTimeout(r, 50));

test('private room: relays between two peers, rejects a third, forgets empty rooms', async () => {
  const a = await client();
  a.json({ type: 'join', room: room('a') });
  const ja = await a.next();
  assert.strictEqual(ja.type, 'joined');
  assert.deepStrictEqual(ja.peers, []);

  const b = await client();
  b.json({ type: 'join', room: room('a') });
  const jb = await b.next();
  assert.deepStrictEqual(jb.peers, [ja.id]);
  assert.deepStrictEqual(await a.next(), { type: 'peer-joined', id: jb.id });

  b.json({ type: 'relay', data: 'opaque-ciphertext' });
  assert.deepStrictEqual(await a.next(), { type: 'relay', from: jb.id, data: 'opaque-ciphertext' });

  const c = await client();
  c.json({ type: 'join', room: room('a') });
  assert.deepStrictEqual(await c.next(), { type: 'error', reason: 'room-full' });

  b.close();
  assert.deepStrictEqual(await a.next(), { type: 'peer-left', id: jb.id });
  a.close();
  c.close();
  await settle();
  assert.strictEqual(rooms.size, 0, 'no room should remain in memory');
});

test('group room: up to 8 people, broadcast and targeted relay', async () => {
  const peers = [];
  for (let i = 0; i < 8; i++) {
    const p = await client();
    p.json({ type: 'join', room: room('g'), mode: 'group' });
    p.info = await p.next();
    assert.strictEqual(p.info.type, 'joined');
    assert.strictEqual(p.info.peers.length, i);
    for (const q of peers) assert.deepStrictEqual(await q.next(), { type: 'peer-joined', id: p.info.id });
    peers.push(p);
  }

  const ninth = await client();
  ninth.json({ type: 'join', room: room('g'), mode: 'group' });
  assert.deepStrictEqual(await ninth.next(), { type: 'error', reason: 'room-full' });

  // A private-chat join can't sneak into a group room.
  const wrong = await client();
  wrong.json({ type: 'join', room: room('g'), mode: 'pair' });
  assert.deepStrictEqual(await wrong.next(), { type: 'error', reason: 'bad-room' });

  // Broadcast reaches all 7 others.
  peers[0].json({ type: 'relay', data: 'to-all' });
  for (const q of peers.slice(1)) {
    assert.deepStrictEqual(await q.next(), { type: 'relay', from: peers[0].info.id, data: 'to-all' });
  }

  // Targeted reaches only the one person.
  peers[1].json({ type: 'relay', data: 'just-you', to: peers[2].info.id });
  assert.deepStrictEqual(await peers[2].next(), { type: 'relay', from: peers[1].info.id, data: 'just-you' });
  peers[3].json({ type: 'relay', data: 'marker' });
  assert.strictEqual((await peers[4].next()).data, 'marker', 'peer 4 must not have received the targeted message');

  for (const p of [...peers, ninth, wrong]) p.close();
  await settle();
  assert.strictEqual(rooms.size, 0);
});

test('a rejoin token replaces a dead connection instead of being refused', async () => {
  const a = await client();
  a.json({ type: 'join', room: room('r') });
  const ja = await a.next();
  assert.match(ja.resume, /^[\w-]{16,}$/);
  const b = await client();
  b.json({ type: 'join', room: room('r') });
  const jb = await b.next();
  await a.next(); // peer-joined

  // Bob's phone pauses: his old connection lingers. A new one with his token
  // takes its place (without the token the room would be full).
  const stranger = await client();
  stranger.json({ type: 'join', room: room('r'), resume: 'not-the-right-token-at-all' });
  assert.deepStrictEqual(await stranger.next(), { type: 'error', reason: 'room-full' });

  const b2 = await client();
  b2.json({ type: 'join', room: room('r'), resume: jb.resume });
  const jb2 = await b2.next();
  assert.strictEqual(jb2.type, 'joined');
  assert.deepStrictEqual(jb2.peers, [ja.id]);
  assert.notStrictEqual(jb2.resume, jb.resume, 'a fresh token each time');
  assert.deepStrictEqual(await a.next(), { type: 'peer-left', id: jb.id });
  assert.deepStrictEqual(await a.next(), { type: 'peer-joined', id: jb2.id });
  await new Promise((r) => b.once('close', r)); // the old one was cut

  b2.json({ type: 'relay', data: 'hi' });
  assert.deepStrictEqual(await a.next(), { type: 'relay', from: jb2.id, data: 'hi' });
  for (const c of [a, b2, stranger]) c.close();
  await settle();
});

test('rejects bad room ids', async () => {
  const a = await client();
  a.json({ type: 'join', room: '../etc' });
  assert.deepStrictEqual(await a.next(), { type: 'error', reason: 'bad-room' });
  a.close();
});

test('serves call config and strict security headers', async () => {
  const res = await fetch(base + '/config.json');
  // Calls are switched off unless the operator turns them on.
  const config = await res.json();
  assert.match(config.build, /^[0-9a-f]{12}$/, 'a build fingerprint so old pages can update');
  assert.deepStrictEqual({ ...config, build: undefined }, { build: undefined, calls: false, iceServers: [] });
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
  assert.strictEqual(page.headers.get('cache-control'), 'no-store');
  assert.strictEqual((await fetch(base + '/../package.json')).status, 404);

  // Behind a hosting proxy, the public host is used, not the internal one.
  const proxied = await new Promise((resolve) => {
    require('node:http').get(base + '/', { headers: { host: '10.0.0.5:3000', 'x-forwarded-host': 'chat.example.org' } }, resolve);
  });
  assert.match(proxied.headers['content-security-policy'], /wss:\/\/chat\.example\.org[ ;]/);
  assert.doesNotMatch(proxied.headers['content-security-policy'], /10\.0\.0\.5/);
  proxied.resume();

  // Junk in the header can't reach the policy.
  const evil = await new Promise((resolve) => {
    require('node:http').get(base + '/', { headers: { 'x-forwarded-host': "x; script-src *" } }, resolve);
  });
  assert.doesNotMatch(evil.headers['content-security-policy'], /script-src \*/);
  evil.resume();
});
