/* ICEBERG — local persistence.
 *
 * Three stores, three lifetimes:
 *   cache    chunk bytes keyed by content hash. Disposable; refetchable.
 *   session  the live session's drift and its submerged image. NOT disposable —
 *            losing it loses work the user has not calved yet.
 *   meta     small key/value: last vault head, identity, preferences.
 */

const DB_NAME = 'iceberg';
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Another Iceberg tab is holding the local store open.'));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Local store transaction aborted'));
  });
}

export const idb = {
  get:  (store, key)        => tx(store, 'readonly',  (s) => s.get(key)),
  set:  (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del:  (store, key)        => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store)             => tx(store, 'readonly',  (s) => s.getAllKeys()),
  clear:(store)             => tx(store, 'readwrite', (s) => s.clear()),

  async many(store, keys) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readonly');
      const s = t.objectStore(store);
      const out = new Map();
      for (const k of keys) {
        const r = s.get(k);
        r.onsuccess = () => { if (r.result !== undefined) out.set(k, r.result); };
      }
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  },

  async putMany(store, entries) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      for (const [k, v] of entries) s.put(v, k);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
};

/* ---- storage pressure ---------------------------------------------------- */

export async function storageReport() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota, ratio: quota ? usage / quota : 0 };
}

/** Ask the browser not to evict us. Chrome grants this silently after
 *  engagement; Safari is stricter. A refusal is reported, not hidden. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, granted: false };
  const already = await navigator.storage.persisted?.();
  if (already) return { supported: true, granted: true };
  const granted = await navigator.storage.persist();
  return { supported: true, granted };
}

/** Evict cached chunks — never session data — under storage pressure. */
export async function trimCache(targetRatio = 0.6) {
  const rep = await storageReport();
  if (!rep || rep.ratio < targetRatio) return 0;
  const keys = await idb.keys('cache');
  let removed = 0;
  // Oldest-first is not tracked per key; the cache is content-addressed and
  // refetchable, so a simple prefix sweep is honest and cheap.
  for (const k of keys) {
    await idb.del('cache', k);
    removed++;
    if (removed % 200 === 0) {
      const now = await storageReport();
      if (now && now.ratio < targetRatio * 0.8) break;
    }
  }
  return removed;
}
