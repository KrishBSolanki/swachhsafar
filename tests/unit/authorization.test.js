// CP-02: device-side authorization, per-user outbox ownership and division isolation of local reads.
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createMemoryFiles } from '../helpers/memoryFiles.js';
import { MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { createLocalStore } from '../../src/services/localStore.js';
import { createLocalApi } from '../../src/services/localApi.js';
import { createOperationsQueue } from '../../src/services/operationsQueue.js';
import { FIELD_PERMS, GPS, IDS, NOW, TS, actorFor, attendancePayload, changesFixture, inspectionPayload, seededStore } from '../helpers/operationalFixtures.js';

const without = (...perms) => FIELD_PERMS.filter((p) => !perms.includes(p));

describe('capture authorization (mirrors FastAPI)', () => {
  it('requires a signed-in actor', async () => {
    const { store } = await seededStore();
    await expect(store.capture({ ...attendancePayload(), actor: null })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(store.capture({ ...attendancePayload(), actor: { id: IDS.supervisor } })).rejects.toMatchObject({ code: 'division_forbidden' });
  });

  it('requires the capture permission in the record division', async () => {
    const { db, store } = await seededStore();
    const cases = [
      [attendancePayload(), 'attendance.submit'],
      [inspectionPayload(), 'inspections.submit'],
    ];
    for (const [capture, perm] of cases) {
      await expect(store.capture({ ...capture, actor: actorFor(capture.actor.id, without(perm)) })).rejects.toMatchObject({ code: 'permission_denied' });
    }
    await expect(store.capture({ ...attendancePayload(), actor: actorFor(IDS.supervisor, FIELD_PERMS, [IDS.otherDivision]) }))
      .rejects.toMatchObject({ code: 'division_forbidden' });
    expect(await db.query('SELECT * FROM sync_outbox')).toEqual([]);
  });

  it('allows inspections, feedback and inventory only for journey staff unless an override is held', async () => {
    const { store } = await seededStore();
    const outsider = actorFor(IDS.outsider);
    await expect(store.capture({ ...inspectionPayload(), actor: outsider })).rejects.toMatchObject({ code: 'not_journey_staff' });
    const passenger = {
      type: 'feedback.passenger.start',
      payload: { id: crypto.randomUUID(), journey_id: IDS.journey, coach_code: 'B1', journey_day: 1, passenger_name: 'Amit Patel', mobile: '9876543210', pnr: '2451870001', device_timestamp: TS, ...GPS },
    };
    await expect(store.capture({ ...passenger, actor: outsider })).rejects.toMatchObject({ code: 'not_journey_staff' });
    const inventory = { type: 'inventory.record', payload: { id: crypto.randomUUID(), journey_id: IDS.journey, item_id: IDS.item, txn_type: 'issue', quantity: 2 } };
    await expect(store.capture({ ...inventory, actor: outsider })).rejects.toMatchObject({ code: 'not_journey_staff' });

    await store.capture({ ...inspectionPayload(), actor: actorFor(IDS.outsider, [...FIELD_PERMS, 'inspections.review']) });
    await store.capture({ ...passenger, actor: actorFor(IDS.outsider, [...FIELD_PERMS, 'feedback.review']) });
    await store.capture({ ...inventory, actor: actorFor(IDS.outsider, [...FIELD_PERMS, 'journeys.manage']) });
  });

  it('lets a reviewer record attendance for staff', async () => {
    const { store } = await seededStore();
    await expect(store.capture({ ...attendancePayload(), actor: actorFor(IDS.outsider) })).rejects.toMatchObject({ code: 'forbidden' });
    await store.capture({ ...attendancePayload(), actor: actorFor(IDS.outsider, [...FIELD_PERMS, 'attendance.review']) });
  });
});

describe('outbox ownership on a shared device', () => {
  function fakeApi() {
    const batches = [];
    return {
      batches,
      async get() { throw Object.assign(new Error('not found'), { status: 404, retryable: false }); },
      async post(path, body) {
        if (path === '/media') return { id: body.id, status: 'pending' };
        batches.push(...body.operations);
        return { results: body.operations.map((o) => ({ op_id: o.op_id, type: o.type, outcome: 'acknowledged', http_status: 201 })) };
      },
      async putRaw() { return {}; },
    };
  }

  it('tags each operation with its capturing user and delivers it only for that user', async () => {
    const { db, store } = await seededStore();
    const api = fakeApi();
    const session = { actor: null };
    const queue = createOperationsQueue({ db, store, getApi: async () => api, now: () => NOW.toISOString(), getActor: () => session });

    session.actor = actorFor(IDS.supervisor);
    api.offline = true;
    const offline = createOperationsQueue({ db, store, getApi: async () => null, getActor: () => session });
    const capture = attendancePayload();
    await offline.submit(capture); // captured while the server is unavailable
    expect(await db.query('SELECT owner_user_id FROM sync_outbox')).toEqual([{ owner_user_id: IDS.supervisor }]);

    // Another user signs in on the same device and comes online.
    session.actor = actorFor(IDS.janitor1);
    await queue.flush();
    expect(api.batches).toEqual([]);
    expect(queue.getState()).toMatchObject({ pending: 0, othersPending: 1 });

    // No signed-in user: nothing is delivered.
    session.actor = null;
    await queue.flush();
    expect(api.batches).toEqual([]);

    // The capturing user returns: delivered once, with their session.
    session.actor = actorFor(IDS.supervisor);
    await queue.flush();
    expect(api.batches.map((o) => o.payload.id)).toEqual([capture.payload.id]);
    await queue.flush();
    expect(api.batches).toHaveLength(1);
    expect(queue.getState()).toMatchObject({ pending: 0, othersPending: 0 });
  });

  it('still delivers unattributed entries queued before Phase 2', async () => {
    const { db, store } = await seededStore();
    const api = fakeApi();
    await db.run(`INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, created_at, updated_at)
      VALUES ('legacy', 'operation', 'rec-legacy', 'attendance.create', '{"op":{"type":"attendance.create","payload":{"id":"rec-legacy"}}}', 't', 't')`);
    const queue = createOperationsQueue({ db, store, getApi: async () => api, getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
    await queue.flush();
    expect(api.batches.map((o) => o.op_id)).toEqual(['legacy']);
  });

  it('migration v7 attributes existing queued operations to their record actor', async () => {
    const db = await createMemoryDb({ migrate: false });
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      await db.transaction([...m.statements.map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${m.version}` }]);
    }
    const store = createLocalStore({ db, files: createMemoryFiles(), now: () => NOW, logger: null });
    await store.ingestChanges(changesFixture());
    await db.run(`INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, recorded_by_id, created_at, updated_at)
      VALUES ('att-1', ?, ?, ?, 1, ?, 't', 't')`, [IDS.journey, IDS.division, IDS.janitor1, IDS.supervisor]);
    await db.run(`INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, created_at, updated_at) VALUES
      ('o-1', 'operation', 'att-1', 'attendance.create', '{}', 't', 't'),
      ('o-2', 'operation', 'gone', 'attendance.create', '{}', 't', 't'),
      ('o-3', 'user', 'u1', 'register', '{}', 't', 't')`);
    expect(await runMigrations(db)).toMatchObject({ from: 6, applied: [7, 8] });
    expect(await db.query('SELECT id, owner_user_id FROM sync_outbox ORDER BY id')).toEqual([
      { id: 'o-1', owner_user_id: IDS.supervisor }, { id: 'o-2', owner_user_id: null }, { id: 'o-3', owner_user_id: null },
    ]);
  });
});

describe('local reads are scoped to the signed-in user', () => {
  async function apiFor(store, userId, permissions) {
    return createLocalApi({ store, getContext: () => ({ userId, permissions }) });
  }

  it('hides other divisions entirely', async () => {
    const { store } = await seededStore();
    const api = await apiFor(store, IDS.outsider, { [IDS.otherDivision]: FIELD_PERMS });
    expect((await api.get('/divisions')).map((d) => d.id)).toEqual([IDS.otherDivision]);
    expect((await api.get('/journeys', { state: 'active' })).items).toEqual([]);
    await expect(api.get(`/journeys/${IDS.journey}`)).rejects.toMatchObject({ status: 404 });
    await expect(api.get(`/attendance/journeys/${IDS.journey}/status`)).rejects.toMatchObject({ status: 404 });
    await expect(api.get('/complaints', { division_id: IDS.division })).rejects.toMatchObject({ status: 403, code: 'division_forbidden' });
    await expect(api.get('/complaints/categories', { division_id: IDS.division })).rejects.toMatchObject({ code: 'division_forbidden' });
    await expect(api.get(`/dashboard/divisions/${IDS.division}`)).rejects.toMatchObject({ code: 'division_forbidden' });
  });

  it('applies journeys.read (own journeys) vs journeys.read_all, and per-route permissions', async () => {
    const { store } = await seededStore();
    const readOnly = without('journeys.read_all');
    const janitor = await apiFor(store, IDS.janitor2, { [IDS.division]: readOnly });
    const outsider = await apiFor(store, IDS.outsider, { [IDS.division]: readOnly });
    const manager = await apiFor(store, IDS.outsider, { [IDS.division]: FIELD_PERMS });
    expect((await janitor.get('/journeys', { state: 'active' })).items.map((j) => j.id)).toEqual([IDS.journey]);
    expect((await outsider.get('/journeys', { state: 'active' })).items).toEqual([]);
    await expect(outsider.get(`/journeys/${IDS.journey}`)).rejects.toMatchObject({ status: 404 });
    expect((await manager.get('/journeys', { state: 'active' })).items.map((j) => j.id)).toEqual([IDS.journey]);
    expect((await manager.get('/journeys', { state: 'active', mine: true })).items).toEqual([]);

    const noAttendanceRead = await apiFor(store, IDS.janitor2, { [IDS.division]: without('attendance.read') });
    await expect(noAttendanceRead.get(`/attendance/journeys/${IDS.journey}/status`)).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
    const noJourneys = await apiFor(store, IDS.janitor2, { [IDS.division]: ['attendance.submit'] });
    await expect(noJourneys.get('/journeys')).rejects.toMatchObject({ status: 403 });
  });

  it("never shows another user's unsynced records", async () => {
    const { store } = await seededStore();
    const id = crypto.randomUUID();
    await store.capture({
      type: 'complaint.create',
      payload: { id, division_id: IDS.division, category_id: IDS.category, description: 'Water not available', device_timestamp: TS },
      actor: actorFor(IDS.janitor1),
    });
    const owner = await apiFor(store, IDS.janitor1, { [IDS.division]: FIELD_PERMS });
    const colleague = await apiFor(store, IDS.janitor2, { [IDS.division]: FIELD_PERMS });
    expect((await owner.get('/complaints', { division_id: IDS.division })).total).toBe(1);
    expect((await colleague.get('/complaints', { division_id: IDS.division })).total).toBe(0);
    await expect(colleague.get(`/complaints/${id}`)).rejects.toMatchObject({ status: 404 });

    await store.markOutcome({ type: 'complaint.create', entityId: id, outcome: 'synced' });
    expect((await colleague.get('/complaints', { division_id: IDS.division })).total).toBe(1); // complaints.read
    const noRead = await apiFor(store, IDS.janitor2, { [IDS.division]: without('complaints.read') });
    expect((await noRead.get('/complaints', { division_id: IDS.division })).total).toBe(0);
  });

  it('shows passenger feedback to its collector or holders of feedback.read', async () => {
    const { store } = await seededStore();
    const id = crypto.randomUUID();
    await store.capture({
      type: 'feedback.passenger.start',
      payload: { id, journey_id: IDS.journey, coach_code: 'B1', journey_day: 1, passenger_name: 'Amit Patel', mobile: '9876543210', pnr: '2451870001', device_timestamp: TS, ...GPS },
      actor: actorFor(IDS.janitor1),
    });
    await store.markOutcome({ type: 'feedback.passenger.start', entityId: id, outcome: 'synced' });
    const collector = await apiFor(store, IDS.janitor1, { [IDS.division]: without('feedback.read') });
    const other = await apiFor(store, IDS.janitor2, { [IDS.division]: without('feedback.read') });
    const reader = await apiFor(store, IDS.janitor2, { [IDS.division]: FIELD_PERMS });
    expect((await collector.get(`/feedback/passenger/${id}`)).id).toBe(id);
    await expect(other.get(`/feedback/passenger/${id}`)).rejects.toMatchObject({ status: 404 });
    expect((await reader.get(`/feedback/passenger/${id}`)).id).toBe(id);
    expect((await other.get('/feedback/passenger')).total).toBe(0);
  });
});
