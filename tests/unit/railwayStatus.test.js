// Railway feedback verification state (migration v8): stored from server responses with a freshness
// guard, distinct from the record's own sync state, readable offline, and never assumed.
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createMemoryFiles } from '../helpers/memoryFiles.js';
import { MIGRATIONS, getSchemaVersion, runMigrations } from '../../src/database/migrations.js';
import { createLocalStore } from '../../src/services/localStore.js';
import { createLocalApi } from '../../src/services/localApi.js';
import { railwayStatus } from '../../src/pages/ops/Feedback.jsx';
import { FIELD_PERMS, GPS, IDS, NOW, TS, actorFor, attendancePayload, changesFixture, seededStore, uid } from '../helpers/operationalFixtures.js';

const capture = (extra = {}) => ({
  type: 'feedback.railway.create',
  payload: { id: crypto.randomUUID(), journey_id: IDS.journey, coach_code: 'B1', journey_day: 1, railway_employee_id: 'RLY42', official_name: 'A. Inspector', ratings: [{ question_id: IDS.r1, value: 4 }], device_timestamp: TS, ...GPS, ...extra },
  actor: actorFor(IDS.supervisor),
});

// backend RailwayFeedbackOut
const serverRow = (id, extra = {}) => ({
  id, journey_id: IDS.journey, division_id: IDS.division, bank_id: IDS.railwayBank, railway_employee_id: 'RLY77', official_name: 'B. Officer',
  designation: null, coach_code: 'S1', journey_day: 1, comments: null, verification_status: 'submitted', verified_at: null, verified_by_id: null,
  ratings: [{ question_id: IDS.r1, value: 3 }], created_by_id: IDS.janitor2, device_timestamp: TS, server_timestamp: '2026-11-04T05:35:00Z', ...extra,
});
const statusOf = async (db, id) => (await db.query('SELECT verification_status, verified_at, sync_status FROM railway_feedback WHERE id = ?', [id]))[0];

describe('railway feedback verification status', () => {
  it('migration v8 upgrades a v7 database without touching existing records or queued operations', async () => {
    const db = await createMemoryDb({ migrate: false });
    for (const m of MIGRATIONS.filter((x) => x.version <= 7)) await db.transaction([...m.statements.map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${m.version}` }]);
    const store = createLocalStore({ db, files: createMemoryFiles(), now: () => NOW, logger: null });
    expect((await store.ingestChanges(changesFixture())).ok).toBe(true);
    // Data as the v7 app wrote it: a queued operation, and a pending railway record (v7 columns only).
    await store.capture(attendancePayload());
    const railwayId = uid(950);
    await db.run(
      `INSERT INTO railway_feedback (id, journey_id, division_id, bank_id, coach_code, journey_day, feedback_date, railway_employee_id, official_name,
         device_timestamp, submitted_by_id, origin, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'B1', 1, '2026-11-04', 'RLY42', 'A. Inspector', ?, ?, 'local', 'pending', ?, ?)`,
      [railwayId, IDS.journey, IDS.division, IDS.railwayBank, TS, IDS.supervisor, NOW.toISOString(), NOW.toISOString()],
    );
    const before = await db.query('SELECT id, sync_status, owner_user_id, payload FROM sync_outbox');
    expect(before).toHaveLength(1);
    expect(await runMigrations(db)).toMatchObject({ from: 7, to: 8, applied: [8] });
    expect(await getSchemaVersion(db)).toBe(8);
    expect(await db.query('SELECT id, sync_status, owner_user_id, payload FROM sync_outbox')).toEqual(before);
    expect(await statusOf(db, railwayId)).toEqual({ verification_status: null, verified_at: null, sync_status: 'pending' });
    await expect(db.run("UPDATE railway_feedback SET verification_status = 'approved'")).rejects.toThrow(/CHECK/);
  });

  it('stores server records and applies only status updates that are not older than the stored one', async () => {
    const { db, store } = await seededStore();
    const id = uid(900);
    await store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(id)], total: 1 });
    expect(await statusOf(db, id)).toEqual({ verification_status: 'submitted', verified_at: null, sync_status: 'synced' });

    await store.ingestResponse('POST', `/feedback/railway/${id}/review`, serverRow(id, { verification_status: 'verified', verified_at: '2026-11-04T06:00:00Z', verified_by_id: IDS.supervisor }));
    expect(await statusOf(db, id)).toMatchObject({ verification_status: 'verified', verified_at: '2026-11-04T06:00:00Z' });

    // A list response fetched before the review arrives late: it must not undo the review.
    await store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(id)], total: 1 });
    expect(await statusOf(db, id)).toMatchObject({ verification_status: 'verified' });
    // A re-review (newer verified_at) wins; an older review result does not.
    await store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(id, { verification_status: 'rejected', verified_at: '2026-11-04T07:00:00Z' })], total: 1 });
    await store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(id, { verification_status: 'verified', verified_at: '2026-11-04T06:00:00Z' })], total: 1 });
    expect(await statusOf(db, id)).toMatchObject({ verification_status: 'rejected', verified_at: '2026-11-04T07:00:00Z' });
    // A response without a recognisable status changes nothing.
    await store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(id, { verification_status: 'something-else', verified_at: '2026-11-04T08:00:00Z' })], total: 1 });
    expect(await statusOf(db, id)).toMatchObject({ verification_status: 'rejected' });
  });

  it('a record still pending on this device gets the server status but keeps its own sync state', async () => {
    const { db, store } = await seededStore();
    const c = capture();
    await store.capture(c);
    await store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(c.payload.id, { created_by_id: IDS.supervisor })], total: 1 });
    expect(await statusOf(db, c.payload.id)).toEqual({ verification_status: 'submitted', verified_at: null, sync_status: 'pending' });
    expect(await db.query("SELECT sync_status FROM sync_outbox WHERE entity_id = ?", [c.payload.id])).toEqual([{ sync_status: 'pending' }]);
  });

  it('is read offline after the database is reopened, and other users\' unsynced records stay hidden', async () => {
    const filename = `/rail-${crypto.randomUUID()}.db`;
    const files = createMemoryFiles();
    const first = await seededStore({ filename, files });
    const id = uid(901);
    await first.store.ingestResponse('GET', '/feedback/railway', { items: [serverRow(id, { verification_status: 'verified', verified_at: '2026-11-04T06:00:00Z' })], total: 1 });
    await first.store.capture(capture()); // the supervisor's own, unsynced
    await first.db.close();

    const db = await createMemoryDb({ filename });
    const store = createLocalStore({ db, files, now: () => NOW, logger: null });
    const ctx = { userId: IDS.supervisor, permissions: { [IDS.division]: FIELD_PERMS } };
    const api = createLocalApi({ store, getContext: () => ctx });
    const mine = await api.get('/feedback/railway');
    expect(mine.items.map((f) => railwayStatus(f).key).sort()).toEqual(['not_synced', 'verified']);
    ctx.userId = IDS.janitor1; // another user of the same device
    expect((await api.get('/feedback/railway')).items.map((f) => f.id)).toEqual([id]);
  });

  it('distinguishes every state and never shows an unreviewed record as verified', () => {
    expect(railwayStatus({ sync_status: 'pending', verification_status: 'verified' }).key).toBe('not_synced');
    expect(railwayStatus({ sync_status: 'rejected' }).key).toBe('sync_rejected');
    expect(railwayStatus({ sync_status: 'synced', verification_status: null }).key).toBe('unknown');
    expect(railwayStatus({ sync_status: 'synced', verification_status: 'submitted' }).key).toBe('submitted');
    expect(railwayStatus({ sync_status: 'synced', verification_status: 'verified' }).key).toBe('verified');
    expect(railwayStatus({ sync_status: 'synced', verification_status: 'rejected' }).key).toBe('rejected');
  });
});
