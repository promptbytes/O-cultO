# O-cultO

This repo was created with in the name of privacy. i think some of us are a bit paranoid when it comes to messages right? well my goal was to create a communication system that doesn't track or saves messages on a cloud to keep everyone safer from the Big Eye.

## What it does

O-cultO is a private one-to-one chat that runs in any modern browser, on a phone or a computer.

- **End-to-end encrypted.** Messages are encrypted on your device and can only be read on the other person's device.
- **Nothing is stored.** Messages exist only in the memory of the two open browser tabs. The server writes nothing to disk and keeps no history. The browser writes nothing to local storage, cookies or IndexedDB. Close the tab and the chat is gone.
- **No accounts.** No phone number, email or username. You start a chat, let one person scan the QR code (or send them the invite link), and talk.
- **Share by QR code.** The QR code is drawn on your own device. Nothing about it is sent anywhere.
- **Verify.** Both people see a 30-digit safety code. If the codes match when you compare them in person or on a call, no one is in the middle.

## Run it

```bash
npm install
npm start          # http://localhost:8080
npm test           # relay tests + two-browser end-to-end tests (needs Playwright)
```

To use it across the internet, put it behind HTTPS (for example Caddy or nginx with Let's Encrypt). Browsers only allow the encryption API on `https://` or `localhost`.

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
- The relay holds at most two people per room, keeps rooms only in memory, deletes a room once it is empty, and logs nothing.

Code: `server/server.js` (relay), `public/crypto.js` (encryption), `public/app.js` (app).

## Honest limits

- **Both people must be online at the same time.** With nothing stored, there is nowhere to hold a message for someone who is offline.
- **The relay can see metadata:** that two IP addresses are connected and when, and the size of messages. It cannot read the content. Using Tor or a VPN hides your IP from it.
- **Compare the safety code.** Without that check, whoever runs the relay could in theory swap B's key (a man-in-the-middle attack). Checking the code defeats this.
- **Trust the server that serves the page.** A web app is only as trustworthy as the server that delivers its JavaScript. Run your own server, or package it as a native app later.
- **Screenshots and a compromised device** can still leak messages. No app can stop that.
- This code has **not had a professional security audit**. Don't rely on it where lives are at stake until it has.
