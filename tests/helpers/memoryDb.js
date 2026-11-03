// Real SQLite (sqlite-wasm, in-memory) behind the same adapter the OPFS worker uses.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createOo1Adapter } from '../../src/database/oo1Adapter.js';
import { runMigrations } from '../../src/database/migrations.js';

let sqlite3Promise;

export async function createMemoryDb({ migrate = true } = {}) {
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  const db = createOo1Adapter(new sqlite3.oo1.DB(':memory:'));
  if (migrate) await runMigrations(db);
  return db;
}

// Fast hashing for tests; production uses the 600k-iteration default.
export const TEST_HASH_OPTIONS = { iterations: 1000 };
