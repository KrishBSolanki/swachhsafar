// Dedicated worker that owns the persistent SQLite database.
// Uses the OPFS "SyncAccessHandle Pool" VFS, which persists to the Origin Private File System
// and, unlike the plain "opfs" VFS, does not require COOP/COEP cross-origin isolation headers.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createOo1Adapter } from './oo1Adapter.js';

const DB_FILE = '/swachh_safar_local.db';
let adapter = null;
let info = null;

async function init() {
  if (adapter) return info;
  const sqlite3 = await sqlite3InitModule();
  let poolUtil;
  try {
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'swachh-safar-pool' });
  } catch (e) {
    const err = new Error(
      'Persistent storage (OPFS) is unavailable. Close other Swachh Safar tabs or use an up-to-date Chrome. ' +
        `(${e.message})`,
    );
    err.code = 'OPFS_UNAVAILABLE';
    throw err;
  }
  const db = new poolUtil.OpfsSAHPoolDb(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON;');
  adapter = createOo1Adapter(db);
  info = {
    filename: 'swachh_safar_local.db',
    vfs: 'opfs-sahpool',
    persistent: true,
    sqliteVersion: sqlite3.version.libVersion,
  };
  return info;
}

self.onmessage = async ({ data }) => {
  const { id, type, sql, params, statements } = data;
  try {
    let result;
    if (type === 'init') result = await init();
    else if (!adapter) throw new Error('Database not initialised');
    else if (type === 'query') result = await adapter.query(sql, params);
    else if (type === 'run') result = await adapter.run(sql, params);
    else if (type === 'transaction') result = await adapter.transaction(statements);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: { message: e.message, code: e.code || e.resultCode || null } });
  }
};
