'use strict';

// Two real browsers have a whole chat through the relay, and we check that
// the relay only ever sees ciphertext.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { server, wss } = require('../server/server.js');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }

let base;
let browser;
const seenByServer = [];

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
  wss.on('connection', (ws) => ws.on('message', (d) => seenByServer.push(d.toString())));
  if (chromium) browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => server.close(r));
});

test('two people chat end to end, and the server only sees ciphertext', { skip: !chromium && 'playwright not available' }, async () => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();

  await alice.goto(base);
  await alice.click('#btn-new');
  const link = await alice.inputValue('#invite-link');
  assert.match(link, /#r=[\w-]+&k=[\w-]+$/);

  await bob.goto(link);
  // The invite is taken out of Bob's address bar.
  await bob.waitForFunction(() => location.hash === '');

  for (const p of [alice, bob]) {
    await p.waitForSelector('#conn-status:text("End-to-end encrypted")');
  }

  // Both see the same safety code.
  const codeA = await alice.textContent('#safety-code');
  const codeB = await bob.textContent('#safety-code');
  assert.match(codeA, /^\d{5}( \d{5}){5}$/);
  assert.strictEqual(codeA, codeB);

  const secret = 'meet at the old oak tree at midnight';
  await alice.fill('#msg-input', secret);
  await alice.click('#btn-send');
  await bob.waitForSelector(`.msg.them:has-text("${secret}")`);

  await bob.fill('#msg-input', 'see you there');
  await bob.press('#msg-input', 'Enter');
  await alice.waitForSelector('.msg.them:has-text("see you there")');

  const wire = seenByServer.join('\n');
  assert.ok(!wire.includes('old oak'), 'server must never see plaintext');
  assert.ok(!wire.includes('see you there'), 'server must never see plaintext');

  // Nothing written to browser storage.
  for (const p of [alice, bob]) {
    const stored = await p.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length);
    assert.strictEqual(stored, 0);
  }

  // Ending wipes both sides.
  await alice.click('#btn-end');
  await bob.waitForSelector('#view-ended:not([hidden])');
  assert.strictEqual(await bob.locator('.msg').count(), 0);
  assert.strictEqual(await alice.locator('.msg').count(), 0);
});

test('a used link cannot be opened by a third person', { skip: !chromium && 'playwright not available' }, async () => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const eve = await (await browser.newContext()).newPage();

  await alice.goto(base);
  await alice.click('#btn-new');
  const link = await alice.inputValue('#invite-link');
  await bob.goto(link);
  await bob.waitForSelector('#conn-status:text("End-to-end encrypted")');

  await eve.goto(link);
  await eve.waitForSelector('#ended-title:text("Chat is full")');
});
