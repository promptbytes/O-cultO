import {
  newKeyPair, deriveSession, seal, open, randomId, b64u, unb64u,
  newGroupSecret, deriveGroup, sealGroup, openGroup,
} from './crypto.js';
import { Calls } from './calls.js';
import {
  MAX_FILE_BYTES, CHUNK_BYTES, blobType, cleanFileName, fileBubble, formatDuration, VoiceRecorder,
} from './media.js';

// Everything about the chat lives in this one object, in memory only.
// Nothing goes to localStorage, IndexedDB, cookies or the server.
let state = null;

const $ = (id) => document.getElementById(id);

// No pinch-zoom. The viewport tag and CSS (touch-action) handle most
// browsers and double-tap; iOS Safari ignores those for pinching, so its
// pinch gestures are cancelled here.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
const views = ['home', 'name', 'invite', 'chat', 'ended'];

function show(name) {
  for (const v of views) $('view-' + v).hidden = v !== name;
}

function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

// Server settings: whether voice calls are switched on, and the STUN/TURN
// servers they use. Calls are off unless the operator turns them on.
let iceServers = [];
let callsEnabled = false;
fetch('/config.json').then((r) => r.json()).then((c) => {
  callsEnabled = c.calls === true;
  if (Array.isArray(c.iceServers)) iceServers = c.iceServers;
  renderCall();
}).catch(() => {});

// ---------- lifecycle ----------

function wipe() {
  if (recorder.active) recorder.stop(false);
  showRecorder(false);
  if (state) {
    state.calls?.hangup({ silent: true });
    for (const url of state.urls) URL.revokeObjectURL(url);
    if (state.ws) {
      state.ws.onclose = null;
      try { state.ws.close(); } catch {}
    }
  }
  state = null;
  if (state) {
    clearTimeout(state.typingIdle);
    for (const t of state.typers.values()) clearTimeout(t);
  }
  typingEl = null;
  $('messages').replaceChildren();
  $('call-audio').replaceChildren();
  $('msg-input').value = '';
  $('msg-input').disabled = true;
  $('btn-send').disabled = true;
  $('btn-attach').disabled = true;
  $('btn-record').disabled = true;
  $('file-input').value = '';
  $('safety-code').textContent = '—';
  for (const id of ['verify-panel', 'group-invite-panel', 'call-bar']) $(id).hidden = true;
  for (const id of ['invite-link', 'group-link']) $(id).value = '';
  for (const id of ['invite-qr', 'group-qr']) clearQr($(id));
}

function end(title, text) {
  wipe();
  $('ended-title').textContent = title;
  $('ended-text').textContent = text;
  show('ended');
}

function newState(extra) {
  state = {
    ws: null,
    myId: null,
    peers: new Set(), // server ids of everyone else connected
    members: new Map(), // server id -> name (from their encrypted "hi")
    names: new Map(), // group sender id -> name
    ready: false,
    name: '',
    sendChain: Promise.resolve(),
    recvChain: Promise.resolve(),
    fileChain: Promise.resolve(), // outgoing files go one at a time
    incoming: new Map(), // "<from>:<id>" -> file being received
    typers: new Map(), // peer id -> timer that hides their "typing" dots
    typingOn: false, // whether we've told the others we're typing
    typingSentAt: 0,
    typingIdle: null,
    urls: [], // in-memory file links, revoked on wipe
    ...extra,
  };
  const s = state;
  s.calls = new Calls({
    myId: () => s.myId,
    sendTo: (id, body) => sendBody(body, id),
    broadcast: (body) => sendBody(body),
    onChange: renderCall,
    iceServers,
    audioHost: $('call-audio'),
  });
  s.calls.iceServers = iceServers;
  return s;
}

function connect() {
  const s = state;
  const ws = new WebSocket(wsUrl());
  s.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: s.room, mode: s.mode }));
  // Handle server events strictly in order: decryption is async, and calls
  // depend on offers arriving before their network candidates.
  ws.onmessage = (ev) => {
    s.recvChain = s.recvChain.then(() => (state === s ? handleServer(JSON.parse(ev.data)) : null)).catch(() => {});
  };
  ws.onclose = () => {
    if (state === s) end('Connection lost', 'The connection dropped, so the chat was wiped. Start a new one to keep talking.');
  };
}

function relay(data, to) {
  const msg = { type: 'relay', data };
  if (to) msg.to = to;
  if (state?.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

/** Encrypt and send, one at a time so counters arrive in order. */
function sendBody(body, to) {
  const s = state;
  if (!s) return Promise.resolve();
  s.sendChain = s.sendChain.then(async () => {
    if (state !== s) return;
    const data = s.mode === 'group' ? await sealGroup(s.group, body) : await seal(s.session, body);
    relay(data, to);
  }).catch(() => {});
  return s.sendChain;
}

// ---------- private chat: starting (person A) ----------

async function startChat() {
  wipe();
  const keys = await newKeyPair();
  newState({ mode: 'pair', role: 'a', room: randomId(), keys, session: null });
  // The public key goes in the #fragment, which browsers never send to the
  // server, so person B gets A's real key straight from A.
  const link = `${location.origin}/#r=${state.room}&k=${keys.pub}`;
  $('invite-link').value = link;
  drawQr($('invite-qr'), link);
  $('invite-status').textContent = 'Waiting for them to open it…';
  show('invite');
  connect();
}

// ---------- private chat: joining (person B) ----------

async function joinChat(room, peerPub) {
  wipe();
  const keys = await newKeyPair();
  newState({ mode: 'pair', role: 'b', room, keys, session: null });
  try {
    state.session = await deriveSession({
      privateKey: keys.privateKey, myPubRaw: keys.pubRaw, peerPub, role: 'b', room,
    });
  } catch {
    return end('Broken link', 'This invite link is damaged. Ask for a new one.');
  }
  openChatView();
  setConn('Connecting…', false);
  connect();
}

function sendHello() {
  relay(JSON.stringify({ k: 'hello', pub: state.keys.pub }));
}

// ---------- group chat ----------

let pendingGroup = null; // { room, secret, creating } while asking for a name

function askName(group) {
  wipe();
  pendingGroup = group;
  $('name-title').textContent = group.creating ? 'Start a group chat' : 'Join the group chat';
  $('name-input').value = '';
  show('name');
  $('name-input').focus();
}

async function enterGroup(name) {
  const { room, secret, creating } = pendingGroup;
  pendingGroup = null;
  let group;
  try {
    group = await deriveGroup({ secret, room });
  } catch {
    return end('Broken link', 'This group link is damaged. Ask for a new one.');
  }
  newState({ mode: 'group', room, secret, group, name });
  const link = `${location.origin}/#g=${room}&s=${secret}`;
  $('group-link').value = link;
  drawQr($('group-qr'), link);
  openChatView();
  $('group-invite-panel').hidden = !creating;
  setConn('Connecting…', false);
  connect();
}

// ---------- server events ----------

async function handleServer(msg) {
  const s = state;
  if (!s) return;

  if (msg.type === 'error') {
    if (msg.reason === 'room-full') {
      return end('Chat is full', s.mode === 'group'
        ? 'This group already has 8 people.'
        : 'This link has already been used by someone else. Ask for a new one.');
    }
    return end('Something went wrong', 'The chat could not start. Try a new one.');
  }

  if (msg.type === 'joined') {
    s.myId = msg.id;
    for (const id of msg.peers) s.peers.add(id);
    if (s.mode === 'group') {
      ready();
      sendBody({ t: 'hi', name: s.name, inCall: false });
    } else if (s.role === 'b') {
      if (msg.peers.length === 0) {
        setConn('The other person is not here. They may have closed their tab. Ask for a new link.', false);
      } else {
        sendHello();
        setConn('Securing…', false);
      }
    }
    return renderPeople();
  }

  if (msg.type === 'peer-joined') {
    s.peers.add(msg.id);
    if (s.mode === 'pair') {
      if (s.role === 'b') sendHello();
      if (s.role === 'a' && !s.session) $('invite-status').textContent = 'They opened it. Securing…';
    }
    return renderPeople();
  }

  if (msg.type === 'peer-left') {
    s.peers.delete(msg.id);
    for (const [key, t] of s.incoming) {
      if (t.from === msg.id) { t.ui.fail('the sender left before it arrived'); s.incoming.delete(key); }
    }
    s.calls.peerLeft(msg.id);
    setTyping(msg.id, false);
    if (s.mode === 'pair') {
      if (s.session) return end('Chat ended', 'The other person left. Every message has been wiped from this device.');
      if (s.role === 'a') $('invite-status').textContent = 'Waiting for them to open it…';
      return;
    }
    const name = s.members.get(msg.id);
    s.members.delete(msg.id);
    if (name) addNote(`${name} left`);
    return renderPeople();
  }

  if (msg.type === 'relay') {
    let env;
    try { env = JSON.parse(msg.data); } catch { return; }
    return handlePeer(msg.from, env);
  }
}

async function handlePeer(from, env) {
  const s = state;

  // Private chat: person A gets B's public key (only once).
  if (env.k === 'hello') {
    if (s.mode !== 'pair' || s.role !== 'a' || s.session || typeof env.pub !== 'string') return;
    try {
      s.session = await deriveSession({
        privateKey: s.keys.privateKey, myPubRaw: s.keys.pubRaw, peerPub: env.pub, role: 'a', room: s.room,
      });
    } catch { return; }
    await sendBody({ t: 'ready' });
    openChatView();
    ready();
    sendBody({ t: 'hi', name: '', inCall: false });
    return;
  }

  let body;
  let sid = null;
  try {
    if (s.mode === 'pair' && env.k === 'm' && s.session) body = await open(s.session, env);
    else if (s.mode === 'group' && env.k === 'g') ({ sid, body } = await openGroup(s.group, env));
    else return;
  } catch { return; } // tampered, replayed or not for us: drop it
  if (!body || typeof body.t !== 'string' || state !== s) return;

  switch (body.t) {
    case 'ready':
      if (s.mode === 'pair' && s.role === 'b' && !s.ready) {
        ready();
        sendBody({ t: 'hi', name: '', inCall: s.calls.inCall });
      }
      return;

    case 'hi': {
      const name = cleanName(body.name);
      const isNew = !s.members.has(from);
      s.members.set(from, name);
      if (sid) s.names.set(sid, name);
      s.calls.noteInCall(from, !!body.inCall);
      if (!body.reply) {
        // Tell the newcomer who we are.
        sendBody({ t: 'hi', name: s.name, inCall: s.calls.inCall, reply: true }, from);
        if (s.mode === 'group' && isNew) addNote(`${name} joined`);
      }
      return renderPeople();
    }

    case 'typing':
      return setTyping(from, body.on === true);

    case 'text':
      setTyping(from, false);
      if (typeof body.text === 'string') {
        const who = s.mode === 'group' ? (s.names.get(sid) || 'Someone') : null;
        addMessage(body.text.slice(0, 4000), 'them', who);
      }
      return;

    case 'file-start':
      setTyping(from, false);
      return receiveFile(from, sid, body);

    case 'file-chunk':
    case 'file-end':
    case 'file-cancel':
      return receiveFile(from, sid, body);

    case 'bye':
      if (s.mode === 'pair') end('Chat ended', 'The other person ended the chat. Every message has been wiped from this device.');
      return;

    default:
      if (body.t.startsWith('call-')) return s.calls.handle(from, body);
  }
}

function cleanName(n) {
  const name = typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return name || 'Guest';
}

// ---------- chat UI ----------

function openChatView() {
  const group = state.mode === 'group';
  $('chat-title').textContent = group ? 'Group chat' : 'Private chat';
  $('btn-verify').hidden = group;
  $('btn-invite').hidden = !group;
  $('btn-end').textContent = group ? 'Leave' : 'End';
  if (!group) $('safety-code').textContent = state.session.safetyCode;
  show('chat');
  renderCall();
}

function ready() {
  state.ready = true;
  for (const id of ['msg-input', 'btn-send', 'btn-attach', 'btn-record']) $(id).disabled = false;
  $('msg-input').focus();
  addNote(state.mode === 'group'
    ? 'Messages and files in this group are end-to-end encrypted and are not saved anywhere.'
    : 'Messages and files are end-to-end encrypted and are not saved anywhere. Tap Verify to check that no one is listening in.');
  renderPeople();
  renderCall();
}

function renderPeople() {
  const s = state;
  if (!s || !s.ready) return;
  if (s.mode === 'pair') return setConn('End-to-end encrypted', true);
  const total = s.peers.size + 1;
  const named = ['You', ...[...s.peers].filter((id) => s.members.has(id)).map((id) => s.members.get(id))];
  const unnamed = total - named.length;
  let text = `${total} ${total === 1 ? 'person' : 'people'}: ${named.join(', ')}`;
  if (unnamed > 0) text += ` + ${unnamed} connecting`;
  setConn(text, true);
}

function setConn(text, ok) {
  $('conn-status').textContent = text;
  $('conn-dot').classList.toggle('ok', ok);
}

function renderCall() {
  const s = state;
  const bar = $('call-bar');
  if (!s || !s.ready || !callsEnabled) {
    bar.hidden = true;
    $('btn-call').hidden = !callsEnabled;
    $('btn-call').disabled = true;
    return;
  }
  const c = s.calls;
  const othersInCall = [...c.remoteInCall].filter((id) => s.peers.has(id));
  $('btn-call').hidden = c.inCall;
  $('btn-call').disabled = false;
  $('btn-call').textContent = othersInCall.length ? 'Join call' : 'Call';

  if (c.inCall) {
    const states = c.states();
    const connected = states.filter((p) => p.state === 'connected').length;
    let text;
    if (states.length === 0) text = 'In call · waiting for others to join…';
    else if (connected === states.length) text = `In call · connected to ${connected} ${connected === 1 ? 'person' : 'people'}`;
    else text = `In call · connecting (${connected}/${states.length})…`;
    $('call-text').textContent = text;
    bar.dataset.state = connected > 0 ? 'connected' : 'connecting';
    $('btn-call-join').hidden = true;
    $('btn-mute').hidden = false;
    $('btn-mute').textContent = c.muted ? 'Unmute' : 'Mute';
    $('btn-hangup').hidden = false;
    bar.hidden = false;
  } else if (othersInCall.length) {
    $('call-text').textContent = `Call in progress · ${othersInCall.length} in call`;
    bar.dataset.state = 'ringing';
    $('btn-call-join').hidden = false;
    $('btn-mute').hidden = true;
    $('btn-hangup').hidden = true;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

async function startCall() {
  if (!state?.ready) return;
  state.calls.iceServers = iceServers;
  try {
    await state.calls.start();
  } catch {
    addNote('Could not use your microphone. Check that this site is allowed to use it.');
  }
}

/** A chat bubble with an optional sender name and a time. */
function bubble(who, sender) {
  const li = document.createElement('li');
  li.className = 'msg ' + who;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.append(time);
  if (sender) {
    const b = document.createElement('b');
    b.className = 'sender';
    b.textContent = sender;
    li.prepend(b);
  }
  $('messages').append(li);
  keepTypingLast();
  li.scrollIntoView({ block: 'end' });
  return li;
}

function addMessage(text, who, sender) {
  const li = bubble(who, sender);
  const p = document.createElement('span');
  p.textContent = text; // textContent, never innerHTML
  li.insertBefore(p, li.querySelector('time'));
}

// ---------- files, media and voice messages ----------

const MAX_INCOMING_BYTES = 100 * 1024 * 1024; // in memory at once, all senders
const MAX_INCOMING_PER_SENDER = 4;

/** Place a file bubble's content above its time stamp. */
function fileUi(li, meta) {
  const ui = fileBubble(li, meta, (url) => state?.urls.push(url));
  const box = li.querySelector('.file');
  li.insertBefore(box, li.querySelector('time'));
  return ui;
}

/** Wait until the connection has room, so big files don't flood it. */
async function waitForRoom(s) {
  await new Promise((r) => setTimeout(r, 30));
  while (state === s && s.ws.readyState === WebSocket.OPEN && s.ws.bufferedAmount > 512 * 1024) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Queue a file or recording to send. */
function sendFile(blob, { name, voice = false, duration = 0 } = {}) {
  const s = state;
  if (!s?.ready) return;
  const meta = { name: cleanFileName(name || blob.name), size: blob.size, mime: blobType(blob.type), voice, duration };
  const ui = fileUi(bubble('me'), meta);
  if (blob.size === 0) return ui.fail('the file is empty');
  if (blob.size > MAX_FILE_BYTES) return ui.fail('too big to send (the limit is 25 MB)');

  s.fileChain = s.fileChain.then(async () => {
    if (state !== s) return;
    const id = randomId(9);
    const chunks = Math.ceil(blob.size / CHUNK_BYTES);
    sendBody({ t: 'file-start', id, chunks, ...meta, duration: Math.round(duration) });
    for (let i = 0; i < chunks; i++) {
      await waitForRoom(s);
      if (state !== s) return;
      const piece = new Uint8Array(await blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
      await sendBody({ t: 'file-chunk', id, i, data: b64u(piece) });
      ui.progress((i + 1) / chunks);
    }
    await sendBody({ t: 'file-end', id });
    if (state === s) ui.done(new Blob([blob], { type: meta.mime }));
  }).catch(() => ui.fail('could not be sent'));
}

function receiveFile(from, sid, body) {
  const s = state;
  const key = `${from}:${body.id}`;
  const t = s.incoming.get(key);

  if (body.t === 'file-start') {
    if (typeof body.id !== 'string' || t) return;
    const size = Number(body.size);
    const chunks = Number(body.chunks);
    const sender = s.mode === 'group' ? (s.names.get(sid) || 'Someone') : null;
    const meta = {
      name: cleanFileName(body.name),
      size,
      mime: blobType(body.mime),
      voice: body.voice === true,
      duration: Number(body.duration) || 0,
    };
    const ui = fileUi(bubble('them', sender), meta);
    const inFlight = [...s.incoming.values()];
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES
        || chunks !== Math.ceil(size / CHUNK_BYTES)) {
      return ui.fail('refused (not a valid file)');
    }
    if (inFlight.filter((x) => x.from === from).length >= MAX_INCOMING_PER_SENDER
        || inFlight.reduce((n, x) => n + x.meta.size, 0) + size > MAX_INCOMING_BYTES) {
      return ui.fail('refused (too many files at once)');
    }
    s.incoming.set(key, { from, meta, chunks, next: 0, received: 0, parts: [], ui });
    return;
  }

  if (!t) return;

  if (body.t === 'file-chunk') {
    let piece;
    try { piece = unb64u(String(body.data)); } catch { piece = null; }
    // Pieces arrive in order (the channel enforces it); anything else is a fault.
    if (!piece || body.i !== t.next || t.received + piece.length > t.meta.size
        || (body.i < t.chunks - 1 && piece.length !== CHUNK_BYTES)) {
      t.ui.fail('arrived damaged');
      return s.incoming.delete(key);
    }
    t.parts.push(piece);
    t.next++;
    t.received += piece.length;
    t.ui.progress(t.next / t.chunks);
    return;
  }

  if (body.t === 'file-end') {
    s.incoming.delete(key);
    if (t.next !== t.chunks || t.received !== t.meta.size) return t.ui.fail('arrived incomplete');
    return t.ui.done(new Blob(t.parts, { type: t.meta.mime }));
  }

  if (body.t === 'file-cancel') {
    s.incoming.delete(key);
    t.ui.fail('cancelled by the sender');
  }
}

// Voice messages

const recorder = new VoiceRecorder({
  onTick: (sec) => { $('rec-time').textContent = formatDuration(sec); },
  onAutoStop: () => finishRecording(true),
});

function showRecorder(on) {
  $('recorder').hidden = !on;
  $('composer').hidden = on;
}

async function startRecording() {
  if (!state?.ready || recorder.active) return;
  try {
    await recorder.start();
    stopTyping();
    showRecorder(true);
  } catch {
    addNote('Could not use your microphone. Check that this site is allowed to use it.');
  }
}

async function finishRecording(send) {
  const s = state;
  showRecorder(false);
  const result = await recorder.stop(send);
  if (result && state === s) {
    const ext = result.blob.type.includes('mp4') ? 'm4a' : result.blob.type.includes('ogg') ? 'ogg' : 'webm';
    sendFile(result.blob, { name: `voice-message.${ext}`, voice: true, duration: result.duration });
  }
  $('msg-input').focus();
}

// ---------- "is typing" indicator ----------
//
// While you type, an encrypted { t: 'typing' } goes out at most every few
// seconds; it stops when you send, clear the box, or pause. The relay can't
// tell these apart from any other message.

const TYPING_RESEND_MS = 2500; // re-announce this often while typing
const TYPING_IDLE_MS = 4000; // a pause this long counts as stopped
const TYPING_SHOW_MS = 6000; // hide someone's dots if no update arrives

let typingEl = null;

function onTypingInput() {
  const s = state;
  if (!s?.ready) return;
  clearTimeout(s.typingIdle);
  if (!$('msg-input').value.trim()) return stopTyping();
  const now = Date.now();
  if (!s.typingOn || now - s.typingSentAt > TYPING_RESEND_MS) {
    s.typingOn = true;
    s.typingSentAt = now;
    sendBody({ t: 'typing', on: true });
  }
  s.typingIdle = setTimeout(stopTyping, TYPING_IDLE_MS);
}

/** Tell the others we stopped typing. */
function stopTyping() {
  const s = state;
  if (!s) return;
  clearTimeout(s.typingIdle);
  if (s.typingOn) {
    s.typingOn = false;
    sendBody({ t: 'typing', on: false });
  }
}

/** Forget we were typing without telling anyone (a message is on its way). */
function quietTyping() {
  if (!state) return;
  clearTimeout(state.typingIdle);
  state.typingOn = false;
}

function setTyping(from, on) {
  const s = state;
  if (!s) return;
  clearTimeout(s.typers.get(from));
  if (on) s.typers.set(from, setTimeout(() => setTyping(from, false), TYPING_SHOW_MS));
  else s.typers.delete(from);
  renderTyping();
}

function renderTyping() {
  const s = state;
  if (!s || s.typers.size === 0) {
    typingEl?.remove();
    return;
  }
  if (!typingEl) {
    typingEl = document.createElement('li');
    typingEl.className = 'msg them typing';
    typingEl.setAttribute('role', 'status');
    const label = document.createElement('b');
    label.className = 'sender';
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    typingEl.append(label, dots);
  }
  const label = typingEl.querySelector('.sender');
  if (s.mode === 'group') {
    const names = [...s.typers.keys()].map((id) => s.members.get(id) || 'Someone');
    label.textContent = names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
      : `${names.length} people are typing`;
    label.hidden = false;
  } else {
    label.textContent = 'Typing';
    label.hidden = true;
  }
  typingEl.setAttribute('aria-label', label.textContent);
  const list = $('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (!typingEl.isConnected) list.append(typingEl);
  if (nearBottom) typingEl.scrollIntoView({ block: 'end' });
}

function keepTypingLast() {
  if (typingEl?.isConnected) $('messages').append(typingEl);
}

function addNote(text) {
  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = text;
  $('messages').append(li);
  keepTypingLast();
  li.scrollIntoView({ block: 'end' });
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state?.ready) return;
  input.value = '';
  quietTyping();
  sendBody({ t: 'text', text });
  addMessage(text, 'me');
}

async function endChat() {
  const s = state;
  if (s?.ready) {
    s.calls.hangup();
    if (s.mode === 'pair') sendBody({ t: 'bye' });
    await s.sendChain;
  }
  if (s?.mode === 'group') end('You left the group', 'Every message has been wiped from this device.');
  else end('Chat ended', 'Every message has been wiped from this device.');
}

// ---------- QR codes ----------

/** Draw text as a QR code. Made on this device; nothing is sent anywhere. */
function drawQr(canvas, text) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const fig = canvas.closest('figure');
  if (typeof window.qrcode !== 'function') {
    fig.hidden = true;
    return;
  }
  fig.hidden = false;
  const qr = window.qrcode(0, 'M'); // auto size, medium error correction
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4; // white border that scanners need
  const cell = Math.floor(canvas.width / (n + quiet * 2));
  const offset = Math.floor((canvas.width - cell * n) / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
    }
  }
}

function clearQr(canvas) {
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ---------- wiring ----------

$('btn-new').onclick = startChat;
$('btn-new-group').onclick = () => askName({ room: randomId(), secret: newGroupSecret(), creating: true });
$('name-form').onsubmit = (e) => {
  e.preventDefault();
  const name = cleanName($('name-input').value);
  if (pendingGroup) enterGroup(name);
};
$('btn-name-cancel').onclick = () => { pendingGroup = null; wipe(); show('home'); };
$('btn-home').onclick = () => { wipe(); show('home'); };
$('btn-cancel').onclick = () => { wipe(); show('home'); };
$('btn-end').onclick = endChat;
$('btn-verify').onclick = () => { $('verify-panel').hidden = !$('verify-panel').hidden; };
$('btn-invite').onclick = () => { $('group-invite-panel').hidden = !$('group-invite-panel').hidden; };
$('btn-call').onclick = startCall;
$('btn-call-join').onclick = startCall;
$('btn-mute').onclick = () => state?.calls.toggleMute();
$('btn-hangup').onclick = () => state?.calls.hangup();
$('composer').onsubmit = sendMessage;
$('msg-input').addEventListener('input', onTypingInput);
$('msg-input').addEventListener('blur', stopTyping);
$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = () => {
  for (const file of $('file-input').files) sendFile(file);
  $('file-input').value = '';
};
$('btn-record').onclick = startRecording;
$('btn-rec-cancel').onclick = () => finishRecording(false);
$('btn-rec-send').onclick = () => finishRecording(true);
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.onclick = async () => {
    const input = $(btn.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  };
}

// Wipe when the page is closed.
addEventListener('pagehide', () => { if (state?.ready) endChat(); else wipe(); });

// Invite links: private /#r=<room>&k=<public key>, group /#g=<room>&s=<secret>
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('r') || params.get('g')) {
  // Take the invite out of the address bar and browser history.
  history.replaceState(null, '', location.pathname);
}
if (params.get('r') && params.get('k')) {
  joinChat(params.get('r'), params.get('k'));
} else if (params.get('g') && params.get('s')) {
  askName({ room: params.get('g'), secret: params.get('s'), creating: false });
} else {
  show('home');
}
