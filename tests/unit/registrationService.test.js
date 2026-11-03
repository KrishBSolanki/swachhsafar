import { describe, expect, it } from 'vitest';
import { createMemoryDb, TEST_HASH_OPTIONS } from '../helpers/memoryDb.js';
import { createRegistrationService, RegistrationError } from '../../src/services/registrationService.js';
import { verifyPassword } from '../../src/utils/passwordHash.js';

const PASSWORD = 'safar2026x';

async function setup() {
  const db = await createMemoryDb();
  return { db, service: createRegistrationService({ db, hashOptions: TEST_HASH_OPTIONS }) };
}

describe('local registration (works offline: no network involved)', () => {
  it('stores a hashed user and a pending outbox operation atomically', async () => {
    const { db, service } = await setup();
    const user = await service.register({ email: '  Ravi@Example.com ', password: PASSWORD });

    expect(user).toMatchObject({ email: 'ravi@example.com', username: 'ravi@example.com', registration_status: 'pending', sync_status: 'pending' });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user).not.toHaveProperty('password_hash');

    const [row] = await db.query('SELECT * FROM users');
    expect(row.password_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, row.password_hash, row.password_salt)).toBe(true);

    const [op] = await db.query('SELECT * FROM sync_outbox');
    expect(op).toMatchObject({ entity_type: 'user', entity_id: user.id, operation: 'register', sync_status: 'pending', retry_count: 0 });
    const payload = JSON.parse(op.payload);
    expect(payload).toEqual({ id: user.id, username: 'ravi@example.com', email: 'ravi@example.com', created_at: user.created_at });
    expect(op.payload).not.toMatch(/password|salt|hash/i);
    expect(op.payload).not.toContain(PASSWORD);
  });

  it('rejects invalid input without writing anything', async () => {
    const { db, service } = await setup();
    const err = await service.register({ email: 'nope', password: 'short' }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrationError);
    expect(err.code).toBe('validation');
    expect(Object.keys(err.fieldErrors)).toEqual(['email', 'password']);
    expect(await db.query('SELECT * FROM users')).toEqual([]);
  });

  it('rejects a duplicate email regardless of case/whitespace (TEST 5, local)', async () => {
    const { db, service } = await setup();
    await service.register({ email: 'dup@example.com', password: PASSWORD });
    const err = await service.register({ email: ' DUP@example.COM ', password: 'other-pass9' }).catch((e) => e);
    expect(err.code).toBe('duplicate');
    expect(err.fieldErrors.email).toMatch(/already registered/);
    expect(await db.query('SELECT COUNT(*) AS n FROM users')).toEqual([{ n: 1 }]);
    expect(await db.query('SELECT COUNT(*) AS n FROM sync_outbox')).toEqual([{ n: 1 }]);
  });

  it('enforces uniqueness at the database level as well', async () => {
    const { db, service } = await setup();
    await Promise.allSettled([
      service.register({ email: 'race@example.com', password: PASSWORD }),
      service.register({ email: 'race@example.com', password: PASSWORD }),
    ]);
    expect(await db.query('SELECT COUNT(*) AS n FROM users')).toEqual([{ n: 1 }]);
  });
});
