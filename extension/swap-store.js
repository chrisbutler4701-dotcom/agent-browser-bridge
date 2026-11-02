const DB = 'field-browser-private-swap';
const KEY = 'machine-key';
const STORAGE = 'privateSwapCiphertext';

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let pendingKey;
async function machineKey() {
  if (!pendingKey) pendingKey = openMachineKey().catch((error) => { pendingKey = null; throw error; });
  return pendingKey;
}

async function openMachineKey() {
  const db = await database();
  try {
    const existing = await new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await new Promise((resolve, reject) => {
      const request = db.transaction('keys', 'readwrite').objectStore('keys').put(key, KEY);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    return key;
  } finally { db.close(); }
}

export async function loadSwap() {
  const encrypted = (await chrome.storage.local.get(STORAGE))[STORAGE];
  if (!encrypted) return { roster: [], map: {} };
  const key = await machineKey();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(encrypted.iv) }, key, new Uint8Array(encrypted.data));
  const state = JSON.parse(new TextDecoder().decode(plain));
  delete state.map?.hashSalt;
  return state;
}

export async function saveSwap({ roster, map }) {
  delete map?.hashSalt;
  const key = await machineKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ roster, map })));
  await chrome.storage.local.set({ [STORAGE]: { iv: [...iv], data: [...new Uint8Array(data)] } });
}

export function normalizeRoster(items) {
  if (!Array.isArray(items)) throw new Error('Roster must be a list of clients.');
  return items.map((item) => {
    const name = String(item?.name || '').trim();
    if (!name) throw new Error('Every client needs a name.');
    const aliases = Array.isArray(item.aliases) ? item.aliases : String(item.aliases || '').split(/[;,]/u);
    return { name, aliases: aliases.map((alias) => String(alias).trim()).filter(Boolean), dob: String(item.dob || '').trim() };
  });
}
