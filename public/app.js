import { newKeyPair, deriveSession, seal, open, randomId } from './crypto.js';

// Everything about the chat lives in this one object, in memory only.
// Nothing goes to localStorage, IndexedDB, cookies or the server.
let state = null;

const $ = (id) => document.getElementById(id);
const views = ['home', 'invite', 'chat', 'ended'];

function show(name) {
  for (const v of views) $('view-' + v).hidden = v !== name;
}

function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

// ---------- lifecycle ----------

function wipe() {
  if (state?.ws) {
    state.ws.onclose = null;
    try { state.ws.close(); } catch {}
  }
  state = null;
  $('messages').replaceChildren();
  $('msg-input').value = '';
  $('safety-code').textContent = '—';
  $('verify-panel').hidden = true;
}

function end(title, text) {
  wipe();
  $('ended-title').textContent = title;
  $('ended-text').textContent = text;
  show('ended');
}

function connect(onOpen) {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: state.room }));
    onOpen?.();
  };
  ws.onmessage = (ev) => handleServer(JSON.parse(ev.data)).catch(() => {});
  ws.onclose = () => {
    if (state) end('Connection lost', 'The connection dropped, so the chat was wiped. Start a new one to keep talking.');
  };
}

function relay(data) {
  state?.ws?.send(JSON.stringify({ type: 'relay', data }));
}

// ---------- starting a chat (person A) ----------

async function startChat() {
  wipe();
  const keys = await newKeyPair();
  state = { role: 'a', room: randomId(), keys, session: null };
  // The public key goes in the #fragment, which browsers never send to the
  // server, so person B gets A's real key straight from A.
  const link = `${location.origin}/#r=${state.room}&k=${keys.pub}`;
  $('invite-link').value = link;
  $('invite-status').textContent = 'Waiting for them to open it…';
  show('invite');
  connect();
}

// ---------- joining a chat (person B) ----------

async function joinChat(room, peerPub) {
  wipe();
  const keys = await newKeyPair();
  state = { role: 'b', room, keys, peerPub, session: null };
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

// ---------- server events ----------

async function handleServer(msg) {
  if (!state) return;

  if (msg.type === 'error') {
    if (msg.reason === 'room-full') return end('Chat is full', 'This link has already been used by someone else. Ask for a new one.');
    return end('Something went wrong', 'The chat could not start. Try a new one.');
  }

  if (msg.type === 'joined') {
    if (state.role === 'b') {
      if (msg.peers === 0) {
        setConn('The other person is not here. They may have closed their tab. Ask for a new link.', false);
      } else {
        relay(JSON.stringify({ k: 'hello', pub: state.keys.pub }));
        setConn('Securing…', false);
      }
    }
    return;
  }

  if (msg.type === 'peer-joined') {
    if (state.role === 'b') relay(JSON.stringify({ k: 'hello', pub: state.keys.pub }));
    if (state.role === 'a' && !state.session) $('invite-status').textContent = 'They opened it. Securing…';
    return;
  }

  if (msg.type === 'peer-left') {
    if (state.session) return end('Chat ended', 'The other person left. Every message has been wiped from this device.');
    if (state.role === 'a') $('invite-status').textContent = 'Waiting for them to open it…';
    return;
  }

  if (msg.type === 'relay') {
    let env;
    try { env = JSON.parse(msg.data); } catch { return; }
    return handlePeer(env);
  }
}

async function handlePeer(env) {
  // Person A gets B's public key (only once: later attempts are ignored).
  if (env.k === 'hello') {
    if (state.role !== 'a' || state.session || typeof env.pub !== 'string') return;
    try {
      state.session = await deriveSession({
        privateKey: state.keys.privateKey, myPubRaw: state.keys.pubRaw, peerPub: env.pub, role: 'a', room: state.room,
      });
    } catch { return; }
    relay(await seal(state.session, { t: 'ready' }));
    openChatView();
    ready();
    return;
  }

  if (env.k === 'm' && state.session) {
    let body;
    try { body = await open(state.session, env); } catch { return; } // tampered or replayed: drop it
    if (body.t === 'ready') {
      if (state.role === 'b') ready();
    } else if (body.t === 'text' && typeof body.text === 'string') {
      addMessage(body.text.slice(0, 4000), 'them');
    } else if (body.t === 'bye') {
      end('Chat ended', 'The other person ended the chat. Every message has been wiped from this device.');
    }
  }
}

// ---------- chat UI ----------

function openChatView() {
  $('safety-code').textContent = state.session.safetyCode;
  show('chat');
}

function ready() {
  state.ready = true;
  setConn('End-to-end encrypted', true);
  $('msg-input').disabled = false;
  $('btn-send').disabled = false;
  $('msg-input').focus();
  addNote('Messages are end-to-end encrypted and are not saved anywhere. Tap Verify to check that no one is listening in.');
}

function setConn(text, ok) {
  $('conn-status').textContent = text;
  $('conn-dot').classList.toggle('ok', ok);
}

function addMessage(text, who) {
  const li = document.createElement('li');
  li.className = 'msg ' + who;
  li.textContent = text; // textContent, never innerHTML
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.append(time);
  $('messages').append(li);
  li.scrollIntoView({ block: 'end' });
}

function addNote(text) {
  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = text;
  $('messages').append(li);
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state?.ready) return;
  input.value = '';
  relay(await seal(state.session, { t: 'text', text }));
  addMessage(text, 'me');
}

async function endChat() {
  if (state?.session) {
    try { relay(await seal(state.session, { t: 'bye' })); } catch {}
  }
  end('Chat ended', 'Every message has been wiped from this device.');
}

// ---------- wiring ----------

$('btn-new').onclick = startChat;
$('btn-home').onclick = () => { wipe(); show('home'); };
$('btn-cancel').onclick = () => { wipe(); show('home'); };
$('btn-end').onclick = endChat;
$('btn-verify').onclick = () => { $('verify-panel').hidden = !$('verify-panel').hidden; };
$('composer').onsubmit = sendMessage;
$('btn-copy').onclick = async () => {
  const input = $('invite-link');
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
  $('btn-copy').textContent = 'Copied';
  setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1500);
};

// Wipe when the page is closed or hidden by the browser for good.
addEventListener('pagehide', () => { if (state?.session) endChat(); else wipe(); });

// An invite link looks like /#r=<room>&k=<public key>
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('r') && params.get('k')) {
  const room = params.get('r');
  const pub = params.get('k');
  // Take the invite out of the address bar and browser history.
  history.replaceState(null, '', location.pathname);
  joinChat(room, pub);
} else {
  show('home');
}
