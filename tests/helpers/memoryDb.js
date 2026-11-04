// Real SQLite (sqlite-wasm) behind the same adapter the OPFS worker uses, with the same
// `PRAGMA foreign_keys = ON` the worker sets. `filename` (e.g. '/device.db') keeps the file in the
// wasm module's in-process filesystem, so a test can close the database and reopen it like a reload.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createOo1Adapter } from '../../src/database/oo1Adapter.js';
import { runMigrations } from '../../src/database/migrations.js';

let sqlite3Promise;

export async function createMemoryDb({ migrate = true, filename = ':memory:' } = {}) {
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  const raw = new sqlite3.oo1.DB(filename, 'c');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = createOo1Adapter(raw);
  if (migrate) await runMigrations(db);
  return db;
}

// Fast hashing for tests; production uses the 600k-iteration default.
export const TEST_HASH_OPTIONS = { iterations: 1000 };
