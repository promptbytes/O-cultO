'use strict';

// Two real browsers have a whole chat through the relay, and we check that
// the relay only ever sees ciphertext.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
// Calls are off by default; switch them on here so they stay tested.
process.env.ENABLE_CALLS = '1';
const { server, wss, rooms } = require('../server/server.js');
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

  // Messages are never written to browser storage. Only the chat's keys sit
  // in this tab's session cache while the chat is open.
  for (const p of [alice, bob]) {
    const store = await p.evaluate(() => ({
      local: localStorage.length,
      cookies: document.cookie.length,
      keys: Object.keys(sessionStorage),
      text: JSON.stringify(sessionStorage),
    }));
    assert.strictEqual(store.local, 0);
    assert.strictEqual(store.cookies, 0);
    assert.deepStrictEqual(store.keys, ['oculto.chat.v1']);
    assert.ok(!store.text.includes('old oak') && !store.text.includes('see you there'), 'no message text in storage');
  }

  // Ending wipes both sides, including the session cache.
  await alice.click('#btn-end');
  await bob.waitForSelector('#view-ended:not([hidden])');
  for (const p of [alice, bob]) assert.strictEqual(await p.evaluate(() => sessionStorage.length), 0);
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

test('typing dots: show while typing, hide on send, clear or pause', SKIP, async () => {
  const { alice, bob } = await privateChat();
  const dots = '.msg.typing';

  // Typing shows the bubble with three animated dots on the other side.
  await alice.type('#msg-input', 'hel');
  await bob.waitForSelector(dots);
  assert.strictEqual(await bob.locator(`${dots} .dots i`).count(), 3);
  assert.strictEqual(await alice.locator(dots).count(), 0, 'you never see your own dots');
  assert.notStrictEqual(await bob.$eval(`${dots} .dots i`, (el) => getComputedStyle(el).animationName), 'none');

  // Sending removes it as the message arrives, and it stays below messages.
  await alice.type('#msg-input', 'lo');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("hello")');
  await bob.waitForSelector(dots, { state: 'detached' });

  // Clearing the box removes it.
  await alice.type('#msg-input', 'wait');
  await bob.waitForSelector(dots);
  await bob.fill('#msg-input', 'x'); // Bob typing doesn't hide Alice's dots
  await alice.fill('#msg-input', '');
  await alice.dispatchEvent('#msg-input', 'input');
  await bob.waitForSelector(dots, { state: 'detached' });

  // A pause counts as stopped.
  await alice.type('#msg-input', 'thinking');
  await bob.waitForSelector(dots);
  await bob.waitForSelector(dots, { state: 'detached', timeout: 8000 });

  // A new message keeps the dots at the very bottom.
  await alice.type('#msg-input', 'again');
  await bob.waitForSelector(dots);
  await bob.fill('#msg-input', 'meanwhile');
  await bob.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.me:has-text("meanwhile")');
  assert.ok(await bob.$eval('#messages', (ul) => ul.lastElementChild.classList.contains('typing')));

  // The relay only ever saw ciphertext.
  assert.ok(!seenByServer.join('\n').includes('typing'));
});

test('typing dots in a group say who is typing', SKIP, async () => {
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

  await ben.type('#msg-input', 'hi');
  await ana.waitForSelector('.msg.typing .sender:text("Ben is typing")');
  await cy.type('#msg-input', 'yo');
  await ana.waitForSelector('.msg.typing .sender:text("Ben and Cy are typing")');
  await ben.press('#msg-input', 'Enter');
  await ana.waitForSelector('.msg.typing .sender:text("Cy is typing")');
});

// ---- staying alive when the phone pauses the app ----

/** Cut a person's connection on the server side, like a phone pausing the app. */
function dropConnection(roomId, index) {
  const room = rooms.get(roomId);
  assert.ok(room, 'room should exist');
  [...room.peers.values()][index].terminate();
}
/**
 * Reload like a phone that dropped a paused page from memory: the page gets
 * no chance to react, so it must recover from its session cache.
 */
async function silentReload(page) {
  await page.reload();
}

/** A person whose page never hears that it is being unloaded (see silentReload). */
async function personWhosePhoneDiscardsPages() {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    const add = window.addEventListener;
    window.addEventListener = function (type, ...rest) {
      if (type === 'pagehide') return undefined;
      return add.call(this, type, ...rest);
    };
  });
  return ctx.newPage();
}
const roomOf = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get('r');

test('an invite link keeps working after the creator switches apps', SKIP, async () => {
  const alice = await person();
  const bob = await person();
  await alice.goto(base);
  await alice.click('#btn-new');
  const link = await alice.inputValue('#invite-link');
  await alice.waitForSelector('#invite-status:text("Waiting for them")');

  // Alice "goes to WhatsApp": her connection dies. The app reconnects.
  dropConnection(roomOf(link), 0);
  await alice.waitForSelector('#invite-status:text("Reconnecting")');
  await alice.waitForSelector('#invite-status:text("Waiting for them")', { timeout: 10000 });

  // Bob opens the link afterwards and it works.
  await bob.goto(link);
  for (const p of [alice, bob]) await p.waitForSelector(encrypted);
  await bob.fill('#msg-input', 'got your link');
  await bob.press('#msg-input', 'Enter');
  await alice.waitForSelector('.msg.them:has-text("got your link")');
});

test('an invite link keeps working even if the phone reloads the page meanwhile', SKIP, async () => {
  const alice = await personWhosePhoneDiscardsPages();
  const bob = await person();
  await alice.goto(base);
  await alice.click('#btn-new');
  const link = await alice.inputValue('#invite-link');
  await alice.waitForSelector('#invite-status:text("Waiting for them")');

  await silentReload(alice);
  await alice.waitForSelector('#view-invite:not([hidden])');
  assert.strictEqual(await alice.inputValue('#invite-link'), link, 'same link after the reload');
  await alice.waitForSelector('#invite-status:text("Waiting for them")');

  await bob.goto(link);
  for (const p of [alice, bob]) await p.waitForSelector(encrypted);
  await alice.fill('#msg-input', 'it still works');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("it still works")');
});

test('a chat carries on when the other person briefly drops off', SKIP, async () => {
  const alice = await person();
  const bob = await person();
  await alice.goto(base);
  await alice.click('#btn-new');
  const link = await alice.inputValue('#invite-link');
  await bob.goto(link);
  for (const p of [alice, bob]) await p.waitForSelector(encrypted);
  await alice.fill('#msg-input', 'before');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("before")');

  // Bob's phone pauses the app. Alice waits instead of ending the chat.
  dropConnection(roomOf(link), 1);
  await alice.waitForSelector('#conn-status:text("offline")');
  assert.ok(await alice.isDisabled('#btn-send'), 'cannot send while they are away');
  assert.ok(await alice.isVisible('#view-chat'), 'chat is still open');

  // Bob comes back (the app reconnects by itself) and both carry on.
  for (const p of [alice, bob]) await p.waitForSelector(encrypted, { timeout: 10000 });
  await bob.fill('#msg-input', 'after');
  await bob.press('#msg-input', 'Enter');
  await alice.waitForSelector('.msg.them:has-text("after")');
  await alice.fill('#msg-input', 'welcome back');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("welcome back")');
  // Earlier messages are still on screen (the page wasn't reloaded).
  assert.strictEqual(await bob.locator('.msg.them:has-text("before")').count(), 1);
});

test('both connections dropping at once does not end the chat', SKIP, async () => {
  const { alice, bob } = await privateChat();
  for (const ws of wss.clients) ws.terminate();
  for (const p of [alice, bob]) await p.waitForSelector(encrypted, { timeout: 15000 });
  await alice.fill('#msg-input', 'still here');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("still here")');
});

test('a chat survives the phone reloading the page in the background', SKIP, async () => {
  const alice = await person();
  const bob = await personWhosePhoneDiscardsPages();
  await alice.goto(base);
  await alice.click('#btn-new');
  await bob.goto(await alice.inputValue('#invite-link'));
  for (const p of [alice, bob]) await p.waitForSelector(encrypted);
  await alice.fill('#msg-input', 'one');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("one")');

  // The OS throws the page out of memory (the app never hears about it),
  // then reloads it when Bob comes back.
  await silentReload(bob);
  await bob.waitForSelector('.note:has-text("Welcome back")');
  for (const p of [alice, bob]) await p.waitForSelector(encrypted, { timeout: 15000 });

  // Same keys, counters carry on: messages flow both ways.
  await bob.fill('#msg-input', 'two');
  await bob.press('#msg-input', 'Enter');
  await alice.waitForSelector('.msg.them:has-text("two")');
  await alice.fill('#msg-input', 'three');
  await alice.press('#msg-input', 'Enter');
  await bob.waitForSelector('.msg.them:has-text("three")');
  // Earlier messages were never stored, so they're gone after the reload.
  assert.strictEqual(await bob.locator('.msg:has-text("one")').count(), 0);
});

test('a group survives a member reloading, and says they are back', SKIP, async () => {
  const ana = await person();
  await ana.goto(base);
  await ana.click('#btn-new-group');
  await ana.fill('#name-input', 'Ana');
  await ana.click('#name-form button');
  const link = await ana.inputValue('#group-link');
  const ben = await personWhosePhoneDiscardsPages();
  await joinGroup(ben, link, 'Ben');
  for (const p of [ana, ben]) await p.waitForSelector('#conn-status:text("2 people")');

  await silentReload(ben);
  await ana.waitForSelector('.note:has-text("Ben is back")', { timeout: 20000 });
  await ben.fill('#msg-input', 'hello again');
  await ben.press('#msg-input', 'Enter');
  await ana.waitForSelector('.msg.them:has-text("hello again")');
  assert.strictEqual(await ana.textContent('.msg.them .sender'), 'Ben');
});

test('closing the tab still ends the chat for the other person right away', SKIP, async () => {
  const { alice, bob } = await privateChat();
  await bob.close({ runBeforeUnload: true });
  await alice.waitForSelector('#view-ended:not([hidden])', { timeout: 5000 });
  assert.match(await alice.textContent('#ended-text'), /ended the chat/);
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
