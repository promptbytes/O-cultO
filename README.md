# O-cultO

This repo was created with in the name of privacy. i think some of us are a bit paranoid when it comes to messages right? well my goal was to create a communication system that doesn't track or saves messages on a cloud to keep everyone safer from the Big Eye.

## What it does

O-cultO is a private chat app that runs in any modern browser, on a phone or a computer. It does one-to-one chats and group chats of up to 8 people, with text, photos, videos, files and voice messages.

- **End-to-end encrypted.** Messages are encrypted on your device and can only be read on the other person's device.
- **Nothing is stored.** Messages and files exist only in the memory of the open browser tabs. The server writes nothing to disk and keeps no history. The browser writes nothing to local storage, cookies or IndexedDB. Close the tab (or tap End) and the chat is gone.
- **Survives switching apps.** Phones pause a page when you switch to another app (say, to send the invite on WhatsApp) and sometimes reload it later. O-cultO reconnects by itself, and keeps the chat's keys (never messages) in the tab's `sessionStorage` until the chat ends, so the link and the chat keep working. If the other person drops off, the chat waits up to 10 minutes for them to come back; if they tap End or close their tab, it ends straight away.
- **No accounts.** No phone number, email or username. You start a chat, let one person scan the QR code (or send them the invite link), and talk.
- **Group chats.** Up to 8 people. Everyone sees how many people are connected, so no one can listen in unseen.
- **Photos, videos and files.** Up to 25 MB each. Photos, videos and audio play in the chat; other files are offered as a download. Each file is encrypted in pieces and lives only in memory, so it's gone when the chat ends unless you tap Save.
- **Typing dots.** While someone is writing, a bubble with three bouncing dots appears (in groups it says who). The signal is encrypted like a message, and it stops when they send, clear the box or pause for a few seconds.
- **Voice messages.** Tap 🎤 to record in the app (up to 5 minutes), then Send or Cancel.
- **Voice calls (off by default).** Built in, but switched off because without a STUN/TURN server they rarely connect between different networks. Turn on with `ENABLE_CALLS=1`.
- **Share by QR code.** The QR code is drawn on your own device. Nothing about it is sent anywhere.
- **Verify.** Both people see a 30-digit safety code. If the codes match when you compare them in person or on a call, no one is in the middle.

## Run it

```bash
npm install
npm start          # http://localhost:8080
npm test           # relay tests + two-browser end-to-end tests (needs Playwright)
```

Browsers only allow the encryption API (and the microphone) on `https://` or `localhost`, so anything public must be served over HTTPS.

### Self-host with HTTPS

`deploy/` has a Docker Compose kit: the app, Caddy for automatic HTTPS certificates, and an optional coturn server that helps calls get through strict networks. All logging is off.

```bash
cd deploy
cp .env.example .env      # set DOMAIN, and TURN details if you want them
docker compose up -d                    # app + HTTPS
docker compose --profile turn up -d     # ... plus the call helper
```

### Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `ENABLE_CALLS` | off | Set to `1` to show voice calls |
| `ICE_SERVERS` | `[]` | JSON list of STUN/TURN servers for calls. Empty means no third party learns anyone's IP, but calls only connect when both networks allow a direct connection. |

## How it works

```
 Person A's browser          relay server (memory only)         Person B's browser
 ───────────────────         ──────────────────────────         ──────────────────
 new key pair (P-256)
 link: /#r=<room>&k=<A's public key>  ── sent to B any way you like ──▶
                                                                 new key pair
                          ◀──── hello { B's public key } ────────
 ECDH + HKDF → AES-256-GCM keys                                  ECDH + HKDF → same keys
 encrypted messages  ─────────────▶  forwards opaque blobs  ─────▶ decrypt
```

- The part after `#` in the link is never sent to any server, so B gets A's public key directly from A.
- New keys are made for each chat and cannot be exported. When the chat ends they are destroyed, so old chats cannot be decrypted later (forward secrecy per chat).
- Each message has a random IV and a counter bound into the encryption, so replayed, reordered or tampered messages are rejected.
- **Groups** use a random 256-bit secret that travels only in the link's `#` part or the QR code. Each person's messages carry a random sender id and a counter, bound into the encryption.
- **Files** are split into 96 KB pieces. Each piece is encrypted like a message (so it can't be read, changed, reordered or replayed), sent in order, and checked for completeness on arrival. Only photo, video and audio types are shown inside the chat; anything else, including HTML and SVG, is offered as a download only, so a file can never run code in the app.
- **Calls** use WebRTC, which always encrypts audio (DTLS-SRTP). The offers, answers and network candidates are sent through the end-to-end encrypted chat, so the relay can't read or swap them. Groups connect everyone to everyone (a mesh).
- The relay holds at most two people per private room and eight per group, keeps rooms only in memory, deletes a room once it is empty, and logs nothing.

Code: `server/server.js` (relay), `public/crypto.js` (encryption), `public/calls.js` (voice calls), `public/app.js` (app).

## Honest limits

- **The tab's session cache holds the chat keys while a chat is open.** That's what lets a chat survive the phone reloading the page. Messages are never in it. It is cleared when you tap End or close the tab, but some browsers bring closed tabs back with their session (for example "restore tabs" after a crash), so tap **End** when you're done to be sure.
- **Messages sent while the other person is offline are not delivered.** The Send button is disabled while they're away, and anything in flight when a connection drops is lost.
- **Both people must be online at the same time.** With nothing stored, there is nowhere to hold a message for someone who is offline.
- **The relay can see metadata:** that two IP addresses are connected and when, and the size of messages. It cannot read the content. Using Tor or a VPN hides your IP from it.
- **Files go through the relay** (encrypted), so the relay sees roughly how big a file is. Both people must still be online while it sends.
- **Saved files are yours to look after.** Once you tap Save, the file is on your device like any other download.
- **A group link is the group's key.** Anyone who gets it can join and read, and it keeps working for as long as anyone holds it. Show the QR code in person where you can, and start a new group if a link leaks. Group members can't cryptographically prove to each other who sent a message; names are what people say they are.
- **Calls need a path between devices.** Without a STUN/TURN server some networks (many mobile carriers, strict office Wi-Fi) can't connect a call. Running your own coturn (in `deploy/`) fixes this without trusting anyone else. When a call does go through TURN, the TURN server sees IP addresses but not the audio.
- **Compare the safety code.** Without that check, whoever runs the relay could in theory swap B's key (a man-in-the-middle attack). Checking the code defeats this.
- **Trust the server that serves the page.** A web app is only as trustworthy as the server that delivers its JavaScript. Run your own server, or package it as a native app later.
- **Screenshots and a compromised device** can still leak messages. No app can stop that.
- This code has **not had a professional security audit**. Don't rely on it where lives are at stake until it has.
