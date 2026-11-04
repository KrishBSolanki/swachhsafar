// Main-thread client for the SQLite worker. Exposes the same async
// query/run/transaction interface as oo1Adapter, proxied over postMessage.
import { runMigrations } from './migrations.js';

let worker = null;
let nextId = 1;
const pending = new Map();
let initPromise = null;

function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
}

function startWorker() {
  worker = new Worker(new URL('./sqlite.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) {
      const err = new Error(data.error.message);
      err.code = data.error.code;
      if (data.error.name) err.name = data.error.name;
      entry.reject(err);
    } else {
      entry.resolve(data.result);
    }
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || 'SQLite worker crashed');
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };
}

const workerDb = {
  query: (sql, params) => call('query', { sql, params }),
  run: (sql, params) => call('run', { sql, params }),
  transaction: (statements) => call('transaction', { statements }),
};

// Media byte store in OPFS, owned by the same worker (see mediaStore.js for the interface).
const workerFiles = {
  write: (name, bytes) => call('file.write', { name, bytes }),
  read: (name) => call('file.read', { name }),
  remove: (name) => call('file.remove', { name }),
  list: () => call('file.list'),
};

// Opens swachh_safar_local.db in OPFS and brings the schema up to date.
// Resolves to { db, files, info, migration }. Safe to call repeatedly.
export function initDatabase() {
  if (!initPromise) {
    initPromise = (async () => {
      if (typeof Worker === 'undefined') throw new Error('Web Workers are not supported in this browser');
      // Browsers hide OPFS (navigator.storage.getDirectory) and crypto.subtle outside secure contexts.
      if (globalThis.isSecureContext === false) {
        const err = new Error(
          `Persistent storage (OPFS) requires HTTPS. This page was opened over ${location.protocol}//${location.host}; ` +
            `open https://${location.host} instead (or localhost on this device).`,
        );
        err.code = 'INSECURE_CONTEXT';
        throw err;
      }
      startWorker();
      const info = await call('init');
      const migration = await runMigrations(workerDb);
      // Only report ready once a real query against the migrated schema has succeeded.
      const [{ n }] = await workerDb.query('SELECT COUNT(*) AS n FROM users');
      return { db: workerDb, files: workerFiles, info: { ...info, localUsers: n }, migration };
    })().catch((e) => {
      worker?.terminate();
      worker = null;
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}
