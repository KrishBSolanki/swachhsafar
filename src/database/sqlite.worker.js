// Dedicated worker that owns the persistent SQLite database and the media files.
// Uses the OPFS "SyncAccessHandle Pool" VFS, which persists to the Origin Private File System
// and, unlike the plain "opfs" VFS, does not require COOP/COEP cross-origin isolation headers.
// Media bytes live beside it in the OPFS directory `swachh-media/`, written with synchronous access
// handles (worker-only API) and flushed before the write is reported as done.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createOo1Adapter } from './oo1Adapter.js';

const DB_FILE = '/swachh_safar_local.db';
const MEDIA_DIR = 'swachh-media';
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
let adapter = null;
let info = null;
let mediaDir = null;

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

async function dir() {
  mediaDir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(MEDIA_DIR, { create: true });
  return mediaDir;
}

function checkName(name) {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid media file name: ${name}`);
  return name;
}

const files = {
  async write(name, bytes) {
    const handle = await (await dir()).getFileHandle(checkName(name), { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      const written = access.write(bytes, { at: 0 });
      if (written !== bytes.byteLength) throw new Error(`Short write (${written}/${bytes.byteLength} bytes)`);
      access.flush();
    } finally {
      access.close();
    }
    return bytes.byteLength;
  },
  async read(name) {
    try {
      const file = await (await (await dir()).getFileHandle(checkName(name))).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  },
  async remove(name) {
    try {
      await (await dir()).removeEntry(checkName(name));
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    return null;
  },
  async list() {
    const names = [];
    for await (const [name, handle] of (await dir()).entries()) if (handle.kind === 'file') names.push(name);
    return names;
  },
};

self.onmessage = async ({ data }) => {
  const { id, type, sql, params, statements, name, bytes } = data;
  try {
    let result;
    let transfer = [];
    if (type === 'init') result = await init();
    else if (type === 'file.write') result = await files.write(name, bytes);
    else if (type === 'file.read') {
      result = await files.read(name);
      if (result) transfer = [result.buffer];
    } else if (type === 'file.remove') result = await files.remove(name);
    else if (type === 'file.list') result = await files.list();
    else if (!adapter) throw new Error('Database not initialised');
    else if (type === 'query') result = await adapter.query(sql, params);
    else if (type === 'run') result = await adapter.run(sql, params);
    else if (type === 'transaction') result = await adapter.transaction(statements);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: { message: e.message, code: e.code || e.resultCode || null, name: e.name || null } });
  }
};
