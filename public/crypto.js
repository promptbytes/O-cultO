// O-cultO end-to-end encryption, built only on the browser's WebCrypto API.
//
// Scheme (v1):
//   * Each chat uses brand-new ECDH P-256 key pairs, made in memory when the
//     chat starts and thrown away when it ends (the private keys cannot be
//     exported). Closing the tab destroys them, which gives forward secrecy
//     per chat.
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

/** Make a new key pair. The private key cannot be exported. */
export async function newKeyPair() {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pubRaw, pub: b64u(pubRaw) };
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
