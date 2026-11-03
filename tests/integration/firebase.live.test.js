// Live end-to-end sync against the real swachh-safar Firebase project.
// Run with:  npm run test:live      (LIVE_FIREBASE=1; needs .env.local + service-account key)
// Every account/profile created here is deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, signOut } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
import { createMemoryDb, TEST_HASH_OPTIONS } from '../helpers/memoryDb.js';
import { createAdmin, readEnvLocal } from '../helpers/firebaseAdmin.js';
import { firebaseConfigFromEnv } from '../../src/services/firebase.js';
import { createAuthService } from '../../src/services/authService.js';
import { createRegistrationService } from '../../src/services/registrationService.js';
import { createSyncService } from '../../src/services/syncService.js';

const live = process.env.LIVE_FIREBASE === '1';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (tag) => `pwa-test-${RUN}-${tag}@example.com`;
const PASSWORD = 'Safar-Test-2026';

const config = live ? firebaseConfigFromEnv(readEnvLocal()) : null;
const apps = [];
const createdEmails = new Set();
const createdProfiles = new Set();
let admin;

// One "device" = its own Firebase app instance (own auth session) + its own SQLite database.
async function device(name, { online = true } = {}) {
  const app = initializeApp(config, `${name}-${RUN}`);
  apps.push(app);
  const firebase = { auth: getAuth(app), firestore: getFirestore(app) };
  const authService = createAuthService(firebase);
  const db = await createMemoryDb();
  const net = { online };
  const wrapped = { ...authService };
  return {
    db, net, firebase, authService: wrapped,
    registration: createRegistrationService({ db, hashOptions: TEST_HASH_OPTIONS }),
    sync: createSyncService({ db, getAuthService: async () => wrapped, isOnline: () => net.online, locks: null }),
  };
}

const userRow = async (db, id) => (await db.query('SELECT * FROM users WHERE id = ?', [id]))[0];
const outboxRow = async (db, id) => (await db.query('SELECT * FROM sync_outbox WHERE entity_id = ?', [id]))[0];

describe.skipIf(!live)('live Firebase sync (swachh-safar)', () => {
  beforeAll(async () => {
    admin = await createAdmin();
  });

  afterAll(async () => {
    for (const app of apps) await deleteApp(app).catch(() => {});
    for (const id of createdProfiles) await admin.deleteDoc(`app_users/${id}`).catch(() => {});
    for (const e of createdEmails) {
      for (const acct of await admin.accountsByEmail(e)) {
        for (const p of await admin.queryProfilesByAuthUid(acct.localId)) await admin.deleteDoc(p.name.split('/documents/')[1]);
        await admin.deleteAccount(acct.localId);
      }
    }
  });

  it('TEST 1: online registration creates the Auth account, Firestore profile and synced SQLite row', async () => {
    const d = await device('t1');
    const address = email('online');
    createdEmails.add(address);
    const user = await d.registration.register({ email: address, password: PASSWORD });
    createdProfiles.add(user.id);

    const result = await d.sync.syncNewRegistration(user.id, PASSWORD);
    expect(result).toMatchObject({ status: 'synced' });

    const accounts = await admin.accountsByEmail(address);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].localId).toBe(result.firebaseUid);

    const profile = await admin.getDoc(`app_users/${user.id}`);
    expect(Object.keys(profile).sort()).toEqual(
      ['account_status', 'auth_uid', 'email', 'registered_at', 'source', 'synced_at', 'username', 'uuid'],
    );
    expect(profile).toMatchObject({
      uuid: { stringValue: user.id }, auth_uid: { stringValue: result.firebaseUid },
      email: { stringValue: address }, account_status: { stringValue: 'active' },
    });
    expect(JSON.stringify(profile)).not.toMatch(/password|salt|hash|Safar-Test/i);

    expect(await userRow(d.db, user.id)).toMatchObject({ registration_status: 'registered', sync_status: 'synced' });
    expect((await outboxRow(d.db, user.id)).sync_status).toBe('completed');
  });

  it('TEST 2 + 4: offline registration stays local, then syncs after reconnect and password re-entry', async () => {
    const d = await device('t4', { online: false });
    const address = email('offline');
    createdEmails.add(address);
    const user = await d.registration.register({ email: address, password: PASSWORD });
    createdProfiles.add(user.id);

    expect((await d.sync.sync()).status).toBe('offline');
    expect(await admin.accountsByEmail(address)).toHaveLength(0);
    expect((await outboxRow(d.db, user.id)).sync_status).toBe('pending');

    d.net.online = true;
    await d.sync.sync({ trigger: 'reconnect' });
    expect(d.sync.getState().needsPassword).toEqual([user.id]);
    expect(await admin.accountsByEmail(address)).toHaveLength(0);

    const res = await d.sync.provideCredential(user.id, PASSWORD);
    expect(res).toMatchObject({ ok: true, result: { status: 'synced' } });
    expect(await admin.accountsByEmail(address)).toHaveLength(1);
    expect(await admin.getDoc(`app_users/${user.id}`)).not.toBeNull();
    expect(d.sync.getState()).toMatchObject({ pendingCount: 0, lastSyncAt: expect.any(String) });
  });

  it('TEST 5: the same email on other devices never creates a second cloud account', async () => {
    const address = email('dup');
    createdEmails.add(address);
    const a = await device('t5a');
    const first = await a.registration.register({ email: address, password: PASSWORD });
    createdProfiles.add(first.id);
    await a.sync.syncNewRegistration(first.id, PASSWORD);

    const b = await device('t5b');
    const second = await b.registration.register({ email: address, password: PASSWORD });
    createdProfiles.add(second.id);
    expect(await b.sync.syncNewRegistration(second.id, PASSWORD)).toMatchObject({ status: 'synced', linkedExisting: true });

    const c = await device('t5c');
    const third = await c.registration.register({ email: address, password: 'Different-Pass-99' });
    createdProfiles.add(third.id);
    expect(await c.sync.syncNewRegistration(third.id, 'Different-Pass-99')).toMatchObject({ status: 'failed', code: 'cloud_conflict' });
    expect(await userRow(c.db, third.id)).toMatchObject({ registration_status: 'conflict', sync_status: 'failed' });

    const accounts = await admin.accountsByEmail(address);
    expect(accounts).toHaveLength(1);
    expect(await admin.queryProfilesByAuthUid(accounts[0].localId)).toHaveLength(1);
  });

  it('TEST 6: a failed sync keeps the local record pending and succeeds on retry', async () => {
    const d = await device('t6');
    const address = email('retry');
    createdEmails.add(address);
    const user = await d.registration.register({ email: address, password: PASSWORD });
    createdProfiles.add(user.id);

    const realCreate = d.authService.createAccount;
    d.authService.createAccount = async () => {
      throw Object.assign(new Error('simulated'), { code: 'auth/network-request-failed' });
    };
    expect(await d.sync.syncNewRegistration(user.id, PASSWORD)).toMatchObject({ status: 'retry' });
    expect(await outboxRow(d.db, user.id)).toMatchObject({ sync_status: 'pending', retry_count: 1 });
    expect(await userRow(d.db, user.id)).toMatchObject({ sync_status: 'pending' });
    expect(await admin.accountsByEmail(address)).toHaveLength(0);

    d.authService.createAccount = realCreate;
    await d.sync.sync({ trigger: 'retry' });
    expect(await userRow(d.db, user.id)).toMatchObject({ sync_status: 'synced' });
    expect(await admin.accountsByEmail(address)).toHaveLength(1);
  });

  it('deployed security rules reject secrets, impersonation, foreign reads and anonymous writes', async () => {
    const d = await device('rules');
    const address = email('rules');
    createdEmails.add(address);
    const user = await d.registration.register({ email: address, password: PASSWORD });
    createdProfiles.add(user.id);
    const setup = await d.sync.syncNewRegistration(user.id, PASSWORD);
    expect(setup).toMatchObject({ status: 'synced' });
    const { firebaseUid } = setup;
    const fs = d.firebase.firestore;
    const base = { uuid: 'x', auth_uid: firebaseUid, username: address, email: address, registered_at: 't', account_status: 'active' };

    const denied = (p) => expect(p).rejects.toMatchObject({ code: 'permission-denied' });
    const probeId = `rules-probe-${RUN}`;
    createdProfiles.add(probeId);
    await denied(setDoc(doc(fs, 'app_users', probeId), { ...base, uuid: probeId, password_hash: 'x' }));
    await denied(setDoc(doc(fs, 'app_users', probeId), { ...base, uuid: probeId, auth_uid: 'someone-else' }));
    await denied(setDoc(doc(fs, 'app_users', probeId), { ...base, uuid: probeId, email: 'other@example.com' }));
    await denied(setDoc(doc(fs, 'users', probeId), { name: 'x' })); // existing collection stays read-only

    const other = await device('rules-other');
    const otherEmail = email('rules-other');
    createdEmails.add(otherEmail);
    const otherUser = await other.registration.register({ email: otherEmail, password: PASSWORD });
    createdProfiles.add(otherUser.id);
    await other.sync.syncNewRegistration(otherUser.id, PASSWORD);
    await denied(getDoc(doc(other.firebase.firestore, 'app_users', user.id)));

    await signOut(d.firebase.auth);
    await denied(setDoc(doc(fs, 'app_users', probeId), { ...base, uuid: probeId }));
  });
});
