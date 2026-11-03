import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { getSchemaVersion, LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { createOutboxRepository } from '../../src/database/outboxRepository.js';

const columns = async (db, table) => (await db.query(`PRAGMA table_info(${table})`)).map((c) => c.name);

describe('migrations', () => {
  it('creates the Phase 1 schema from scratch', async () => {
    const db = await createMemoryDb({ migrate: false });
    const result = await runMigrations(db);
    expect(result).toEqual({ from: 0, to: LATEST_VERSION, applied: MIGRATIONS.map((m) => m.version) });

    expect(await columns(db, 'users')).toEqual(expect.arrayContaining([
      'id', 'username', 'email', 'password_hash', 'password_salt', 'registration_status', 'sync_status',
      'created_at', 'updated_at', 'firebase_uid', 'cloud_profile_id', 'last_sync_error', 'synced_at',
    ]));
    expect(await columns(db, 'sync_outbox')).toEqual(expect.arrayContaining([
      'id', 'entity_type', 'entity_id', 'operation', 'payload', 'retry_count', 'sync_status', 'created_at',
      'last_error', 'updated_at', 'completed_at',
    ]));
    expect(await columns(db, 'sync_meta')).toEqual(['key', 'value', 'updated_at']);
  });

  it('is idempotent on reopen', async () => {
    const db = await createMemoryDb();
    expect(await runMigrations(db)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION, applied: [] });
  });

  it('upgrades a v1 database while keeping its rows', async () => {
    const db = await createMemoryDb({ migrate: false });
    await db.transaction([...MIGRATIONS[0].statements.map((sql) => ({ sql })), { sql: 'PRAGMA user_version = 1' }]);
    await db.run(`INSERT INTO users (id, username, email, password_hash, password_salt, created_at, updated_at)
      VALUES ('u1', 'a@x.com', 'a@x.com', 'h', 's', 't', 't')`);
    await runMigrations(db);
    expect(await getSchemaVersion(db)).toBe(LATEST_VERSION);
    expect(await db.query('SELECT id, registration_status, sync_status, firebase_uid FROM users')).toEqual([
      { id: 'u1', registration_status: 'pending', sync_status: 'pending', firebase_uid: null },
    ]);
  });

  it('rolls back a failing transaction completely', async () => {
    const db = await createMemoryDb();
    await expect(db.transaction([
      { sql: `INSERT INTO sync_meta (key, value, updated_at) VALUES ('a', '1', 't')` },
      { sql: 'INSERT INTO no_such_table VALUES (1)' },
    ])).rejects.toThrow();
    expect(await db.query('SELECT * FROM sync_meta')).toEqual([]);
  });
});

describe('outbox repository', () => {
  const entry = (id, entityId = 'user-1') => ({
    id, entity_type: 'user', entity_id: entityId, operation: 'register', payload: { x: 1 }, created_at: '2026-01-01T00:00:00Z',
  });

  it('claims an entry only once', async () => {
    const db = await createMemoryDb();
    const outbox = createOutboxRepository(db);
    await db.transaction([outbox.insertStatement(entry('o1'))]);
    expect(await outbox.claim('o1', 'now')).toBe(true);
    expect(await outbox.claim('o1', 'now')).toBe(false);
    expect(await outbox.countPending()).toBe(1); // processing still counts as pending sync
  });

  it('prevents two open operations for the same entity', async () => {
    const db = await createMemoryDb();
    const outbox = createOutboxRepository(db);
    await db.transaction([outbox.insertStatement(entry('o1'))]);
    await expect(db.transaction([outbox.insertStatement(entry('o2'))])).rejects.toThrow(/UNIQUE/);
    await outbox.markCompleted('o1', 'now');
    await db.transaction([outbox.insertStatement(entry('o3'))]); // allowed once the first is completed
  });

  it('tracks retries, failures and recovery of interrupted work', async () => {
    const db = await createMemoryDb();
    const outbox = createOutboxRepository(db);
    await db.transaction([outbox.insertStatement(entry('o1'))]);
    await outbox.claim('o1', 'now');
    await outbox.markRetry('o1', { error: 'net', now: 'now' });
    expect(await outbox.findById('o1')).toMatchObject({ sync_status: 'pending', retry_count: 1, last_error: 'net' });

    await outbox.claim('o1', 'now');
    await outbox.recoverInterrupted('later');
    expect((await outbox.findById('o1')).sync_status).toBe('pending');

    await outbox.markFailed('o1', { error: 'conflict', now: 'now' });
    expect(await outbox.listPending()).toEqual([]);
    await outbox.resetFailed('o1', 'now');
    expect(await outbox.listPending()).toHaveLength(1);
  });

  it('stores sync metadata', async () => {
    const db = await createMemoryDb();
    const outbox = createOutboxRepository(db);
    expect(await outbox.getMeta('last_sync_at')).toBeNull();
    await outbox.setMeta('last_sync_at', 'a', 'a');
    await outbox.setMeta('last_sync_at', 'b', 'b');
    expect(await outbox.getMeta('last_sync_at')).toBe('b');
  });
});
