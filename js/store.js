// public/js/store.js
//
// On-device message storage. Once messages travel peer-to-peer instead of
// through the server, there is no longer a central database row for them -
// each device's own copy in IndexedDB IS the record. This is intentional:
// it's what "no server holds your messages" actually means in practice.
//
// This is also the outbox. A message sent while nobody is connected stays
// here marked `pending` and is delivered the moment a peer appears - the
// queue lives on the SENDER's device rather than in a server mailbox, which
// is the only place it can live if no server is to hold content. The
// consequence, which the UI shows rather than hides: an undelivered message
// depends on the sender's device still existing and eventually being online
// at the same time as the recipient's.

const DB_NAME = 'evolt_local';
const DB_VERSION = 3;
const STORE = 'messages';
// Encrypted file bytes received over the data channel. Stored as ciphertext
// exactly as it arrived - decryption happens on download, so the plaintext
// never rests on disk, only in memory for as long as the save takes.
const FILE_STORE = 'file_blobs';
// Directly-paired rooms (see pairing.js) exist ONLY on the two devices that
// paired - there is no server row to list them from, so they live here.
const ROOM_STORE = 'local_rooms';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('room_id', 'room_id', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(ROOM_STORE)) {
        db.createObjectStore(ROOM_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLocalRoom(room) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, 'readwrite');
    tx.objectStore(ROOM_STORE).put({ ...room, local: true });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getLocalRooms() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, 'readonly');
    const req = tx.objectStore(ROOM_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getLocalRoom(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROOM_STORE, 'readonly');
    const req = tx.objectStore(ROOM_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function addMessage(roomId, msg) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...msg, room_id: roomId });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getMessages(roomId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('room_id');
    const req = idx.getAll(IDBKeyRange.only(roomId));
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => a.created_at - b.created_at);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

// Merges a patch into a stored message. Used mainly to move a message along
// its delivery states, which must persist: a queued message has to still be
// queued after the app is closed and reopened.
async function updateMessage(roomId, messageId, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(messageId);
    req.onsuccess = () => {
      // Gone (burned, most likely) - nothing to patch, and recreating it
      // here would resurrect a message someone deliberately destroyed.
      if (!req.result) return;
      store.put({ ...req.result, ...patch });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteMessage(roomId, messageId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(messageId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function putFileBlob(fileId, ciphertext) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put({ id: fileId, ciphertext });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getFileBlob(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const req = tx.objectStore(FILE_STORE).get(fileId);
    req.onsuccess = () => resolve(req.result ? req.result.ciphertext : null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteFileBlob(fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).delete(fileId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

window.EvoltStore = {
  addMessage, getMessages, updateMessage, deleteMessage,
  saveLocalRoom, getLocalRooms, getLocalRoom,
  putFileBlob, getFileBlob, deleteFileBlob,
};
