// public/js/webrtc.js
//
// Direct device-to-device transport using WebRTC RTCDataChannel.
//
// What this module does NOT do:
//   - It does not encrypt/decrypt anything itself. Callers must pass
//     already-encrypted payloads (from VaultCrypto in crypto.js) into
//     send(); raw payloads received are handed back to the caller as-is
//     for it to decrypt. This module only moves bytes between devices.
//   - It does not store any message history. Once a payload is delivered
//     to the caller's onMessage callback, this module forgets about it.
//
// What it uses the signaling server for:
//   - ONLY the initial handshake (SDP offer/answer + ICE candidates)
//     needed to open a direct RTCDataChannel between two browsers. See
//     server/signaling.js - it's a stateless relay, not a message store.
//     Once `channel.readyState === 'open'`, this module talks straight to
//     the other device; the signaling server is no longer in the loop for
//     that pair.
//
// STUN is a public, standard NAT-traversal service (not a custom
// invention) - it just helps two devices behind routers discover their
// public-facing address so they can connect directly.

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class PeerTransport {
  /**
   * @param {string} roomId
   * @param {(payload: any, fromPeerId: string) => void} onMessage
   * @param {(peerId: string, connected: boolean) => void} onPeerStatus
   */
  constructor(roomId, onMessage, onPeerStatus, token) {
    this.roomId = roomId;
    this.token = token;
    this.onMessage = onMessage;
    this.onPeerStatus = onPeerStatus || (() => {});
    this.peers = new Map(); // peerId -> { pc, channel }
    this.signalSocket = null;
  }

  connect() {
    // Separate namespace/socket from the app's main API socket - this one
    // only ever carries handshake blobs, never message content.
    // The signaling server may not be same-origin (an APK's WebView origin
    // is https://localhost; a statically-hosted PWA has no backend of its
    // own). app.js owns that setting - see serverBase() there.
    const base = (typeof serverBase === 'function' && serverBase()) || '';
    // The signaling namespace authenticates too - it is not open to anyone
    // who knows a room id. See server/signaling.js.
    const opts = { auth: { token: this.token } };
    this.signalSocket = base ? io(`${base}/signal`, opts) : io('/signal', opts);

    this.signalSocket.on('connect', () => {
      this.signalSocket.emit('signal:join', { roomId: this.roomId });
    });

    this.signalSocket.on('signal:peers', ({ peerIds }) => {
      // We're the newcomer - open an outbound connection to each existing
      // peer and be the offer-sender.
      peerIds.forEach((peerId) => this._connectToPeer(peerId, true));
    });

    this.signalSocket.on('signal:peer-joined', ({ peerId }) => {
      // Someone new joined after us - wait for their offer rather than
      // both sides racing to offer simultaneously.
      this._connectToPeer(peerId, false);
    });

    this.signalSocket.on('signal:peer-left', ({ peerId }) => {
      this._teardownPeer(peerId);
    });

    this.signalSocket.on('signal:relay', async ({ fromPeerId, data }) => {
      await this._handleSignal(fromPeerId, data);
    });
  }

  disconnect() {
    for (const peerId of Array.from(this.peers.keys())) this._teardownPeer(peerId);
    if (this.signalSocket) {
      this.signalSocket.disconnect();
      this.signalSocket = null;
    }
  }

  /** Send an already-encrypted payload to every connected peer. */
  broadcast(payload) {
    const json = JSON.stringify(payload);
    for (const { channel } of this.peers.values()) {
      if (channel && channel.readyState === 'open') channel.send(json);
    }
  }

  isConnectedToAnyPeer() {
    for (const { channel } of this.peers.values()) {
      if (channel && channel.readyState === 'open') return true;
    }
    return false;
  }

  // ---------- internals ----------

  _relay(toPeerId, data) {
    this.signalSocket.emit('signal:relay', { toPeerId, data });
  }

  _connectToPeer(peerId, isOfferer) {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    const entry = { pc, channel: null };
    this.peers.set(peerId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._relay(peerId, { type: 'ice', candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.onPeerStatus(peerId, true);
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.onPeerStatus(peerId, false);
      }
    };

    if (isOfferer) {
      const channel = pc.createDataChannel('evolt');
      this._wireChannel(peerId, channel);
      entry.channel = channel;

      pc.onnegotiationneeded = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._relay(peerId, { type: 'offer', sdp: pc.localDescription });
      };
    } else {
      pc.ondatachannel = (e) => {
        entry.channel = e.channel;
        this._wireChannel(peerId, e.channel);
      };
    }
  }

  _wireChannel(peerId, channel) {
    channel.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        this.onMessage(payload, peerId);
      } catch (err) {
        // Malformed/foreign data - drop it silently rather than throw.
      }
    };
    channel.onopen = () => this.onPeerStatus(peerId, true);
    channel.onclose = () => this.onPeerStatus(peerId, false);
  }

  async _handleSignal(fromPeerId, data) {
    let entry = this.peers.get(fromPeerId);
    if (!entry) {
      // Offer arrived before we set up our side (we were told to wait) -
      // create the peer connection now, as the answerer.
      this._connectToPeer(fromPeerId, false);
      entry = this.peers.get(fromPeerId);
    }
    const { pc } = entry;

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._relay(fromPeerId, { type: 'answer', sdp: pc.localDescription });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice') {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        // Late/duplicate candidates can safely be ignored.
      }
    }
  }

  _teardownPeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    if (entry.channel) entry.channel.close();
    entry.pc.close();
    this.peers.delete(peerId);
    this.onPeerStatus(peerId, false);
  }
}

window.EvoltP2P = { PeerTransport };
