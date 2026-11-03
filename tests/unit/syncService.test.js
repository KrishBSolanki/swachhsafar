import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryDb, TEST_HASH_OPTIONS } from '../helpers/memoryDb.js';
import { createFakeFirebase } from '../helpers/fakeFirebase.js';
import { createRegistrationService } from '../../src/services/registrationService.js';
import { createSyncService } from '../../src/services/syncService.js';

const PASSWORD = 'safar2026x';
const services = [];

async function setup({ online = true, firebase = createFakeFirebase() } = {}) {
  const db = await createMemoryDb();
  const net = { online };
  const registration = createRegistrationService({ db, hashOptions: TEST_HASH_OPTIONS });
  const sync = createSyncService({
    db, getAuthService: async () => firebase.service, isOnline: () => net.online, timeoutMs: 1000, locks: null,
  });
  services.push(sync);
  return { db, net, registration, sync, firebase };
}

afterEach(() => services.splice(0).forEach((s) => s.dispose()));

const userRow = async (db, id) => (await db.query('SELECT * FROM users WHERE id = ?', [id]))[0];
const outboxRow = async (db, id) => (await db.query('SELECT * FROM sync_outbox WHERE entity_id = ?', [id]))[0];

describe('online registration (TEST 1)', () => {
  it('creates the Firebase account and profile, then marks everything synced', async () => {
    const { db, registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'online@example.com', password: PASSWORD });
    const result = await sync.syncNewRegistration(user.id, PASSWORD);

    expect(result).toMatchObject({ status: 'synced', firebaseUid: 'uid-1' });
    expect(firebase.accounts.get('online@example.com')).toMatchObject({ uid: 'uid-1' });
    const profile = firebase.profiles.get(user.id);
    expect(profile).toEqual({
      uuid: user.id, auth_uid: 'uid-1', username: 'online@example.com', email: 'online@example.com',
      registered_at: user.created_at, account_status: 'active', source: 'pwa',
    });
    expect(await userRow(db, user.id)).toMatchObject({
      registration_status: 'registered', sync_status: 'synced', firebase_uid: 'uid-1', cloud_profile_id: user.id,
    });
    expect(await outboxRow(db, user.id)).toMatchObject({ sync_status: 'completed' });
    expect(sync.getState()).toMatchObject({ pendingCount: 0, lastSyncAt: expect.any(String) });
  });
});

describe('offline registration and reconnection (TEST 2 & 4)', () => {
  it('does nothing while offline, then asks for the password once online', async () => {
    const { db, net, registration, sync, firebase } = await setup({ online: false });
    const user = await registration.register({ email: 'offline@example.com', password: PASSWORD });

    expect((await sync.sync()).status).toBe('offline');
    expect(firebase.calls.createAccount).toBe(0);
    expect(sync.getState()).toMatchObject({ pendingCount: 1, lastSyncAt: null });

    net.online = true;
    await sync.sync({ trigger: 'reconnect' });
    expect(sync.getState().needsPassword).toEqual([user.id]);
    expect(firebase.calls.createAccount).toBe(0);
    expect((await outboxRow(db, user.id)).sync_status).toBe('pending');

    expect(await sync.provideCredential(user.id, 'wrong-pass1')).toEqual({ ok: false, reason: 'invalid_password' });
    expect(firebase.calls.createAccount).toBe(0);

    const ok = await sync.provideCredential(user.id, PASSWORD);
    expect(ok).toMatchObject({ ok: true, result: { status: 'synced' } });
    expect(firebase.profiles.has(user.id)).toBe(true);
    expect((await outboxRow(db, user.id)).sync_status).toBe('completed');
    expect(sync.getState()).toMatchObject({ pendingCount: 0, needsPassword: [] });
  });
});

describe('cloud duplicates (TEST 5)', () => {
  it('links to an existing account with the same password instead of creating another', async () => {
    const firebase = createFakeFirebase();
    firebase.accounts.set('dup@example.com', { uid: 'uid-existing', password: PASSWORD });
    const { db, registration, sync } = await setup({ firebase });
    const user = await registration.register({ email: 'dup@example.com', password: PASSWORD });

    const result = await sync.syncNewRegistration(user.id, PASSWORD);
    expect(result).toMatchObject({ status: 'synced', firebaseUid: 'uid-existing' });
    expect(firebase.accounts.size).toBe(1);
    expect((await userRow(db, user.id)).firebase_uid).toBe('uid-existing');
  });

  it('marks a conflict (no new account) when the email exists with another password', async () => {
    const firebase = createFakeFirebase();
    firebase.accounts.set('taken@example.com', { uid: 'uid-other', password: 'someone-elses9' });
    const { db, registration, sync } = await setup({ firebase });
    const user = await registration.register({ email: 'taken@example.com', password: PASSWORD });

    const result = await sync.syncNewRegistration(user.id, PASSWORD);
    expect(result).toMatchObject({ status: 'failed', code: 'cloud_conflict' });
    expect(firebase.accounts.size).toBe(1);
    expect(firebase.profiles.size).toBe(0);
    expect(await userRow(db, user.id)).toMatchObject({ registration_status: 'conflict', sync_status: 'failed' });
    expect((await outboxRow(db, user.id)).sync_status).toBe('failed');

    // Retry requeues it; the record is kept.
    await sync.retry(user.id);
    expect(await userRow(db, user.id)).toMatchObject({ registration_status: 'pending', sync_status: 'pending' });
    expect((await outboxRow(db, user.id)).sync_status).toBe('pending');
  });

  it('does not duplicate a profile that already exists under another device UUID', async () => {
    const firebase = createFakeFirebase();
    const { registration, sync } = await setup({ firebase });
    const first = await registration.register({ email: 'multi@example.com', password: PASSWORD });
    await sync.syncNewRegistration(first.id, PASSWORD);

    firebase.clearSession();
    const device2 = await setup({ firebase });
    const second = await device2.registration.register({ email: 'multi@example.com', password: PASSWORD });
    const result = await device2.sync.syncNewRegistration(second.id, PASSWORD);

    expect(result).toMatchObject({ status: 'synced', linkedExisting: true });
    expect(firebase.accounts.size).toBe(1);
    expect([...firebase.profiles.keys()]).toEqual([first.id]);
    expect((await userRow(device2.db, second.id)).cloud_profile_id).toBe(first.id);
  });
});

describe('sync failures (TEST 6)', () => {
  it('keeps the record and outbox pending on a network failure, then succeeds on retry', async () => {
    const { db, registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'flaky@example.com', password: PASSWORD });
    firebase.failNext('createAccount', 'auth/network-request-failed');

    const result = await sync.syncNewRegistration(user.id, PASSWORD);
    expect(result).toMatchObject({ status: 'retry', retryCount: 1 });
    expect(await userRow(db, user.id)).toMatchObject({ sync_status: 'pending', last_sync_error: expect.stringMatching(/Network/) });
    expect(await outboxRow(db, user.id)).toMatchObject({ sync_status: 'pending', retry_count: 1 });
    expect(sync.getState()).toMatchObject({ pendingCount: 1, nextRetryAt: expect.any(String) });

    // Password is still held in memory for this session, so a retry needs no user input.
    await sync.sync({ trigger: 'retry' });
    expect(await userRow(db, user.id)).toMatchObject({ sync_status: 'synced', last_sync_error: null });
    expect(firebase.accounts.size).toBe(1);
  });

  it('resumes a half-finished sync (account created, profile failed) without a second account or password', async () => {
    const { db, registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'half@example.com', password: PASSWORD });
    firebase.failNext('upsertProfile', 'unavailable');

    expect((await sync.syncNewRegistration(user.id, PASSWORD)).status).toBe('retry');
    expect(firebase.accounts.size).toBe(1);

    // New app session: in-memory password gone, Firebase session still persisted.
    const resumed = createSyncService({ db, getAuthService: async () => firebase.service, timeoutMs: 1000, locks: null });
    services.push(resumed);
    await resumed.start();
    expect(firebase.calls.createAccount).toBe(1);
    expect(firebase.profiles.has(user.id)).toBe(true);
    expect((await userRow(db, user.id)).sync_status).toBe('synced');
  });

  it('recovers when the account exists but the session was lost (re-entered password signs in)', async () => {
    const { db, registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'lost@example.com', password: PASSWORD });
    firebase.failNext('upsertProfile', 'unavailable');
    await sync.syncNewRegistration(user.id, PASSWORD);
    firebase.clearSession();

    const fresh = createSyncService({ db, getAuthService: async () => firebase.service, timeoutMs: 1000, locks: null });
    services.push(fresh);
    await fresh.start();
    expect(fresh.getState().needsPassword).toEqual([user.id]);
    expect((await fresh.provideCredential(user.id, PASSWORD)).result.status).toBe('synced');
    expect(firebase.calls).toMatchObject({ createAccount: 2, signIn: 1 });
    expect(firebase.accounts.size).toBe(1);
  });

  it('treats a hanging Firebase call as a retryable timeout', async () => {
    const firebase = createFakeFirebase();
    firebase.service.createAccount = () => new Promise(() => {});
    const { db, registration, sync } = await setup({ firebase });
    const user = await registration.register({ email: 'slow@example.com', password: PASSWORD });
    expect(await sync.syncNewRegistration(user.id, PASSWORD)).toMatchObject({ status: 'retry', code: 'sync/timeout' });
    expect((await outboxRow(db, user.id)).sync_status).toBe('pending');
  });

  it('leaves local data untouched when Firebase cannot even be initialised', async () => {
    const db = await createMemoryDb();
    const registration = createRegistrationService({ db, hashOptions: TEST_HASH_OPTIONS });
    const sync = createSyncService({ db, getAuthService: async () => { throw new Error('Firebase is not configured'); }, locks: null });
    services.push(sync);
    const user = await registration.register({ email: 'cfg@example.com', password: PASSWORD });
    await sync.syncNewRegistration(user.id, PASSWORD);
    expect(sync.getState().lastError).toMatch(/not configured/);
    expect((await outboxRow(db, user.id)).sync_status).toBe('pending');
  });
});

describe('idempotency and duplicate prevention', () => {
  it('coalesces concurrent triggers and creates the account once', async () => {
    const { registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'concurrent@example.com', password: PASSWORD });
    const credential = sync.provideCredential(user.id, PASSWORD);
    await Promise.all([sync.sync({ trigger: 'reconnect' }), sync.sync({ trigger: 'foreground' }), sync.sync(), credential]);
    expect(firebase.calls.createAccount).toBe(1);
    expect(firebase.profiles.size).toBe(1);
  });

  it('re-queues entries left "processing" by a closed app', async () => {
    const { db, registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'crash@example.com', password: PASSWORD });
    await db.run(`UPDATE sync_outbox SET sync_status = 'processing'`);
    await sync.start();
    expect((await outboxRow(db, user.id)).sync_status).toBe('pending');
    expect(sync.getState().needsPassword).toEqual([user.id]);
    expect(firebase.calls.createAccount).toBe(0);
  });

  it('a synced registration is never re-sent', async () => {
    const { registration, sync, firebase } = await setup();
    const user = await registration.register({ email: 'once@example.com', password: PASSWORD });
    await sync.syncNewRegistration(user.id, PASSWORD);
    await sync.sync();
    await sync.sync();
    expect(firebase.calls).toMatchObject({ createAccount: 1, upsertProfile: 1 });
  });
});
