// public/js/pairing.js
//
// Same-Wi-Fi / offline pairing: opens a direct WebRTC data channel between
// two devices with NO signaling server and NO internet involved.
//
// ---------------------------------------------------------------------------
// Why this is manual copy/paste rather than automatic mDNS discovery
// ---------------------------------------------------------------------------
// HANDOFF.md's plan called for "mDNS/Bonjour-style, or a simple
// broadcast/announce over the LAN". A web page cannot do that. Browsers
// expose no API to open a UDP socket, send a subnet broadcast, listen on a
// port, or register/browse an mDNS service - deliberately, because any page
// you visit could then port-scan your home network. That is a platform
// limit, not something a library works around. (A native Capacitor plugin
// using Android's NSD could do it; see HANDOFF.md for that as a real, but
// separate, native-side task.)
//
// What IS possible in the browser is to remove the *server* from the
// handshake instead of automating it: WebRTC only needs each side to learn
// the other's SDP blob. Normally a signaling server ferries those. Here the
// two people carry them across themselves - a code pasted into a chat, read
// aloud, or scanned later via QR. Once both blobs are in place the data
// channel is direct, and nothing else was ever contacted.
//
// ---------------------------------------------------------------------------
// "Vanilla ICE", and what that means for privacy
// ---------------------------------------------------------------------------
// Normal WebRTC trickles ICE candidates as they're discovered, which needs a
// live channel between peers - exactly what we don't have here. So this
// waits for ICE gathering to finish and bakes the candidates into the single
// SDP blob ("vanilla ICE"). One code each way, no live channel needed.
//
// In LAN mode (the default) iceServers is EMPTY. No STUN, no TURN, no DNS
// lookup, no packet leaves the local network. The only candidates gathered
// are host candidates - your device's own LAN addresses. This is the mode
// that genuinely works with the internet unplugged.
//
// Passing { useStun: true } re-enables public STUN so the same manual
// exchange can also connect two devices across the internet without this
// project's signaling server. That does contact Google's STUN servers, so
// it is opt-in and labelled as such in the UI.
//
// No custom cryptography here: the data channel is DTLS-encrypted by WebRTC
// itself, and message payloads are already AES-256-GCM encrypted by
// crypto.js before they are handed to this module.

const PAIRING_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Some networks never fire an "ICE gathering complete" event (a stalled
// STUN lookup, an interface that never reports). Cap the wait and use
// whatever candidates we have - host candidates alone are enough on a LAN.
const ICE_GATHER_TIMEOUT_MS = 4000;

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => { if (pc.iceGatheringState === 'complete') finish(); };
    pc.addEventListener('icegatheringstatechange', onChange);
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
  });
}

// ---------- Compact, URL-safe codes ----------
//
// A gathered SDP blob is 1-3 KB of highly repetitive text. Deflating it
// before base64 cuts it to a few hundred characters, which is the
// difference between a code someone can actually paste around (or fit in a
// QR later) and one they can't. pako is already vendored locally.

function encodeCode(obj) {
  const deflated = pako.deflate(new TextEncoder().encode(JSON.stringify(obj)));
  let binary = '';
  for (let i = 0; i < deflated.length; i++) binary += String.fromCharCode(deflated[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCode(code) {
  const cleaned = String(code).trim().replace(/\s+/g, '');
  const b64 = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(pako.inflate(bytes)));
}

/**
 * One directly-paired peer. Exposes the same broadcast()/peers surface as
 * PeerTransport in webrtc.js so app.js can drive either interchangeably.
 */
class DirectPeer {
  constructor({ onMessage, onStatus, useStun = false } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.useStun = useStun;
    this.pc = null;
    this.channel = null;
    // app.js reads `.peers` to count open channels; mirror that shape.
    this.peers = new Map();
  }

  _newConnection() {
    const pc = new RTCPeerConnection({ iceServers: this.useStun ? PAIRING_STUN_SERVERS : [] });
    this.pc = pc;
    this.peers.set('direct', { pc, channel: null });
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.onStatus('direct', false);
      }
    };
    return pc;
  }

  _wire(channel) {
    this.channel = channel;
    this.peers.get('direct').channel = channel;
    channel.onopen = () => this.onStatus('direct', true);
    channel.onclose = () => this.onStatus('direct', false);
    channel.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data), 'direct');
      } catch (err) {
        // Malformed or foreign data - drop it rather than throw.
      }
    };
  }

  /**
   * Side A. Returns an invite code to hand to the other device.
   * `room` is embedded so the other side can reconstruct the same local
   * room (id, rotation interval, epoch start) without a server telling it.
   */
  async createInvite(room) {
    const pc = this._newConnection();
    this._wire(pc.createDataChannel('evolt-direct'));
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    return encodeCode({ v: 1, t: 'offer', room, sdp: pc.localDescription.sdp });
  }

  /**
   * Side B. Consumes A's invite code and returns the reply code plus the
   * room descriptor A embedded in it.
   */
  async acceptInvite(code) {
    const data = decodeCode(code);
    if (data.t !== 'offer') throw new Error('That is a reply code, not an invite code.');

    const pc = this._newConnection();
    pc.ondatachannel = (e) => this._wire(e.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGathering(pc);
    return {
      room: data.room,
      replyCode: encodeCode({ v: 1, t: 'answer', sdp: pc.localDescription.sdp }),
    };
  }

  /** Side A again. Consumes B's reply code; the channel opens after this. */
  async completeInvite(code) {
    const data = decodeCode(code);
    if (data.t !== 'answer') throw new Error('That is an invite code, not a reply code.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
  }

  broadcast(payload) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(payload));
    }
  }

  isConnectedToAnyPeer() {
    return !!(this.channel && this.channel.readyState === 'open');
  }

  disconnect() {
    if (this.channel) this.channel.close();
    if (this.pc) this.pc.close();
    this.peers.clear();
    this.channel = null;
    this.pc = null;
  }
}

// ---------- Showing a code as a QR, and reading one back ----------
//
// The codes are ~600-800 characters, which lands around a 97x97-module QR at
// error-correction level L. That is dense but well within spec, and it beats
// reading several hundred base64 characters down a phone line. L (not H) is
// deliberate: the payload is near the practical size limit, and stronger
// correction would push it past what many phone cameras resolve. A damaged
// scan just fails and falls back to paste - nothing is lost by it.

const QR_QUIET_ZONE = 4; // modules of margin, per the QR spec's minimum

/**
 * Draws `text` as a QR code into a canvas, sized to whole pixels per module
 * so it stays sharp instead of being resampled.
 * @returns {boolean} false if the text is too large to encode
 */
function drawQr(canvas, text, targetPx = 380) {
  if (typeof qrcode === 'undefined') return false;
  let q;
  try {
    q = qrcode(0, 'L');           // 0 = pick the smallest version that fits
    q.addData(text, 'Byte');
    q.make();
  } catch (e) {
    return false;                 // over capacity
  }

  const modules = q.getModuleCount();
  const total = modules + QR_QUIET_ZONE * 2;
  const scale = Math.max(1, Math.floor(targetPx / total));
  const size = total * scale;

  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Always light-on-dark-agnostic: a QR must be dark modules on a light
  // field to scan, regardless of the app's dark theme around it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (!q.isDark(r, c)) continue;
      ctx.fillRect((c + QR_QUIET_ZONE) * scale, (r + QR_QUIET_ZONE) * scale, scale, scale);
    }
  }
  return true;
}

// BarcodeDetector is the browser's built-in scanner. It exists on Android
// Chrome and ChromeOS but not on most desktop builds, so scanning is offered
// only where it actually works - the paste field is always there as the
// route that works everywhere.
function canScan() {
  return typeof window.BarcodeDetector !== 'undefined' &&
         !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Opens the camera, scans until a QR is found, and returns its text.
 * The caller supplies a <video> to show the preview in.
 * @returns {Promise<string>} rejects if the camera is denied or it's stopped
 */
function scanQr(video, shouldStop) {
  return new Promise((resolve, reject) => {
    if (!canScan()) return reject(new Error('This browser has no built-in QR scanner.'));
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    let stream = null;

    const cleanup = () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };

    navigator.mediaDevices
      // 'environment' asks for the rear camera on a phone, which is the one
      // pointed at the other person's screen.
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        stream = s;
        video.srcObject = s;
        await video.play();
        const tick = async () => {
          if (shouldStop && shouldStop()) { cleanup(); return reject(new Error('Scan cancelled.')); }
          try {
            const found = await detector.detect(video);
            if (found.length) { cleanup(); return resolve(found[0].rawValue); }
          } catch (e) {
            // A transient decode failure is normal between frames.
          }
          requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((e) => { cleanup(); reject(new Error(`Camera unavailable: ${e.message}`)); });
  });
}

window.EvoltPairing = { DirectPeer, encodeCode, decodeCode, drawQr, canScan, scanQr };
