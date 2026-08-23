// public/js/app.js
'use strict';

// ---------- Where the backend lives ----------
//
// When Evolt is served BY its own server (a normal web deploy), this is
// same-origin and there is nothing to configure. But the installable
// builds aren't: an APK's origin is https://localhost inside the WebView,
// and a PWA served from static hosting has no backend behind it at all.
// Capacitor bundles public/ - it cannot bundle server/index.js. So those
// builds need to be told where (or whether) a backend exists.
//
// Two supported shapes:
//   1. Point at a deployed backend -> accounts, server-brokered rooms, the
//      WebRTC signaling handshake, and file upload all work as usual.
//   2. Local-only mode -> no backend at all. Direct pairing (pairing.js)
//      needs no server for anything, so the app is fully usable offline
//      for LAN chat. Anything server-dependent is hidden rather than
//      offered and then failing.
function serverBase() {
  // A URL the person set wins; otherwise the build-time default from
  // config.js; otherwise same-origin, which is right for the web app.
  const chosen = localStorage.getItem('evolt_server');
  if (chosen !== null) return chosen;
  return (typeof window !== 'undefined' && window.EVOLT_DEFAULT_SERVER) || '';
}
function setServerBase(url) {
  const cleaned = (url || '').trim().replace(/\/+$/, '');
  // Removing the override falls back to the build default rather than
  // pinning an empty string, so "clear this" means "use the default".
  if (cleaned) localStorage.setItem('evolt_server', cleaned);
  else localStorage.removeItem('evolt_server');
}
function isLocalOnly() {
  return localStorage.getItem('evolt_local_only') === '1';
}

const state = {
  token: localStorage.getItem('vault_token') || null,
  user: JSON.parse(localStorage.getItem('vault_user') || 'null'),
  rooms: [],
  activeRoom: null,   // full room object incl. windowIndex, epoch, rotation_seconds
  socket: null,
  p2p: null,          // EvoltP2P.PeerTransport for the active server-backed room
  // Directly-paired transports (pairing.js), keyed by local room id. Kept
  // separate from `p2p` and never torn down on room switch: a pairing is
  // expensive to re-establish (two codes carried by hand), so switching
  // rooms must not drop it.
  directPeers: new Map(),
  connectedPeerCount: 0,
  passphrases: {},    // { [roomId]: { [epoch]: passphrase } } - memory + sessionStorage only
  observers: new Map(), // messageId -> IntersectionObserver, for burn-on-view
};

// ---------- Passphrase storage (local device only, never sent to server) ----------

function passKey(roomId, epoch) { return `vault_pp_${roomId}_${epoch}`; }
function rememberKey(roomId) { return `evolt_remember_pp_${roomId}`; }

// Whether this device keeps the room's passphrase across restarts.
//
// Default OFF, and that default is load-bearing. Messages rest in IndexedDB
// as ciphertext; the passphrase is the only thing standing between someone
// holding the unlocked device and reading them. Keeping it in sessionStorage
// means closing the app leaves ciphertext with no key beside it. Turning
// this on trades that away for not re-sharing the secret on every
// reconnect - a fair trade for some people and a bad one for others, so it
// is theirs to make, per room, and the UI says what it costs.
function isPassphraseRemembered(roomId) {
  return localStorage.getItem(rememberKey(roomId)) === '1';
}

function setPassphraseRemembered(roomId, on, epoch) {
  if (on) {
    localStorage.setItem(rememberKey(roomId), '1');
    const current = getPassphrase(roomId, epoch);
    if (current) localStorage.setItem(passKey(roomId, epoch), current);
  } else {
    localStorage.removeItem(rememberKey(roomId));
    // Sweep every epoch's copy, not just the current one.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`vault_pp_${roomId}_`)) localStorage.removeItem(k);
    }
  }
}

function getPassphrase(roomId, epoch) {
  if (state.passphrases[roomId]?.[epoch]) return state.passphrases[roomId][epoch];
  const cached = sessionStorage.getItem(passKey(roomId, epoch))
              || localStorage.getItem(passKey(roomId, epoch));
  if (cached) {
    state.passphrases[roomId] = state.passphrases[roomId] || {};
    state.passphrases[roomId][epoch] = cached;
  }
  return cached;
}

function setPassphrase(roomId, epoch, value) {
  state.passphrases[roomId] = state.passphrases[roomId] || {};
  state.passphrases[roomId][epoch] = value;
  sessionStorage.setItem(passKey(roomId, epoch), value);
  if (isPassphraseRemembered(roomId)) localStorage.setItem(passKey(roomId, epoch), value);
}

// ---------- API helper ----------

const NO_SERVER_MESSAGE =
  'No server to sign in to. This build has no backend of its own — use it ' +
  'without an account below, or set a server URL under “Server”.';

async function api(path, options = {}) {
  if (isLocalOnly()) throw new Error(NO_SERVER_MESSAGE);
  let res;
  try {
    res = await fetch(serverBase() + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    // fetch only rejects when the request never reached a server at all.
    // "Failed to fetch" tells the person nothing; this tells them what to do.
    throw new Error(NO_SERVER_MESSAGE);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A backend would answer with JSON and an `error`. Anything else here
    // means we reached something that isn't an Evolt server - a static host
    // serving a 404, a captive portal, a proxy - which is the same dead end
    // as no server at all, so say the same thing.
    if (!data.error) throw new Error(NO_SERVER_MESSAGE);
    throw new Error(data.error);
  }
  return data;
}

// ---------- Auth ----------

const authScreen = document.getElementById('auth-screen');
const appScreen = document.getElementById('app-screen');

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    document.getElementById('login-form').classList.toggle('hidden', !isLogin);
    document.getElementById('register-form').classList.toggle('hidden', isLogin);
  });
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    onAuthed(data);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  const fd = new FormData(e.target);
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    onAuthed(data);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function onAuthed({ token, user }) {
  state.token = token;
  state.user = user;
  localStorage.setItem('vault_token', token);
  localStorage.setItem('vault_user', JSON.stringify(user));
  bootApp();
}

// ---------- Backend URL + local-only entry ----------
//
// An installed build (APK, or the PWA on static hosting) has no backend
// behind it until someone points it at one. Leading with a sign-in form
// there is a dead end: the person types credentials, gets a network error,
// and has no way of knowing the answer is "this build has no server, use it
// without an account". So find out first, and lead with whichever path can
// actually work.
async function detectBackend() {
  if (isLocalOnly()) return false;
  try {
    const res = await fetch(`${serverBase()}/api/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function applyAuthMode() {
  const card = document.querySelector('.auth-card');
  const hasBackend = await detectBackend();
  card.classList.toggle('no-backend', !hasBackend);

  // With no server, using it without an account is the only thing that
  // works, so it becomes the primary action rather than a footnote.
  const localBtn = document.getElementById('local-only-btn');
  localBtn.classList.toggle('btn-primary', !hasBackend);
  localBtn.classList.toggle('btn-secondary', hasBackend);
  document.getElementById('no-backend-note').classList.toggle('hidden', hasBackend);
}
applyAuthMode();

document.getElementById('server-url-input').value = serverBase();
document.getElementById('server-url-save').addEventListener('click', () => {
  setServerBase(document.getElementById('server-url-input').value);
  localStorage.removeItem('evolt_local_only');
  location.reload();
});

document.getElementById('local-only-btn').addEventListener('click', () => {
  const name = document.getElementById('local-only-name').value.trim() || 'Me';
  // A local identity, generated on-device. It exists only to label messages
  // and to tell "mine" from "theirs" in the UI - it is not an account,
  // is never registered anywhere, and no server ever sees it.
  const user = {
    id: crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`,
    username: name,
    is_admin: false,
  };
  localStorage.setItem('evolt_local_only', '1');
  localStorage.setItem('vault_user', JSON.stringify(user));
  localStorage.removeItem('vault_token');
  state.token = null;
  state.user = user;
  bootApp();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('vault_token');
  localStorage.removeItem('vault_user');
  localStorage.removeItem('evolt_local_only');
  state.socket?.disconnect();
  state.p2p?.disconnect();
  location.reload();
});

// ---------- Boot ----------

async function bootApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  const localOnly = isLocalOnly();
  document.getElementById('me-name').textContent = state.user.username;
  document.getElementById('me-initial').textContent = state.user.username.slice(0, 2).toUpperCase();
  document.getElementById('me-role').textContent =
    localOnly ? 'Local only' : (state.user.is_admin ? 'Server admin' : 'Member');

  // Server-backed rooms need a server. In local-only mode there isn't one,
  // so hide the control rather than let it fail on click.
  document.getElementById('new-room-btn').classList.toggle('hidden', localOnly);
  document.getElementById('join-room-btn').classList.toggle('hidden', localOnly);

  if (!localOnly) {
    await ensureSocketIo();
    connectSocket();
  }
  await refreshRoomList();
}

// socket.io's client library is served BY the backend (/socket.io/socket.io.js),
// so it can't be a static <script> tag: an APK or a statically-hosted PWA
// would 404 on it at parse time. Load it from whichever backend is
// configured, and only when one is actually going to be used - local-only
// mode never touches socket.io at all.
let socketIoLoad = null;
function ensureSocketIo() {
  if (typeof io !== 'undefined') return Promise.resolve();
  if (socketIoLoad) return socketIoLoad;
  socketIoLoad = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = `${serverBase()}/socket.io/socket.io.js`;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not reach the Evolt server.'));
    document.head.appendChild(el);
  });
  return socketIoLoad;
}

if (state.token && state.user) bootApp();
else if (isLocalOnly() && state.user) bootApp();

function connectSocket() {
  const base = serverBase();
  state.socket = base
    ? io(base, { auth: { token: state.token } })
    : io({ auth: { token: state.token } });

  state.socket.on('room:state', (room) => {
    if (state.activeRoom && room.id === state.activeRoom.id) {
      Object.assign(state.activeRoom, room);
      renderRoomHeader();
    }
  });
  state.socket.on('room:updated', (room) => {
    if (state.activeRoom && room.id === state.activeRoom.id) {
      Object.assign(state.activeRoom, room);
      renderRoomHeader();
      syncAdminModalFromRoom();
    }
  });
  state.socket.on('room:epoch-rotated', (room) => {
    if (state.activeRoom && room.id === state.activeRoom.id) {
      Object.assign(state.activeRoom, room);
      renderRoomHeader();
      showPassphraseBarIfNeeded();
      appendSystemNote(`Key rotated to epoch ${room.key_epoch}. Ask the admin for the new passphrase.`);
    }
  });
  state.socket.on('message:new', (msg) => {
    if (state.activeRoom && msg.room_id === state.activeRoom.id) renderMessage(msg);
  });
  state.socket.on('message:burned', ({ messageId }) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) {
      el.classList.add('burning');
      setTimeout(() => el.remove(), 250);
    }
  });
  state.socket.on('typing', ({ username, isTyping, userId }) => {
    if (userId === state.user.id) return;
    const el = document.getElementById('typing-indicator');
    if (isTyping) {
      el.textContent = `${username} is typing…`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
}

// ---------- Reusable modal-based prompts (replace native prompt()/confirm())
//
// Native prompt()/confirm() block the whole page, render inconsistently
// across browsers/mobile, and can't be styled - all bad for a security
// tool where the person needs to trust and clearly read what they're
// typing. These do the same job through the app's own modal UI.

function askPassphrase({ title, hint = '' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('passphrase-modal');
    const input = document.getElementById('passphrase-modal-input');
    const errorEl = document.getElementById('passphrase-modal-error');
    document.getElementById('passphrase-modal-title').textContent = title;
    document.getElementById('passphrase-modal-hint').textContent = hint;
    errorEl.textContent = '';
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 0);

    function cleanup(result) {
      modal.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onConfirm() {
      if (!input.value) {
        errorEl.textContent = 'Passphrase cannot be empty.';
        return;
      }
      cleanup(input.value);
    }
    function onCancel() { cleanup(null); }
    function onKeydown(e) {
      if (e.key === 'Enter') onConfirm();
      if (e.key === 'Escape') onCancel();
    }

    const confirmBtn = document.getElementById('passphrase-modal-confirm');
    const cancelBtn = document.getElementById('passphrase-modal-cancel');
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}

function askConfirm({ title, body }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body;
    modal.classList.remove('hidden');

    function cleanup(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ---------- Rooms ----------

async function refreshRoomList() {
  // Server-backed rooms plus directly-paired local rooms, which have no
  // server row at all (see pairing.js).
  const [serverRooms, localRooms] = await Promise.all([
    api('/api/rooms').catch(() => []),
    EvoltStore.getLocalRooms().catch(() => []),
  ]);
  state.rooms = [...serverRooms, ...localRooms];
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  state.rooms.forEach((room) => {
    const item = document.createElement('div');
    item.className = 'room-item' + (state.activeRoom?.id === room.id ? ' active' : '');
    const tag = room.local ? 'LAN' : `#${room.id.slice(0, 4)}`;
    item.innerHTML = `<span>${escapeHtml(room.name)}</span><span class="rid">${tag}</span>`;
    item.addEventListener('click', () => { setRailOpen(false); openRoom(room.id); });
    list.appendChild(item);
  });
}

document.getElementById('new-room-btn').addEventListener('click', () => {
  document.getElementById('room-modal').classList.remove('hidden');
});
document.getElementById('room-modal-cancel').addEventListener('click', () => {
  document.getElementById('room-modal').classList.add('hidden');
});
document.getElementById('room-modal-create').addEventListener('click', async () => {
  const name = document.getElementById('room-name-input').value.trim();
  if (!name) return;
  const rotationSeconds = Number(document.getElementById('rotation-select').value);
  const disappearing = document.getElementById('disappearing-checkbox').checked;
  const room = await api('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, rotationSeconds, disappearing }),
  });
  document.getElementById('room-modal').classList.add('hidden');
  document.getElementById('room-name-input').value = '';
  await refreshRoomList();
  openRoom(room.id);

  // The creator must set a passphrase locally right away (epoch 1) and share
  // it with intended members OUTSIDE this app - Evolt never transmits it.
  promptForPassphrase(room.id, 1, true);
});

async function openRoom(roomId) {
  const local = await EvoltStore.getLocalRoom(roomId);
  // A directly-paired room has no server record to fetch, no socket room to
  // join, and no server-held history - everything about it is on-device.
  const room = local || (await api(`/api/rooms/${roomId}`));
  if (local) room.windowIndex = currentWindowIndex(room);
  state.activeRoom = room;
  document.querySelectorAll('.room-item').forEach((el) => el.classList.remove('active'));
  await refreshRoomList();

  document.getElementById('room-name').textContent = room.name;
  // Local rooms have no server-side admin controls (no epoch row to rotate,
  // no membership to manage) - the pairing itself is the whole room.
  document.getElementById('admin-panel-btn').classList.toggle('hidden', !room.isAdmin || !!room.local);
  // A paired room's id is meaningless to anyone else - there's no server
  // for them to join it through.
  document.getElementById('copy-room-id').classList.toggle('hidden', !!room.local);
  document.getElementById('composer').classList.remove('hidden');
  renderRoomHeader();
  syncAdminModalFromRoom();
  showPassphraseBarIfNeeded();

  if (room.local) {
    // The paired DirectPeer transport is already live (or will be once the
    // other side pastes the reply code) - don't tear it down here.
    updatePeerStatusUI();
    showReconnectBarIfNeeded();
  } else {
    document.getElementById('reconnect-bar').classList.add('hidden');
    state.socket.emit('room:join', roomId);
    await connectP2P(roomId);
  }
  await reloadMessages();
  await updateDeliveryTicks();
  await flushOutbox(room.id);

  startRotationTicker();
}

function currentWindowIndex(room) {
  const elapsed = Math.floor((Date.now() - room.epoch_started_at) / 1000);
  return Math.floor(elapsed / room.rotation_seconds);
}

// ---------- P2P transport ----------
//
// Text messages travel directly between devices via WebRTC (see
// public/js/webrtc.js). The server's role is limited to the brief
// handshake needed to open that channel (public/js/webrtc.js +
// server/signaling.js) - once peers are connected it isn't involved.
// File messages still go through the old server upload/download endpoints
// for now (still encrypted, but the server does see the encrypted blob) -
// see HANDOFF.md for that as a known next step, not yet migrated.

async function connectP2P(roomId) {
  if (state.p2p) {
    state.p2p.disconnect();
    state.p2p = null;
  }
  state.connectedPeerCount = 0;
  updatePeerStatusUI();

  state.p2p = new EvoltP2P.PeerTransport(roomId, onP2PMessage, onPeerStatus, state.token);
  state.p2p.connect();
}

// The transport carrying the active room: a directly-paired DirectPeer for
// local rooms, the signaling-server-brokered PeerTransport otherwise.
function activeTransport() {
  const room = state.activeRoom;
  if (!room) return null;
  return room.local ? state.directPeers.get(room.id) || null : state.p2p;
}

function onPeerStatus(peerId, connected) {
  if (connected && state.activeRoom) flushOutbox(state.activeRoom.id);
  // Side B is left holding its reply code so the other device can read it.
  // Once the channel is actually open that code has done its job, so get
  // the modal out of the way rather than leaving it covering the room.
  if (connected && !pendingPair && !pairModal.classList.contains('hidden')) {
    pairModal.classList.add('hidden');
  }
  // Recompute from the transport rather than trusting a running counter,
  // since peers can connect/disconnect out of order.
  const t = activeTransport();
  state.connectedPeerCount = t ? Array.from(t.peers.values()).filter(
    (p) => p.channel && p.channel.readyState === 'open'
  ).length : 0;
  updatePeerStatusUI();
}

function updatePeerStatusUI() {
  const el = document.getElementById('peer-status');
  if (!el) return;
  const t = activeTransport();
  state.connectedPeerCount = t ? Array.from(t.peers.values()).filter(
    (p) => p.channel && p.channel.readyState === 'open'
  ).length : 0;
  const lan = state.activeRoom?.local ? ' on this network' : '';
  el.textContent = state.connectedPeerCount > 0
    ? `● ${state.connectedPeerCount} peer${state.connectedPeerCount > 1 ? 's' : ''} connected directly${lan}`
    : '○ waiting for a peer to connect';
  showReconnectBarIfNeeded();
}

// Frames arrive on an ordered channel, but handling them is async (IndexedDB
// writes, decryption), and the channel's onmessage doesn't await us. Without
// a queue a later frame can overtake an earlier one mid-await: a file-meta
// handler that yields on its first await finishes AFTER the chunks and the
// file-end it precedes, clobbering the completed state with "Receiving 0%".
// Serialising restores the ordering the protocol assumes.
let p2pQueue = Promise.resolve();
function onP2PMessage(payload) {
  p2pQueue = p2pQueue.then(() => handleP2PMessage(payload)).catch((e) => {
    console.error('P2P frame failed', e);
  });
  return p2pQueue;
}

async function handleP2PMessage(payload) {
  switch (payload?.type) {
    case 'message': {
      const msg = payload.msg;
      // Store for whichever room it belongs to - only render if that room
      // is on screen. Dropping frames for a room you aren't looking at
      // silently lost messages.
      await EvoltStore.addMessage(msg.room_id, { ...msg, delivery: DELIVERY.DELIVERED });
      ackMessage(msg.room_id, msg.id);
      if (state.activeRoom && msg.room_id === state.activeRoom.id) await renderMessage(msg);
      return;
    }
    case 'file-meta': return onFileMeta(payload);
    case 'file-chunk': return onFileChunk(payload);
    case 'file-end':  return onFileEnd(payload);
    case 'ack':       return onDeliveryAck(payload);
    case 'burn':      return onPeerBurn(payload);
    default:          return; // unknown/foreign frame - ignore
  }
}

function showPassphraseBarIfNeeded() {
  const room = state.activeRoom;
  const bar = document.getElementById('passphrase-bar');
  const known = getPassphrase(room.id, room.key_epoch);
  bar.classList.toggle('hidden', !!known);
}

document.getElementById('passphrase-unlock').addEventListener('click', () => {
  const room = state.activeRoom;
  const val = document.getElementById('passphrase-input').value;
  if (!val) return;
  setPassphrase(room.id, room.key_epoch, val);
  document.getElementById('passphrase-input').value = '';
  document.getElementById('passphrase-bar').classList.add('hidden');
  // Re-render current messages, attempting decryption now that we have a key.
  reloadMessages();
});

async function promptForPassphrase(roomId, epoch, isCreatingRoom) {
  const hint = isCreatingRoom
    ? 'You are creating this room — pick a strong passphrase now and share it with members outside Evolt (in person, a phone call, a separate secure channel, etc). It is never sent to the server.'
    : 'This passphrase is combined with the room and a rotating time window to derive the encryption key. It never leaves this device.';
  const val = await askPassphrase({ title: `Set passphrase (epoch ${epoch})`, hint });
  if (val) {
    setPassphrase(roomId, epoch, val);
    document.getElementById('passphrase-bar').classList.add('hidden');
    reloadMessages();
  }
}

async function reloadMessages() {
  const room = state.activeRoom;
  const [serverMessages, localMessages] = await Promise.all([
    // A directly-paired room has no server row, so don't ask the server for
    // history it can't have - and don't 404 trying.
    room.local ? Promise.resolve([]) : api(`/api/rooms/${room.id}/messages`),
    EvoltStore.getMessages(room.id),          // P2P text messages, on-device only
  ]);
  const seen = new Set();
  const merged = [];
  [...serverMessages, ...localMessages].forEach((m) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    merged.push(m);
  });
  merged.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const container = document.getElementById('messages');
  container.innerHTML = '';
  merged.forEach(renderMessage);
}

function renderRoomHeader() {
  const room = state.activeRoom;
  document.getElementById('epoch-badge').textContent = `EPOCH ${room.key_epoch}`;
}

// ---------- Rotation dial ticker (signature UI element) ----------

let tickerHandle = null;
function startRotationTicker() {
  if (tickerHandle) clearInterval(tickerHandle);
  tickerHandle = setInterval(() => {
    const room = state.activeRoom;
    if (!room) return;
    const elapsed = (Date.now() - room.epoch_started_at) / 1000;
    const windowIndex = Math.floor(elapsed / room.rotation_seconds);
    const intoWindow = elapsed - windowIndex * room.rotation_seconds;
    const fraction = Math.min(1, intoWindow / room.rotation_seconds);
    room.windowIndex = windowIndex;

    const circumference = 97.4; // 2 * PI * r(15.5)
    document.getElementById('dial-progress').style.strokeDashoffset = String(circumference * fraction);
    const remaining = Math.max(0, Math.round(room.rotation_seconds - intoWindow));
    document.getElementById('dial-window').textContent = formatSeconds(remaining);
  }, 1000);
}

function formatSeconds(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m${String(sec).padStart(2, '0')}` : `${sec}s`;
}

// ---------- Messaging ----------

document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await sendText(text);
});

let typingTimeout = null;
document.getElementById('message-input').addEventListener('input', () => {
  if (!state.activeRoom) return;
  if (state.activeRoom.local) return; // no server socket backs a paired room
  state.socket.emit('typing', { roomId: state.activeRoom.id, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    state.socket.emit('typing', { roomId: state.activeRoom.id, isTyping: false });
  }, 1200);
});

async function sendText(text) {
  const room = state.activeRoom;
  const epoch = room.key_epoch;
  const passphrase = getPassphrase(room.id, epoch);
  if (!passphrase) return promptForPassphrase(room.id, epoch, false);

  const windowIndex = room.windowIndex ?? 0;
  const { ciphertext, iv } = await VaultCrypto.encryptText(passphrase, room.id, epoch, windowIndex, text);

  const msg = {
    id: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    room_id: room.id,
    sender_id: state.user.id,
    sender_username: state.user.username,
    kind: 'text',
    ciphertext,
    iv,
    key_epoch: epoch,
    window_index: windowIndex,
    created_at: Date.now(),
    disappearing: !!room.disappearing_enabled,
    consumed: false,
  };

  // Queue first, send second. Saving before attempting delivery is what
  // makes an offline send work at all: the message is safely on this device
  // whether or not anyone is listening, and the outbox picks it up when a
  // peer appears.
  msg.delivery = DELIVERY.PENDING;
  await EvoltStore.addMessage(room.id, msg);
  await renderMessage(msg);
  await flushOutbox(room.id);
}

// ---------- Outbox ----------
//
// There is no server mailbox to hold a message for someone who is offline,
// so the queue lives on the sender's device instead. A message is written to
// IndexedDB as `pending`, and every time a peer connects the queue for that
// room is drained in order.
//
// The three states, which the ticks in the UI map onto directly:
//   pending   - on this device only; nobody has received it
//   sent      - handed to an open data channel
//   delivered - the other device confirmed it stored the message
//
// "delivered" is an explicit acknowledgement rather than an assumption:
// handing bytes to a data channel says nothing about whether the far side
// was still there to write them down.
const DELIVERY = { PENDING: 'pending', SENT: 'sent', DELIVERED: 'delivered' };

// Rooms currently draining, so a burst of connect events cannot start two
// concurrent flushes and send everything twice.
const flushing = new Set();

function transportFor(roomId) {
  return roomId === state.activeRoom?.id
    ? activeTransport()
    : state.directPeers.get(roomId) || null;
}

async function flushOutbox(roomId) {
  if (flushing.has(roomId)) return;
  const transport = transportFor(roomId);
  if (!transport || !transport.isConnectedToAnyPeer()) {
    await updateDeliveryTicks();
    return;
  }

  flushing.add(roomId);
  try {
    const all = await EvoltStore.getMessages(roomId);
    const queued = all
      .filter((m) => m.delivery === DELIVERY.PENDING && m.sender_id === state.user.id)
      .sort((a, b) => a.created_at - b.created_at);

    for (const msg of queued) {
      if (msg.kind === 'file') {
        const ciphertext = await EvoltStore.getFileBlob(msg.file_id);
        if (!ciphertext) continue; // bytes gone (burned) - nothing to send
        setFileChipStatus(msg.id, 'Sending 0%');
        const ok = await EvoltFiles.sendFile(transport, msg, ciphertext, (f) => {
          setFileChipStatus(msg.id, `Sending ${Math.round(f * 100)}%`);
        });
        setFileChipStatus(msg.id, null);
        if (!ok) break;                       // peer vanished mid-drain
      } else {
        transport.broadcast({ type: 'message', msg });
      }
      await EvoltStore.updateMessage(roomId, msg.id, { delivery: DELIVERY.SENT });
      markDelivery(msg.id, DELIVERY.SENT);
    }
  } finally {
    flushing.delete(roomId);
  }
}

// ---------- Delivery ticks ----------

const TICKS = {
  [DELIVERY.PENDING]:   { glyph: '\u25CB',   title: 'Waiting on this device - not delivered yet' },
  [DELIVERY.SENT]:      { glyph: '\u2713',   title: 'Sent to the other device' },
  [DELIVERY.DELIVERED]: { glyph: '\u2713\u2713', title: 'Delivered' },
};

function markDelivery(messageId, delivery) {
  const el = document.getElementById(`msg-${messageId}`);
  const tick = el && el.querySelector('.tick');
  if (!tick) return;
  const spec = TICKS[delivery] || TICKS[DELIVERY.PENDING];
  tick.textContent = spec.glyph;
  tick.title = spec.title;
  tick.classList.toggle('tick-done', delivery === DELIVERY.DELIVERED);
}

// Re-reads state from storage, so the ticks cannot drift out of step with
// what was actually persisted.
async function updateDeliveryTicks() {
  const room = state.activeRoom;
  if (!room) return;
  const msgs = await EvoltStore.getMessages(room.id).catch(() => []);
  msgs.forEach((m) => { if (m.sender_id === state.user.id) markDelivery(m.id, m.delivery); });
}

// The recipient confirms it has the message STORED, not merely received.
function ackMessage(roomId, messageId) {
  const transport = transportFor(roomId);
  if (transport) transport.broadcast({ type: 'ack', roomId, messageId });
}

async function onDeliveryAck(payload) {
  // In a room with several peers this fires on the FIRST confirmation, so it
  // means "at least one device has it", not "everyone has it". Left to the
  // tooltip to say plainly rather than overstated by the tick itself.
  await EvoltStore.updateMessage(payload.roomId, payload.messageId, { delivery: DELIVERY.DELIVERED });
  markDelivery(payload.messageId, DELIVERY.DELIVERED);
}

function appendSystemNote(text) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.style.alignSelf = 'center';
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function renderMessage(msg) {
  const room = state.activeRoom;
  const container = document.getElementById('messages');
  const mine = msg.sender_id === state.user.id;

  const wrapper = document.createElement('div');
  wrapper.id = `msg-${msg.id}`;
  wrapper.className = `msg ${mine ? 'mine' : 'theirs'}` + (msg.disappearing ? ' burn-flag' : '');

  const passphrase = getPassphrase(room.id, msg.key_epoch);
  let plaintext = null;

  if (passphrase) {
    if (msg.kind === 'text') {
      plaintext = await VaultCrypto.decryptText(passphrase, room.id, msg.key_epoch, msg.window_index, msg.ciphertext, msg.iv);
    } else {
      plaintext = '__file__'; // file messages are "decryptable" if we have the key; actual bytes fetched on demand
    }
  }

  if (plaintext === null) {
    wrapper.classList.add('locked');
    wrapper.innerHTML = `<span class="lock-icon">🔒</span>${VaultCrypto.cipherGlyphs(msg.id)}`;
    wrapper.title = 'Enter the room passphrase to decrypt this message';
  } else if (msg.kind === 'file') {
    renderFileMessage(wrapper, msg, passphrase);
  } else {
    const textEl = document.createElement('div');
    textEl.textContent = plaintext;
    wrapper.appendChild(textEl);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Delivery state belongs only on your own messages - on someone else's it
  // would be meaningless, and on a received one it is always "here".
  if (mine) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(tick);
  }
  wrapper.appendChild(meta);
  if (mine) markDelivery(msg.id, msg.delivery || DELIVERY.PENDING);

  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;

  // Burn-after-view: only the *recipient's* client reports a view, and only
  // once the message has actually scrolled into the viewport.
  //
  // Text only. A file message is just a chip with a "Download & decrypt"
  // button - scrolling it into view means the recipient has SEEN the chip,
  // not the file. Burning on that deletes the blob server-side before they
  // can ever click it, so the download always 404s. Files burn in
  // downloadFile() instead, once the bytes have actually been decrypted.
  // Applies in paired rooms too now - the burn travels peer-to-peer rather
  // than through a server row. See consumeMessage().
  if (!mine && msg.disappearing && !msg.consumed && plaintext !== null
      && msg.kind !== 'file') {
    observeForBurn(wrapper, msg);
  }
}

function observeForBurn(el, msg) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        consumeMessage(msg);
        observer.disconnect();
        state.observers.delete(msg.id);
      }
    });
  }, { threshold: 0.8 });
  observer.observe(el);
  state.observers.set(msg.id, observer);
}

// ---------- Burn-after-view, peer-to-peer ----------
//
// The old flow deleted the server's row and let the server tell everyone.
// A P2P message has no such row - each device's own copy IS the message -
// so the burn has to travel the same path the message did.
//
// The semantics, chosen deliberately and stated in the UI:
//   "first recipient to read it burns it for everyone connected."
//
// The alternative - wait until every peer has read it - sounds stricter but
// is worse: in a mesh where peers come and go there is no reliable moment
// when "everyone" has been counted, so a message would linger indefinitely
// whenever one member went offline, which is the opposite of what someone
// enabling disappearing messages is asking for. Burning on first read is
// predictable, and it errs toward deleting too eagerly rather than
// retaining too long.
//
// What it honestly cannot do: reach a peer who was offline for the burn
// (they never received the message either, since there's no mailbox), or
// stop anyone who already read it from having screenshotted or copied it.
// No disappearing-message system can do the latter.

async function consumeMessage(msg) {
  const room = state.activeRoom;
  if (!room) return;

  if (room.local || !state.socket) {
    // Pure P2P: tell peers directly, then delete our own copy.
    const transport = activeTransport();
    if (transport) transport.broadcast({ type: 'burn', roomId: room.id, messageId: msg.id });
    await burnLocally(msg.id, msg.file_id);
    return;
  }

  // Server-backed room. Text and P2P-transferred files have no server row,
  // so tell peers directly as well; the socket call still matters for
  // legacy server-held file messages.
  const transport = activeTransport();
  if (transport) transport.broadcast({ type: 'burn', roomId: room.id, messageId: msg.id });
  state.socket.emit('message:viewed', { roomId: room.id, messageId: msg.id });
  await burnLocally(msg.id, msg.file_id);
}

async function onPeerBurn(payload) {
  if (!state.activeRoom || payload.roomId !== state.activeRoom.id) return;
  await burnLocally(payload.messageId, null);
}

// Removes a message from this device: the DOM node, the IndexedDB row, and
// any file bytes it owned. Nothing here is recoverable afterwards.
async function burnLocally(messageId, fileIdHint) {
  const el = document.getElementById(`msg-${messageId}`);
  const fileId = fileIdHint || (el && el.dataset.fileId) || null;
  if (el) {
    el.classList.add('burning');
    setTimeout(() => el.remove(), 250);
  }
  const observer = state.observers.get(messageId);
  if (observer) {
    observer.disconnect();
    state.observers.delete(messageId);
  }
  const roomId = state.activeRoom?.id;
  if (roomId) await EvoltStore.deleteMessage(roomId, messageId).catch(() => {});
  if (fileId) await EvoltStore.deleteFileBlob(fileId).catch(() => {});
}

// ---------- Files ----------

document.getElementById('attach-btn').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await sendFile(file);
});

// Formats that are already compressed - gzip-ing these again wastes CPU and
// battery for negligible or negative size savings, so skip it for them.
const ALREADY_COMPRESSED_EXT = new Set([
  'zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic',
  'mp3', 'mp4', 'mov', 'm4a', 'aac', 'ogg', 'webm', 'mkv',
  'pdf', // pdf content streams are typically already deflate-compressed
]);

function shouldCompress(filename, byteLength) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ALREADY_COMPRESSED_EXT.has(ext)) return false;
  if (byteLength < 1024) return false; // not worth it for tiny files
  return true;
}

async function sendFile(file) {
  const room = state.activeRoom;
  const epoch = room.key_epoch;
  const passphrase = getPassphrase(room.id, epoch);
  if (!passphrase) return promptForPassphrase(room.id, epoch, false);

  const windowIndex = room.windowIndex ?? 0;
  let bytes = await file.arrayBuffer();
  const originalLength = bytes.byteLength;

  // Compress BEFORE encrypting, never after - encrypted bytes are
  // indistinguishable from random noise and won't compress at all, so
  // compression only helps when it happens on the plaintext first.
  let wasCompressed = false;
  if (shouldCompress(file.name, originalLength)) {
    const compressedBytes = pako.gzip(new Uint8Array(bytes));
    // Only keep the compressed version if it's actually smaller - some
    // small/incompressible files can come out larger with gzip overhead.
    if (compressedBytes.byteLength < originalLength) {
      bytes = compressedBytes.buffer;
      wasCompressed = true;
    }
  }

  const { ciphertext, iv } = await VaultCrypto.encryptBytes(passphrase, room.id, epoch, windowIndex, bytes);
  const nameEnc = await VaultCrypto.encryptText(passphrase, room.id, epoch, windowIndex, file.name);

  // Everything the recipient needs to decrypt travels in the message
  // envelope, not in server columns - the server is not in this path at all
  // any more. The bytes go over the data channel (see filetransfer.js).
  const fileId = crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const msg = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    room_id: room.id,
    sender_id: state.user.id,
    sender_username: state.user.username,
    kind: 'file',
    file_id: fileId,
    iv,
    enc_name: nameEnc.ciphertext,
    name_iv: nameEnc.iv,
    compressed: wasCompressed,
    plain_size: originalLength,
    key_epoch: epoch,
    window_index: windowIndex,
    created_at: Date.now(),
    disappearing: !!room.disappearing_enabled,
    consumed: false,
    delivery: DELIVERY.PENDING,
  };

  // Keep our own copy first, so the sender can still open what they sent
  // even if every peer drops mid-transfer - and so the outbox can retry it.
  await EvoltStore.putFileBlob(fileId, ciphertext);
  await EvoltStore.addMessage(room.id, msg);
  await renderMessage(msg);

  updatePeerStatusUI();
  await flushOutbox(room.id);
}

// Updates the little status line on a file chip mid-transfer. Passing null
// clears it and restores the download button.
function setFileChipStatus(messageId, text) {
  const el = document.getElementById(`msg-${messageId}`);
  const status = el && el.querySelector('.file-status');
  if (!status) return;
  status.textContent = text || '';
  const btn = el.querySelector('.file-chip button');
  if (btn) btn.classList.toggle('hidden', !!text);
}

// ---------- Incoming file chunks ----------

const fileReceiver = new EvoltFiles.Receiver();

async function onFileMeta(payload) {
  const msg = payload.msg;
  if (!state.activeRoom || msg.room_id !== state.activeRoom.id) return;
  fileReceiver.begin(msg);
  await EvoltStore.addMessage(msg.room_id, msg);
  await renderMessage(msg);
  setFileChipStatus(msg.id, 'Receiving 0%');
}

function onFileChunk(payload) {
  const fraction = fileReceiver.chunk(payload.fileId, payload.seq, payload.data);
  if (fraction === null) return;
  const el = document.querySelector(`[data-file-id="${payload.fileId}"]`);
  if (el) setFileChipStatus(el.id.replace('msg-', ''), `Receiving ${Math.round(fraction * 100)}%`);
}

async function onFileEnd(payload) {
  const done = fileReceiver.end(payload.fileId);
  const el = document.querySelector(`[data-file-id="${payload.fileId}"]`);
  const messageId = el && el.id.replace('msg-', '');
  if (!done) {
    if (messageId) setFileChipStatus(messageId, 'Transfer incomplete');
    return;
  }
  await EvoltStore.putFileBlob(done.msg.file_id, done.ciphertext);
  ackMessage(done.msg.room_id, done.msg.id);
  if (messageId) setFileChipStatus(messageId, null);
}

function renderFileMessage(wrapper, msg, passphrase) {
  wrapper.dataset.fileId = msg.file_id;
  const chip = document.createElement('div');
  chip.className = 'file-chip';
  chip.innerHTML = `📎 <span>Encrypted file</span> <button>Download &amp; decrypt</button>`
    + `<span class="file-status"></span>`;
  chip.querySelector('button').addEventListener('click', () => downloadFile(msg, passphrase));
  wrapper.appendChild(chip);
}

// Reads the encrypted bytes from wherever they actually are: the on-device
// store for anything transferred peer-to-peer, or the legacy server
// endpoint for file messages sent before the transfer moved off it.
async function fetchFileCiphertext(msg) {
  const local = await EvoltStore.getFileBlob(msg.file_id).catch(() => null);
  if (local) {
    return {
      ciphertext: local,
      iv: msg.iv,
      encName: msg.enc_name,
      nameIv: msg.name_iv,
      keyEpoch: msg.key_epoch,
      windowIndex: msg.window_index,
      wasCompressed: !!msg.compressed,
    };
  }

  if (isLocalOnly()) return { error: 'Those file bytes never arrived on this device.' };

  const res = await fetch(`${serverBase()}/api/download/${msg.file_id}`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { error: data.error || `Download failed (${res.status})` };
  }
  return {
    ciphertext: await res.arrayBuffer(),
    iv: res.headers.get('X-File-Iv'),
    encName: decodeURIComponent(res.headers.get('X-File-Enc-Name')),
    nameIv: res.headers.get('X-File-Name-Iv'),
    keyEpoch: Number(res.headers.get('X-File-Key-Epoch')),
    windowIndex: Number(res.headers.get('X-File-Window-Index')),
    wasCompressed: res.headers.get('X-File-Compressed') === 'true',
  };
}

async function downloadFile(msg, passphrase) {
  const room = state.activeRoom;
  const src = await fetchFileCiphertext(msg);
  if (src.error) return appendSystemNote(src.error);
  const { ciphertext: cipherBuf, iv, encName, nameIv, keyEpoch, windowIndex, wasCompressed } = src;

  let plainBuf = await VaultCrypto.decryptBytes(passphrase, room.id, keyEpoch, windowIndex, cipherBuf, iv);
  const name = await VaultCrypto.decryptText(passphrase, room.id, keyEpoch, windowIndex, encName, nameIv);
  if (!plainBuf || name === null) return appendSystemNote('Could not decrypt file with the current passphrase.');

  if (wasCompressed) {
    try {
      plainBuf = pako.ungzip(new Uint8Array(plainBuf)).buffer;
    } catch (e) {
      return appendSystemNote('File decrypted but decompression failed - it may be corrupted.');
    }
  }

  const blob = new Blob([plainBuf]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);

  if (msg.disappearing && !msg.consumed && msg.sender_id !== state.user.id) {
    await consumeMessage(msg);
  }
}

// ---------- Room drawer (small screens) ----------
//
// On a phone the rail is an overlay rather than a column. Without something
// to open it, every room action - new, join, pair, switching room - is
// unreachable, which is what made the installed build a dead end.

const rail = document.getElementById('rail');
const railBackdrop = document.getElementById('rail-backdrop');

function setRailOpen(open) {
  rail.classList.toggle('open', open);
  railBackdrop.classList.toggle('hidden', !open);
  document.getElementById('rail-toggle').setAttribute('aria-expanded', String(open));
}

document.getElementById('rail-toggle').addEventListener('click', () => {
  setRailOpen(!rail.classList.contains('open'));
});
railBackdrop.addEventListener('click', () => setRailOpen(false));

// ---------- Joining an existing server-backed room ----------
//
// The API has supported this all along (POST /api/rooms/:id/join) but
// nothing called it, so two people could not actually end up in the same
// room through the UI. Membership only grants relay access - the
// passphrase still travels out-of-band, so joining reveals nothing.

const joinModal = document.getElementById('join-modal');
document.getElementById('join-room-btn').addEventListener('click', () => {
  document.getElementById('join-error').textContent = '';
  document.getElementById('join-room-input').value = '';
  joinModal.classList.remove('hidden');
  setTimeout(() => document.getElementById('join-room-input').focus(), 0);
});
document.getElementById('join-modal-cancel').addEventListener('click', () => {
  joinModal.classList.add('hidden');
});

async function doJoinRoom() {
  const errEl = document.getElementById('join-error');
  const roomId = document.getElementById('join-room-input').value.trim();
  if (!roomId) return (errEl.textContent = 'Paste a room ID first.');
  errEl.textContent = '';
  try {
    await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST' });
    await refreshRoomList();
    await openRoom(roomId);
    // Closed only once the room is actually open, so a failure part-way
    // still has somewhere to report itself.
    joinModal.classList.add('hidden');
  } catch (e) {
    // A wrong id and a room you can't see are the same 404 by design, so
    // don't dress it up as anything more specific than it is.
    errEl.textContent = `Could not join: ${e.message}`;
  }
}
document.getElementById('join-modal-go').addEventListener('click', doJoinRoom);
document.getElementById('join-room-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoinRoom();
  if (e.key === 'Escape') joinModal.classList.add('hidden');
});

document.getElementById('copy-room-id').addEventListener('click', async (e) => {
  if (!state.activeRoom) return;
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(state.activeRoom.id);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1500);
  } catch {
    appendSystemNote(`Room ID: ${state.activeRoom.id}`);
  }
});

// ---------- Direct pairing (same Wi-Fi / offline, no server) ----------
//
// See public/js/pairing.js for why this is a manual code exchange rather
// than automatic LAN discovery (short version: browsers have no mDNS or
// UDP-broadcast API, by design). The two codes are the entire handshake;
// after that the devices talk straight to each other.

const pairModal = document.getElementById('pair-modal');
let pendingPair = null;      // the in-progress DirectPeer on side A
// When set, the pairing flow re-establishes THIS existing room instead of
// minting a new one. The room id rides inside the invite code, so the other
// device re-adopts the same room and both keep their history.
let reconnectingRoom = null;

// A paired room's channel cannot resume itself: WebRTC needs a fresh SDP
// exchange for every connection, and a browser has no way to reach the
// other device to perform one - no socket to listen on, no mDNS, and by
// design no server in this mode. So "surviving a reconnect" means keeping
// everything AROUND the channel (the room, its history, its passphrase if
// you allow it, and which side offers) so getting back is one scan, not a
// fresh setup.
function showReconnectBarIfNeeded() {
  const bar = document.getElementById('reconnect-bar');
  const room = state.activeRoom;
  if (!room || !room.local) return bar.classList.add('hidden');

  const live = activeTransport()?.isConnectedToAnyPeer();
  bar.classList.toggle('hidden', !!live);
  if (!live) {
    document.getElementById('reconnect-text').textContent = room.initiator
      ? 'Not connected. Reconnect and show the code to the other device.'
      : 'Not connected. Reconnect and scan the code from the other device.';
  }
}

document.getElementById('reconnect-btn').addEventListener('click', () => {
  const room = state.activeRoom;
  if (!room || !room.local) return;
  reconnectingRoom = room;
  pairError(''); pairStatus('');
  // Drop the stale transport first; a half-dead PeerConnection lingering in
  // directPeers would keep reporting a peer that isn't there.
  const old = state.directPeers.get(room.id);
  if (old) { old.disconnect(); state.directPeers.delete(room.id); }

  // Put them straight on the side they were on last time, so the two
  // devices don't both sit waiting for the other to produce a code.
  selectPairTab(room.initiator ? 'start' : 'join');
  document.getElementById('pair-remember-pass').checked = isPassphraseRemembered(room.id);
  resetPairPanes();
  pairModal.classList.remove('hidden');
  pairStatus(`Reconnecting to “${room.name}” — your history stays.`);
  if (room.initiator) document.getElementById('pair-create').click();
});

function selectPairTab(which) {
  document.querySelectorAll('[data-pair-tab]').forEach((t) => {
    t.classList.toggle('active', t.dataset.pairTab === which);
  });
  document.getElementById('pair-start').classList.toggle('hidden', which !== 'start');
  document.getElementById('pair-join').classList.toggle('hidden', which === 'start');
}

// Clears anything left from a previous exchange so a stale code can't be
// re-submitted against a fresh connection.
function resetPairPanes() {
  ['pair-offer-out', 'pair-answer-in', 'pair-offer-in', 'pair-answer-out']
    .forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('pair-step2').classList.add('hidden');
  document.getElementById('pair-join-step2').classList.add('hidden');
}

document.getElementById('pair-remember-pass').addEventListener('change', (e) => {
  const room = reconnectingRoom || state.activeRoom;
  if (!room) return;
  setPassphraseRemembered(room.id, e.currentTarget.checked, room.key_epoch);
});

function pairStatus(text) { document.getElementById('pair-status').textContent = text; }
function pairError(text) { document.getElementById('pair-error').textContent = text; }

document.getElementById('pair-btn').addEventListener('click', () => {
  pairError(''); pairStatus('');
  pairModal.classList.remove('hidden');
});
document.getElementById('pair-modal-close').addEventListener('click', () => {
  pairModal.classList.add('hidden');
});

document.querySelectorAll('[data-pair-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-pair-tab]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const start = tab.dataset.pairTab === 'start';
    document.getElementById('pair-start').classList.toggle('hidden', !start);
    document.getElementById('pair-join').classList.toggle('hidden', start);
    pairError(''); pairStatus('');
  });
});

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    pairStatus('Clipboard blocked — select the code and copy it manually.');
  }
}

// Wires a freshly-paired transport into the app and opens its room.
async function adoptPairedRoom(room, peer) {
  await EvoltStore.saveLocalRoom(room);
  state.directPeers.set(room.id, peer);
  reconnectingRoom = null;
  await refreshRoomList();
  await openRoom(room.id);
  pairModal.classList.add('hidden');
  // The passphrase is still shared out-of-band, exactly as for server rooms -
  // pairing establishes the pipe, never the key.
  if (!getPassphrase(room.id, room.key_epoch)) {
    promptForPassphrase(room.id, room.key_epoch, !!room.isAdmin);
  }
}

function newDirectPeer(useStun) {
  return new EvoltPairing.DirectPeer({
    useStun,
    onMessage: onP2PMessage,
    onStatus: onPeerStatus,
  });
}

// --- Side A: generate an invite, then consume the reply ---
document.getElementById('pair-create').addEventListener('click', async () => {
  pairError('');
  const btn = document.getElementById('pair-create');
  btn.disabled = true;
  pairStatus('Gathering local network addresses…');
  try {
    const useStun = document.getElementById('pair-use-stun').checked;
    const now = Date.now();
    // Reconnecting reuses the existing room wholesale - same id, same epoch
    // start - so the far side re-adopts the room it already has instead of
    // creating a second one, and both keep their message history.
    const room = reconnectingRoom || {
      id: crypto.randomUUID ? crypto.randomUUID() : `local-${now}-${Math.random().toString(36).slice(2)}`,
      name: document.getElementById('pair-room-name').value.trim() || 'Direct room',
      local: true,
      key_epoch: 1,
      // Both devices must agree on these or their derivation windows drift
      // apart, so they ride along inside the invite code.
      rotation_seconds: 300,
      epoch_started_at: now,
      disappearing_enabled: false,
      isAdmin: true,
      // Remembered so a later reconnect puts each device back on the side it
      // was on, rather than both waiting for the other to offer.
      initiator: true,
    };
    pendingPair = newDirectPeer(useStun);
    pendingPair._room = room;
    const code = await pendingPair.createInvite(room);
    document.getElementById('pair-offer-out').value = code;
    document.getElementById('pair-step2').classList.remove('hidden');
    const shown = EvoltPairing.drawQr(document.getElementById('pair-offer-qr'), code);
    document.getElementById('pair-offer-qr').classList.toggle('hidden', !shown);
    pairStatus(shown
      ? `Invite ready — let them scan the square, or send them the ${code.length}-character code.`
      : `Invite code ready (${code.length} characters) — too long for a QR, so send the code itself.`);
  } catch (e) {
    pairError(`Could not create an invite: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ---------- QR scanning ----------
//
// Only offered where the browser can actually do it (BarcodeDetector is
// Android/ChromeOS Chrome, not most desktops). Everywhere else the paste
// field is the route, and no dead button is shown.

let scanCancelled = false;

function revealScanButtons() {
  const supported = EvoltPairing.canScan();
  document.getElementById('pair-scan-offer').classList.toggle('hidden', !supported);
  document.getElementById('pair-scan-answer').classList.toggle('hidden', !supported);
}
revealScanButtons();

async function runScan(targetTextareaId) {
  const panel = document.getElementById('pair-scanner');
  const video = document.getElementById('pair-video');
  scanCancelled = false;
  panel.classList.remove('hidden');
  pairError('');
  pairStatus('Point the camera at the other device’s QR.');
  try {
    const text = await EvoltPairing.scanQr(video, () => scanCancelled);
    document.getElementById(targetTextareaId).value = text;
    pairStatus('Scanned.');
  } catch (e) {
    pairError(e.message);
    pairStatus('');
  } finally {
    panel.classList.add('hidden');
  }
}

document.getElementById('pair-scan-offer').addEventListener('click', () => runScan('pair-offer-in'));
document.getElementById('pair-scan-answer').addEventListener('click', () => runScan('pair-answer-in'));
document.getElementById('pair-scan-cancel').addEventListener('click', () => { scanCancelled = true; });

document.getElementById('pair-copy-offer').addEventListener('click', (e) =>
  copyToClipboard(document.getElementById('pair-offer-out').value, e.currentTarget));
document.getElementById('pair-copy-answer').addEventListener('click', (e) =>
  copyToClipboard(document.getElementById('pair-answer-out').value, e.currentTarget));

document.getElementById('pair-complete').addEventListener('click', async () => {
  pairError('');
  const code = document.getElementById('pair-answer-in').value.trim();
  if (!code) return pairError('Paste the reply code from the other device first.');
  if (!pendingPair) return pairError('Generate an invite code first.');
  try {
    pairStatus('Connecting…');
    await pendingPair.completeInvite(code);
    const peer = pendingPair;
    const room = peer._room;
    pendingPair = null;
    await adoptPairedRoom(room, peer);
  } catch (e) {
    pairError(`That reply code didn’t work: ${e.message}`);
  }
});

// --- Side B: consume the invite, hand back a reply ---
document.getElementById('pair-accept').addEventListener('click', async () => {
  pairError('');
  const code = document.getElementById('pair-offer-in').value.trim();
  if (!code) return pairError('Paste the invite code you were given first.');
  try {
    pairStatus('Gathering local network addresses…');
    const useStun = document.getElementById('pair-use-stun').checked;
    const peer = newDirectPeer(useStun);
    const { room, replyCode } = await peer.acceptInvite(code);
    document.getElementById('pair-answer-out').value = replyCode;
    document.getElementById('pair-join-step2').classList.remove('hidden');
    const shown = EvoltPairing.drawQr(document.getElementById('pair-answer-qr'), replyCode);
    document.getElementById('pair-answer-qr').classList.toggle('hidden', !shown);
    pairStatus(shown ? 'Reply ready — let them scan it, or send the code back.'
                     : 'Reply code ready — send it back to them.');
    await adoptPairedRoom({ ...room, isAdmin: false, initiator: false }, peer);
    // adoptPairedRoom closes the modal; reopen so they can still copy the
    // reply code, which the other side is still waiting on.
    pairModal.classList.remove('hidden');
  } catch (e) {
    pairError(`That invite code didn’t work: ${e.message}`);
  }
});

// ---------- Admin panel ----------

const adminModal = document.getElementById('admin-modal');
document.getElementById('admin-panel-btn').addEventListener('click', () => {
  syncAdminModalFromRoom();
  adminModal.classList.remove('hidden');
});
document.getElementById('admin-modal-close').addEventListener('click', () => {
  adminModal.classList.add('hidden');
});

function syncAdminModalFromRoom() {
  const room = state.activeRoom;
  if (!room) return;
  document.getElementById('toggle-disappearing').setAttribute('aria-checked', String(!!room.disappearing_enabled));
  document.getElementById('admin-rotation-select').value = String(room.rotation_seconds);
}

// This is the admin "enable disappearing messages" control.
document.getElementById('toggle-disappearing').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const next = btn.getAttribute('aria-checked') !== 'true';
  btn.setAttribute('aria-checked', String(next));
  try {
    await api(`/api/rooms/${state.activeRoom.id}/disappearing`, {
      method: 'POST',
      body: JSON.stringify({ enabled: next }),
    });
  } catch (err) {
    btn.setAttribute('aria-checked', String(!next));
    alert(err.message);
  }
});

document.getElementById('admin-rotation-select').addEventListener('change', async (e) => {
  try {
    await api(`/api/rooms/${state.activeRoom.id}/rotation-seconds`, {
      method: 'POST',
      body: JSON.stringify({ seconds: Number(e.target.value) }),
    });
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('rotate-key-btn').addEventListener('click', async () => {
  const ok = await askConfirm({
    title: 'Rotate encryption key?',
    body: 'Everyone will need the new passphrase (shared outside Evolt) to keep reading messages after this.',
  });
  if (!ok) return;
  const updated = await api(`/api/rooms/${state.activeRoom.id}/rotate-key`, { method: 'POST' });
  Object.assign(state.activeRoom, updated);
  adminModal.classList.add('hidden');
  promptForPassphrase(state.activeRoom.id, updated.key_epoch, false);
});

// ---------- Utilities ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- PWA service worker ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
