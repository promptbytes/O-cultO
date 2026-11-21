'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { server, rooms } = require('../server/server.js');

let url;
before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => {
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

const ROOM = 'abcdefghijklmnopqrstuvwx';

test('relays between two peers, rejects a third, forgets empty rooms', async () => {
  const a = await client();
  a.json({ type: 'join', room: ROOM });
  assert.deepStrictEqual(await a.next(), { type: 'joined', peers: 0 });

  const b = await client();
  b.json({ type: 'join', room: ROOM });
  assert.deepStrictEqual(await b.next(), { type: 'joined', peers: 1 });
  assert.deepStrictEqual(await a.next(), { type: 'peer-joined' });

  b.json({ type: 'relay', data: 'opaque-ciphertext' });
  assert.deepStrictEqual(await a.next(), { type: 'relay', data: 'opaque-ciphertext' });

  const c = await client();
  c.json({ type: 'join', room: ROOM });
  assert.deepStrictEqual(await c.next(), { type: 'error', reason: 'room-full' });

  b.close();
  assert.deepStrictEqual(await a.next(), { type: 'peer-left' });
  a.close();
  c.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(rooms.size, 0, 'no room should remain in memory');
});

test('rejects bad room ids', async () => {
  const a = await client();
  a.json({ type: 'join', room: '../etc' });
  assert.deepStrictEqual(await a.next(), { type: 'error', reason: 'bad-room' });
  a.close();
});
