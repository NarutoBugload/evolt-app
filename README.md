# Evolt — client

The installable Evolt client: encrypted, peer-to-peer chat that works with
no server at all.

**Use it:** https://narutobugload.github.io/evolt-app/ — then "Add to Home
Screen" / "Install app". HTTPS is required and not incidental: Web Crypto
and WebRTC do not exist on plain HTTP, so Evolt can neither encrypt nor
connect without it.

## What this repo is

Static files, published from the main Evolt repo — the client only. There is
no build step; what is here is what runs in your browser, which is the point:
for a tool that claims not to read your messages, the code doing the
encrypting should be readable by anyone.

- `js/crypto.js` — all encryption (AES-256-GCM via Web Crypto, PBKDF2 key
  derivation). The passphrase never leaves the device.
- `js/pairing.js` — serverless direct pairing over WebRTC.
- `js/webrtc.js`, `js/filetransfer.js` — peer-to-peer transport.
- `js/vendor/` — third-party libraries, committed rather than pulled from a
  CDN, with `vendor/README.md` explaining why.

## Two ways to run it

**Without an account.** No server, no sign-up. Pair with someone on the same
Wi-Fi by scanning a QR, then message and send files fully offline. Everything
stays on the two devices.

**With a backend.** Deploy the server from the main repo and enter its URL
under "Server". Adds accounts, rooms shared with several people, and
connections across the internet. Message and file bytes still travel
peer-to-peer; the backend brokers the introduction and never sees them.

The passphrase that decrypts messages is always shared out-of-band and never
reaches any server.

---

Synced from evolt @ `01cb029` (v0.1.0-13-g01cb029). Do not edit here — changes belong
in the main repo's `public/`.
