// Tiny IndexedDB key-value store (folder handle, settings). Failures are swallowed:
// the app works without it, it just forgets between visits.

const DB = 'stomp-commander';
const STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

// Gives up after 2 s (a blocked or unavailable database must not stall the app).
function op(mode, fn) {
  const work = db().then(d => new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })).catch(() => undefined);
  return Promise.race([work, new Promise(resolve => setTimeout(resolve, 2000))]);
}

export const get = key => op('readonly', s => s.get(key));
export const set = (key, value) => op('readwrite', s => s.put(value, key));
