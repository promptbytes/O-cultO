'use strict';

// Two real browsers have a whole chat through the relay, and we check that
// the relay only ever sees ciphertext.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
// Calls are off by default; switch them on here so they stay tested.
process.env.ENABLE_CALLS = '1';
const { server, wss } = require('../server/server.js');
const nodeCrypto = require('node:crypto');

// Use a local Playwright if installed, else the global one (cloud sessions
// come with it pre-installed). Without either, these tests are skipped.
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try {
    const globalRoot = require('node:child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    ({ chromium } = require(require('node:path').join(globalRoot, 'playwright')));
  } catch { /* not installed */ }
}

let base;
let browser;
const seenByServer = [];

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
  wss.on('connection', (ws) => ws.on('message', (d) => seenByServer.push(d.toString())));
  // A fake microphone, so voice calls can be tested for real.
  if (chromium) {
    browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
  }
});
after(async () => {
  await browser?.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => server.close(r));
});

const SKIP = { skip: !chromium && 'playwright not available' };

async function person() {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  return ctx.newPage();
}

const encrypted = '#conn-status:text("End-to-end encrypted")';

async function privateChat() {
  const alice = await person();
  const bob = await person();
  await alice.goto(base);
  await alice.click('#btn-new');
  await bob.goto(await alice.inputValue('#invite-link'));
  for (const p of [alice, bob]) await p.waitForSelector(encrypted);
  return { alice, bob };
}

async function joinGroup(page, link, name) {
  await page.goto(link);
  await page.fill('#name-input', name);
  await page.click('#name-form button');
  await page.waitForSelector('#view-chat:not([hidden])');
}

/** True once this page has live, flowing audio from `count` other people. */
async function hearing(page, count) {
  await page.waitForFunction(async (n) => {
    const audios = [...document.querySelectorAll('#call-audio audio')];
    if (audios.length !== n) return false;
    return audios.every((a) => a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live'));
  }, count);
  await page.waitForSelector(`#call-text:text("connected to ${count}")`);
}

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

test('the invite QR code decodes to the invite link and opens the chat', { skip: !chromium && 'playwright not available' }, async () => {
  const jsQR = require('jsqr');
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();

  await alice.goto(base);
  await alice.click('#btn-new');
  const link = await alice.inputValue('#invite-link');

  // Read the pixels the user would point a camera at, and decode them.
  const { width, height, data } = await alice.evaluate(() => {
    const c = document.getElementById('invite-qr');
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { width: img.width, height: img.height, data: Array.from(img.data) };
  });
  const decoded = jsQR(Uint8ClampedArray.from(data), width, height);
  assert.ok(decoded, 'QR code should be readable');
  assert.strictEqual(decoded.data, link);

  // "Scanning" it opens a working chat.
  await bob.goto(decoded.data);
  for (const p of [alice, bob]) await p.waitForSelector('#conn-status:text("End-to-end encrypted")');
});

test('a group of three chats, sees names, and the server only sees ciphertext', SKIP, async () => {
  const ana = await person();
  await ana.goto(base);
  await ana.click('#btn-new-group');
  await ana.fill('#name-input', 'Ana');
  await ana.click('#name-form button');
  await ana.waitForSelector('#group-invite-panel:not([hidden])');
  const link = await ana.inputValue('#group-link');
  assert.match(link, /#g=[\w-]+&s=[\w-]+$/);

  const ben = await person();
  const cy = await person();
  await joinGroup(ben, link, 'Ben');
  await joinGroup(cy, link, 'Cy');
  await ben.waitForFunction(() => location.hash === '');

  for (const p of [ana, ben, cy]) {
    await p.waitForSelector('#conn-status:text("3 people")');
  }
  const status = await ana.textContent('#conn-status');
  assert.match(status, /Ben/);
  assert.match(status, /Cy/);

  const secret = 'the eagle lands at dawn';
  await ben.fill('#msg-input', secret);
  await ben.click('#btn-send');
  for (const p of [ana, cy]) {
    await p.waitForSelector(`.msg.them:has-text("${secret}")`);
    assert.strictEqual(await p.textContent('.msg.them .sender'), 'Ben');
  }
  const wire = seenByServer.join('\n');
  assert.ok(!wire.includes('eagle'), 'server must never see plaintext');
  assert.ok(!wire.includes('"Ben"'), 'server must never see names');
  assert.ok(!wire.includes(link.split('&s=')[1]), 'server must never see the group secret');

  await cy.click('#btn-end');
  await ana.waitForSelector('.note:has-text("Cy left")');
  await ana.waitForSelector('#conn-status:text("2 people")');
});

test('voice call in a private chat: both sides hear each other', SKIP, async () => {
  const { alice, bob } = await privateChat();
  await alice.click('#btn-call');
  // Bob sees the incoming call and joins.
  await bob.waitForSelector('#btn-call-join:not([hidden])');
  await bob.click('#btn-call-join');
  await hearing(alice, 1);
  await hearing(bob, 1);

  // Mute switches the microphone track off.
  await alice.click('#btn-mute');
  await alice.waitForSelector('#btn-mute:text("Unmute")');

  // Call set-up goes through the encrypted channel too.
  const wire = seenByServer.join('\n');
  assert.ok(!wire.includes('a=fingerprint'), 'server must never see call set-up (SDP)');
  assert.ok(!wire.includes('candidate:'), 'server must never see network candidates');

  await bob.click('#btn-hangup');
  await alice.waitForSelector('#call-text:text("waiting for others")');
  assert.strictEqual(await alice.locator('#call-audio audio').count(), 0);
  await alice.click('#btn-hangup');
  await alice.waitForSelector('#call-bar', { state: 'hidden' });
});

test('voice call in a group of three: everyone hears everyone', SKIP, async () => {
  const ana = await person();
  await ana.goto(base);
  await ana.click('#btn-new-group');
  await ana.fill('#name-input', 'Ana');
  await ana.click('#name-form button');
  const link = await ana.inputValue('#group-link');
  const ben = await person();
  const cy = await person();
  await joinGroup(ben, link, 'Ben');
  await joinGroup(cy, link, 'Cy');
  for (const p of [ana, ben, cy]) await p.waitForSelector('#conn-status:text("3 people")');

  await ana.click('#btn-call');
  await ben.waitForSelector('#btn-call-join:not([hidden])');
  await ben.click('#btn-call-join');
  await cy.waitForSelector('#btn-call-join:not([hidden])');
  await cy.click('#btn-call-join');
  for (const p of [ana, ben, cy]) await hearing(p, 2);
});

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function downloadedBytes(page, locator) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(locator)]);
  return require('node:fs').readFileSync(await dl.path());
}

test('files: photos show inline, other files download intact, and stay encrypted', SKIP, async () => {
  const { alice, bob } = await privateChat();

  // A photo appears inside the chat.
  await alice.setInputFiles('#file-input', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await bob.waitForFunction(() => {
    const img = document.querySelector('.msg.them img.media');
    return img && img.complete && img.naturalWidth === 1;
  });
  assert.deepStrictEqual(await downloadedBytes(bob, '.msg.them a.file-save'), PNG);

  // A 3 MB file arrives byte for byte (many pieces).
  const big = nodeCrypto.randomBytes(3 * 1024 * 1024 + 123);
  await alice.setInputFiles('#file-input', { name: 'archive.bin', mimeType: 'application/octet-stream', buffer: big });
  const link = bob.locator('.msg.them a.file-save', { hasText: 'archive.bin' });
  await link.waitFor({ timeout: 60000 });
  const got = await downloadedBytes(bob, '.msg.them a.file-save:has-text("archive.bin")');
  assert.strictEqual(nodeCrypto.createHash('sha256').update(got).digest('hex'),
    nodeCrypto.createHash('sha256').update(big).digest('hex'));

  // An HTML file is never shown inside the page, only offered as a download.
  const secret = 'TOP-SECRET-PLAN-' + nodeCrypto.randomBytes(6).toString('hex');
  await alice.setInputFiles('#file-input', { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from(`<script>alert(1)</script>${secret}`) });
  await bob.locator('.msg.them a.file-save', { hasText: 'page.html' }).waitFor();
  assert.strictEqual(await bob.locator('iframe, .msg.them object, .msg.them embed').count(), 0);

  // The server never saw the file contents.
  const wire = seenByServer.join('\n');
  assert.ok(!wire.includes(secret));
  assert.ok(!wire.includes(Buffer.from(secret).toString('base64').slice(0, 16)));
  assert.ok(!wire.includes('archive.bin'), 'file names are encrypted too');

  // Too-big files are refused before anything is sent.
  await alice.setInputFiles('#file-input', { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(26 * 1024 * 1024, 1) });
  await alice.waitForSelector('.msg.me .file.failed:has-text("too big")');
});

test('voice messages: record in the app and play on the other side', SKIP, async () => {
  const { alice, bob } = await privateChat();
  await alice.click('#btn-record');
  await alice.waitForSelector('#recorder:not([hidden])');
  await alice.waitForSelector('#rec-time:text("0:01")', { timeout: 5000 });
  await alice.click('#btn-rec-send');
  await alice.waitForSelector('#composer:not([hidden])');

  await bob.waitForSelector('.msg.them audio.media', { timeout: 20000 });
  assert.match(await bob.textContent('.msg.them'), /Voice message · 0:0[1-3]/);
  const ok = await bob.waitForFunction(() => {
    const a = document.querySelector('.msg.them audio.media');
    return a && a.src.startsWith('blob:') && a.readyState >= 1 && a.duration > 0.5;
  }, null, { timeout: 15000 });
  assert.ok(ok);
  // The sender sees their own voice message too.
  await alice.waitForSelector('.msg.me audio.media');

  // Cancelling sends nothing.
  await alice.click('#btn-record');
  await alice.waitForSelector('#recorder:not([hidden])');
  await alice.click('#btn-rec-cancel');
  await alice.waitForSelector('#composer:not([hidden])');
  await bob.waitForTimeout(500);
  assert.strictEqual(await bob.locator('.msg.them audio.media').count(), 1);
});

test('files in a group reach everyone with the sender name', SKIP, async () => {
  const ana = await person();
  await ana.goto(base);
  await ana.click('#btn-new-group');
  await ana.fill('#name-input', 'Ana');
  await ana.click('#name-form button');
  const link = await ana.inputValue('#group-link');
  const ben = await person();
  const cy = await person();
  await joinGroup(ben, link, 'Ben');
  await joinGroup(cy, link, 'Cy');
  for (const p of [ana, ben, cy]) await p.waitForSelector('#conn-status:text("3 people")');

  await ben.setInputFiles('#file-input', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  for (const p of [ana, cy]) {
    await p.waitForSelector('.msg.them img.media');
    assert.strictEqual(await p.textContent('.msg.them .sender'), 'Ben');
  }
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
