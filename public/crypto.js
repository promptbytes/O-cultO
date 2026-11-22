// O-cultO end-to-end encryption, built only on the browser's WebCrypto API.
//
// Scheme (v1):
//   * Each chat uses brand-new ECDH P-256 key pairs, made when the chat
//     starts and thrown away when it ends. While the chat is open, a copy is
//     kept in this tab's sessionStorage, so the chat survives the phone
//     pausing or reloading the page when you switch apps. Ending the chat or
//     closing the tab destroys it, which gives forward secrecy per chat.
//   * shared = ECDH(myPrivate, theirPublic)
//   * Two AES-256-GCM keys come from HKDF-SHA256(shared, salt = room id),
//     one for each direction ("a2b" and "b2a").
//   * Every message has a random 96-bit IV and a counter. The counter is
//     bound into the GCM additional data together with the room and the
//     direction, so replayed, reordered or reflected messages are rejected.
//   * The safety code is a hash of both public keys. Comparing it out of band
//     (in person, or on a call) proves no one sits in the middle.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomId(bytes = 18) {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

/**
 * Make a new key pair. `jwk` is the private key in a form that can be kept
 * in the tab's session cache; the CryptoKey used for maths can't be exported.
 */
export async function newKeyPair() {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { ...(await importKeyPair(jwk, b64u(pubRaw))) };
}

/** Rebuild a key pair from the session cache. */
export async function importKeyPair(jwk, pub) {
  const privateKey = await crypto.subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);
  const pubRaw = unb64u(pub);
  if (pubRaw.length !== 65 || pubRaw[0] !== 4) throw new Error('bad public key');
  return { privateKey, jwk, pubRaw, pub };
}

async function importPeerPublic(pubB64) {
  const raw = unb64u(pubB64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad public key');
  return crypto.subtle.importKey('raw', raw, ECDH, false, []);
}

/**
 * Work out the session keys.
 * role: 'a' (made the chat) or 'b' (joined it).
 */
export async function deriveSession({ privateKey, myPubRaw, peerPub, role, room }) {
  const peerKey = await importPeerPublic(peerPub);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const mk = (info) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('O-cultO v1 ' + room), info: enc.encode(info) },
      hk,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const [a2b, b2a] = await Promise.all([mk('a2b'), mk('b2a')]);
  const sendDir = role === 'a' ? 'a2b' : 'b2a';
  const recvDir = role === 'a' ? 'b2a' : 'a2b';

  return {
    sendKey: role === 'a' ? a2b : b2a,
    recvKey: role === 'a' ? b2a : a2b,
    sendDir,
    recvDir,
    room,
    sendCounter: 0,
    lastRecv: -1,
    safetyCode: await safetyCode(myPubRaw, unb64u(peerPub)),
  };
}

function aad(room, dir, n) {
  return enc.encode(`O-cultO v1|${room}|${dir}|${n}`);
}

/** Encrypt a JSON value. Returns a string that is safe to send to the relay. */
export async function seal(session, value) {
  const n = session.sendCounter++;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(session.room, session.sendDir, n) },
    session.sendKey,
    enc.encode(JSON.stringify(value)),
  );
  return JSON.stringify({ k: 'm', n, iv: b64u(iv), ct: b64u(ct) });
}

/** Decrypt a { k:'m' } envelope. Throws if it was tampered with, replayed or reordered. */
export async function open(session, env) {
  if (!Number.isSafeInteger(env.n) || env.n <= session.lastRecv) throw new Error('replay');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(env.iv), additionalData: aad(session.room, session.recvDir, env.n) },
    session.recvKey,
    unb64u(env.ct),
  );
  session.lastRecv = env.n;
  return JSON.parse(dec.decode(pt));
}

/** A 30-digit code (6 groups of 5) that both people should see the same. */
export async function safetyCode(pubA, pubB) {
  const [x, y] = [pubA, pubB].sort((p, q) => {
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i];
    return 0;
  });
  const buf = new Uint8Array(x.length + y.length);
  buf.set(x, 0);
  buf.set(y, x.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  const groups = [];
  for (let i = 0; i < 6; i++) {
    const v = ((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0;
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ---------------------------------------------------------------------------
// Group chats (v1)
//
//   * The person who starts the group makes a random 256-bit group secret.
//     It travels only inside the invite link's #fragment or QR code, which
//     are never sent to the server.
//   * The AES-256-GCM key comes from HKDF-SHA256(secret, salt = room id).
//   * Each person picks a random sender id for this session. Every message
//     carries the sender id and a counter, both bound into the GCM additional
//     data, so messages can't be replayed, reordered or moved to another room.
//   * Anyone holding the link can read the group. Share it only with the
//     people you mean to invite (showing the QR code in person is best).
// ---------------------------------------------------------------------------

export function newGroupSecret() {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveGroup({ secret, room }) {
  const raw = unb64u(secret);
  if (raw.length !== 32) throw new Error('bad group secret');
  const hk = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('O-cultO group v1 ' + room), info: enc.encode('group') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, room, sid: randomId(12), sendCounter: 0, lastRecv: new Map() };
}

function groupAad(room, sid, n) {
  return enc.encode(`O-cultO group v1|${room}|${sid}|${n}`);
}

export async function sealGroup(g, value) {
  const n = g.sendCounter++;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: groupAad(g.room, g.sid, n) },
    g.key,
    enc.encode(JSON.stringify(value)),
  );
  return JSON.stringify({ k: 'g', s: g.sid, n, iv: b64u(iv), ct: b64u(ct) });
}

/** Returns { sid, body }. Throws if tampered with, replayed or reordered. */
export async function openGroup(g, env) {
  if (typeof env.s !== 'string' || env.s === g.sid || !Number.isSafeInteger(env.n)) throw new Error('bad');
  const last = g.lastRecv.has(env.s) ? g.lastRecv.get(env.s) : -1;
  if (env.n <= last) throw new Error('replay');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(env.iv), additionalData: groupAad(g.room, env.s, env.n) },
    g.key,
    unb64u(env.ct),
  );
  g.lastRecv.set(env.s, env.n);
  return { sid: env.s, body: JSON.parse(dec.decode(pt)) };
}
