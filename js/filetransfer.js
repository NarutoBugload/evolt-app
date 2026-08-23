// public/js/filetransfer.js
//
// Chunked file transfer over the WebRTC data channel, so file bytes go
// device-to-device like text already does. Previously files were the one
// thing still routed through the server (/api/upload): encrypted, but the
// ciphertext transited and rested on disk there, and it didn't work at all
// in a directly-paired room, which has no server to upload to.
//
// This module moves bytes only. It never encrypts or decrypts: callers hand
// it ciphertext produced by crypto.js and get ciphertext back out.
//
// ---------------------------------------------------------------------------
// Why chunking, and why these numbers
// ---------------------------------------------------------------------------
// A data channel is not a file pipe. Two limits bite:
//
//   1. Message size. SCTP implementations disagree on the largest single
//      message they'll accept, and oversized sends fail by closing the whole
//      channel rather than erroring cleanly. 16 KiB is the size every
//      implementation is documented to handle, so that's the payload unit.
//
//   2. Send buffering. channel.send() queues rather than blocking, so
//      looping over a large file fills memory and can abort the connection.
//      So we stop at a high-water mark and wait for 'bufferedamountlow'
//      before continuing - the standard backpressure signal.
//
// Chunks are base64'd because the channel carries JSON envelopes for every
// other message type, and one framing is simpler to reason about than two.
// That costs 33% overhead on the wire; a binary channel would be the
// optimisation if transfers ever feel slow, but correctness first.

const CHUNK_BYTES = 16 * 1024;
const BUFFER_HIGH_WATER = 1 << 20;      // 1 MiB queued -> pause
const BUFFER_LOW_WATER = 256 * 1024;    // drained to 256 KiB -> resume
const DRAIN_TIMEOUT_MS = 30000;

function openChannels(transport) {
  if (!transport || !transport.peers) return [];
  return Array.from(transport.peers.values())
    .map((p) => p.channel)
    .filter((c) => c && c.readyState === 'open');
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunked so a big file doesn't blow the argument limit on String.fromCharCode.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Resolves once the channel has drained below the low-water mark. Times out
// rather than hanging forever if a peer stalls mid-transfer.
function waitForDrain(channel) {
  if (channel.bufferedAmount < BUFFER_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      channel.removeEventListener('bufferedamountlow', finish);
      clearTimeout(timer);
      resolve();
    };
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    channel.addEventListener('bufferedamountlow', finish);
    const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
  });
}

/**
 * Broadcast an already-encrypted file to every connected peer.
 * @param {object} transport  PeerTransport or DirectPeer
 * @param {object} msg        the file message envelope (metadata only)
 * @param {ArrayBuffer} ciphertext
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<boolean>} false if there was nobody to send to
 */
async function sendFile(transport, msg, ciphertext, onProgress) {
  const channels = openChannels(transport);
  if (!channels.length) return false;

  const bytes = new Uint8Array(ciphertext);
  const total = Math.ceil(bytes.length / CHUNK_BYTES) || 1;

  const meta = JSON.stringify({
    type: 'file-meta',
    msg: { ...msg, byte_length: bytes.length, chunk_count: total },
  });
  channels.forEach((c) => c.send(meta));

  for (let seq = 0; seq < total; seq++) {
    const slice = bytes.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
    const frame = JSON.stringify({
      type: 'file-chunk',
      fileId: msg.file_id,
      seq,
      data: bufToB64(slice),
    });
    for (const c of channels) {
      if (c.readyState !== 'open') continue;
      await waitForDrain(c);
      c.send(frame);
    }
    if (onProgress) onProgress((seq + 1) / total);
  }

  const end = JSON.stringify({ type: 'file-end', fileId: msg.file_id });
  channels.forEach((c) => { if (c.readyState === 'open') c.send(end); });
  return true;
}

/**
 * Reassembles incoming chunks. One instance per app, keyed by file id.
 * A transfer that never completes (peer vanished mid-send) just sits here
 * until the page is closed - deliberately not auto-expired, since a slow
 * transfer and a dead one look identical from this side.
 */
class Receiver {
  constructor() {
    this.pending = new Map(); // fileId -> { msg, chunks, received }
  }

  begin(msg) {
    this.pending.set(msg.file_id, {
      msg,
      chunks: new Array(msg.chunk_count),
      received: 0,
    });
  }

  /** @returns {number|null} completion fraction, or null if unknown file */
  chunk(fileId, seq, dataB64) {
    const entry = this.pending.get(fileId);
    if (!entry || entry.chunks[seq] !== undefined) return null;
    entry.chunks[seq] = b64ToBytes(dataB64);
    entry.received++;
    return entry.received / entry.msg.chunk_count;
  }

  /**
   * @returns {{msg: object, ciphertext: ArrayBuffer}|null}
   *   null if the file is unknown or arrived incomplete.
   */
  end(fileId) {
    const entry = this.pending.get(fileId);
    if (!entry) return null;
    this.pending.delete(fileId);
    if (entry.received !== entry.msg.chunk_count) return null;

    const out = new Uint8Array(entry.msg.byte_length);
    let offset = 0;
    for (const chunk of entry.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return { msg: entry.msg, ciphertext: out.buffer };
  }

  isPending(fileId) { return this.pending.has(fileId); }
}

window.EvoltFiles = { sendFile, Receiver, CHUNK_BYTES };
