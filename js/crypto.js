// public/js/crypto.js
//
// All encryption/decryption happens here, in the browser. The passphrase
// never leaves this device - it is not sent to the server, ever.
//
// Key derivation:
//   AES key = PBKDF2( passphrase, salt = roomId|epoch|windowIndex, 150000, SHA-256 )
//
// Because the salt bakes in the epoch and window index, the *derived* key
// changes automatically every `rotation_seconds`, even though the human
// passphrase stays the same within an epoch. Bumping the epoch (admin
// action) requires a brand new passphrase to be shared out-of-band -
// anyone still on the old passphrase is locked out from that point on.

const PBKDF2_ITERATIONS = 150000;

function strToBuf(str) {
  return new TextEncoder().encode(str);
}
function bufToStr(buf) {
  return new TextDecoder().decode(buf);
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(passphrase, roomId, epoch, windowIndex) {
  const salt = strToBuf(`${roomId}|${epoch}|${windowIndex}`);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    strToBuf(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(passphrase, roomId, epoch, windowIndex, plaintext) {
  const key = await deriveKey(passphrase, roomId, epoch, windowIndex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    strToBuf(plaintext)
  );
  return { ciphertext: bufToB64(ciphertextBuf), iv: bufToB64(iv) };
}

// Returns null on failure (wrong passphrase / wrong epoch / tampered data)
// rather than throwing, so the UI can render a locked state cleanly.
async function decryptText(passphrase, roomId, epoch, windowIndex, ciphertextB64, ivB64) {
  try {
    const key = await deriveKey(passphrase, roomId, epoch, windowIndex);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) },
      key,
      b64ToBuf(ciphertextB64)
    );
    return bufToStr(plainBuf);
  } catch (e) {
    return null;
  }
}

async function encryptBytes(passphrase, roomId, epoch, windowIndex, arrayBuffer) {
  const key = await deriveKey(passphrase, roomId, epoch, windowIndex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  return { ciphertext: ciphertextBuf, iv: bufToB64(iv) };
}

async function decryptBytes(passphrase, roomId, epoch, windowIndex, ciphertextArrayBuffer, ivB64) {
  try {
    const key = await deriveKey(passphrase, roomId, epoch, windowIndex);
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) },
      key,
      ciphertextArrayBuffer
    );
  } catch (e) {
    return null;
  }
}

// A short, non-secret fingerprint of the derived key, purely so a human can
// visually confirm two devices landed on the same key without ever
// transmitting the key or passphrase itself.
async function keyFingerprint(passphrase, roomId, epoch, windowIndex) {
  // Deliberately a SEPARATE hash, not derived from the real AES-GCM key
  // material - the fingerprint only proves "same inputs", never touching
  // (or being derivable back into) the actual encryption key.
  const hashSrc = strToBuf(`${roomId}|${epoch}|${windowIndex}|${passphrase}`);
  const digest = await crypto.subtle.digest('SHA-256', hashSrc);
  return bufToB64(digest).slice(0, 6).replace(/[+/=]/g, 'x').toUpperCase();
}

// Renders a deterministic block of "cipher glyphs" for a locked message
// placeholder, so it visibly looks like ciphertext rather than empty space.
function cipherGlyphs(seedStr, length = 28) {
  const glyphs = '#%&$@*ABCDEF0123456789';
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out += glyphs[seed % glyphs.length];
  }
  return out;
}

window.VaultCrypto = {
  deriveKey,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
  keyFingerprint,
  cipherGlyphs,
  bufToB64,
  b64ToBuf,
};
