// Phase 2 schema: fresh creation, upgrade from the released Phase 1 schema, persistence across a
// reopen, and database-level guarantees (foreign keys, uniqueness, ordering, immutability).
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createMemoryFiles } from '../helpers/memoryFiles.js';
import { getSchemaVersion, LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/database/migrations.js';
import { createLocalStore } from '../../src/services/localStore.js';
import { IDS, NOW, attendancePayload, changesFixture, inspectionPayload, seededStore } from '../helpers/operationalFixtures.js';

const OPERATIONAL_TABLES = [
  'divisions', 'operating_policies', 'roles', 'permissions', 'user_profiles', 'user_division_assignments', 'user_division_permissions',
  'authorization_snapshots', 'local_sessions', 'trains', 'train_coaches', 'question_banks', 'feedback_questions', 'inventory_items',
  'complaint_departments', 'complaint_categories', 'media_files', 'sync_conflicts', 'sync_tombstones', 'sync_checkpoints', 'audit_events',
  'journeys', 'journey_coaches', 'journey_staff', 'attendance_records', 'inspection_records', 'passenger_feedback',
  'passenger_feedback_ratings', 'railway_feedback', 'railway_feedback_ratings', 'complaints', 'complaint_history',
  'complaint_attachments', 'inventory_transactions',
];
const RECORD_TABLES = ['attendance_records', 'inspection_records', 'passenger_feedback', 'railway_feedback', 'complaints', 'inventory_transactions', 'journeys'];

const tables = async (db) => (await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
const columns = async (db, table) => (await db.query(`PRAGMA table_info(${table})`)).map((c) => c.name);

describe('operational schema', () => {
  it('creates every operational table on a fresh database', async () => {
    const db = await createMemoryDb({ migrate: false });
    const result = await runMigrations(db);
    expect(result).toEqual({ from: 0, to: 8, applied: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(LATEST_VERSION).toBe(8);
    expect(await tables(db)).toEqual(expect.arrayContaining(['users', 'sync_outbox', 'sync_meta', ...OPERATIONAL_TABLES]));
    expect((await db.query('SELECT id, name FROM roles ORDER BY id')).map((r) => r.name)).toEqual(
      ['Super Admin', 'Admin', 'Manager', 'Supervisor/EHK', 'Janitor', 'Contractor'],
    );
    expect((await db.query('PRAGMA foreign_key_check'))).toEqual([]);
  });

  it('gives every operational record UUID, timestamps, sync status, schema version and division', async () => {
    const db = await createMemoryDb();
    for (const table of RECORD_TABLES) {
      expect(await columns(db, table), table).toEqual(expect.arrayContaining(['id', 'created_at', 'updated_at', 'sync_status', 'schema_version', 'division_id']));
    }
  });

  it('upgrades a Phase 1 (v2) database, keeping users, queued operations and the cached profile', async () => {
    const db = await createMemoryDb({ migrate: false });
    for (const m of MIGRATIONS.slice(0, 2)) await db.transaction([...m.statements.map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${m.version}` }]);
    expect(await getSchemaVersion(db)).toBe(2);
    // Rows as Phase 1 wrote them (the current services already target the latest schema).
    await db.run(`INSERT INTO users (id, username, email, password_hash, password_salt, created_at, updated_at)
      VALUES ('u1', 'ravi@example.com', 'ravi@example.com', 'h', 's', 't', 't')`);
    await db.run(`INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, created_at, updated_at)
      VALUES ('reg-1', 'user', 'u1', 'register', '{}', 't', 't')`);
    await db.run(`INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, created_at, updated_at)
      VALUES ('op-1', 'operation', 'rec-1', 'attendance.create', '{"op":{}}', 't', 't')`);
    const me = { user: { id: IDS.supervisor, emp_id: 'EMP7', name: 'Ravi Kumar', email: 'Ravi@Example.com', role_id: 4, division_id: IDS.division, status: 'active' }, divisions: { [IDS.division]: ['attendance.submit'] } };
    await db.run(`INSERT INTO sync_meta (key, value, updated_at) VALUES ('session_me', ?, '2026-11-01T00:00:00Z')`, [JSON.stringify(me)]);

    expect(await runMigrations(db)).toEqual({ from: 2, to: 8, applied: [3, 4, 5, 6, 7, 8] });
    expect(await db.query('SELECT email, registration_status FROM users')).toEqual([{ email: 'ravi@example.com', registration_status: 'pending' }]);
    expect((await db.query('SELECT id FROM sync_outbox')).map((r) => r.id)).toContain('op-1');
    const store = createLocalStore({ db, files: createMemoryFiles(), logger: null });
    const snap = await store.identity.findSnapshotByEmail('ravi@example.com');
    expect(snap.user).toMatchObject({ id: IDS.supervisor, name: 'Ravi Kumar' });
    expect(snap.divisions).toEqual(me.divisions);
    expect(await store.identity.getProfile(IDS.supervisor)).toMatchObject({ email: 'ravi@example.com', role_id: 4 });
  });

  it('survives a corrupt cached profile during upgrade', async () => {
    const db = await createMemoryDb({ migrate: false });
    for (const m of MIGRATIONS.slice(0, 2)) await db.transaction([...m.statements.map((sql) => ({ sql })), { sql: `PRAGMA user_version = ${m.version}` }]);
    await db.run(`INSERT INTO sync_meta (key, value, updated_at) VALUES ('session_me', 'not json', 't')`);
    await runMigrations(db);
    expect(await db.query('SELECT * FROM authorization_snapshots')).toEqual([]);
  });

  it('keeps records, outbox and media after the database is closed and reopened', async () => {
    const filename = `/reload-${crypto.randomUUID()}.db`;
    const files = createMemoryFiles();
    const first = await seededStore({ filename, files });
    const capture = attendancePayload();
    await first.store.capture(capture);
    await first.db.close();

    const db = await createMemoryDb({ filename }); // migrations are a no-op on reopen
    expect(await getSchemaVersion(db)).toBe(8);
    const store = createLocalStore({ db, files, now: () => NOW, logger: null });
    expect(await store.attendance.get(capture.payload.id)).toMatchObject({ stage: 1, sync_status: 'pending' });
    expect(await db.query("SELECT entity_id FROM sync_outbox WHERE sync_status = 'pending'")).toEqual([{ entity_id: capture.payload.id }]);
    const media = await store.media.read(capture.payload.photo_media_id);
    expect(media.intact).toBe(true);
    expect(Buffer.from(media.bytes).toString()).toBe('fake-jpeg-bytes-for-tests');
    expect((await store.journeys.list({ state: 'active', today: '2026-11-04' })).map((j) => j.id)).toContain(IDS.journey);
  });
});

describe('database-level guarantees', () => {
  it('enforces foreign keys', async () => {
    const { db } = await seededStore();
    await expect(db.run(`INSERT INTO journey_staff (id, journey_id, user_id, allocated_at, created_at, updated_at)
      VALUES ('s', 'no-such-journey', ?, 't', 't', 't')`, [IDS.janitor1])).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.run(`INSERT INTO inspection_records (id, journey_id, division_id, coach_code, day, round, phase, created_at, updated_at)
      VALUES ('i', ?, ?, 'Z9', 1, 1, 'B', 't', 't')`, [IDS.journey, IDS.division])).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.run(`INSERT INTO complaints (id, division_id, category_id, description, sla_hours, due_at, created_at, updated_at)
      VALUES ('c', ?, 'no-such-category', 'Dirty toilet', 4, 't', 't', 't')`, [IDS.division])).rejects.toThrow(/FOREIGN KEY/);
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  const rawAttendance = (stage, id = crypto.randomUUID()) => ({
    sql: `INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, origin, sync_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'local', 'pending', 't', 't')`,
    params: [id, IDS.journey, IDS.division, IDS.janitor1, stage],
  });

  it('rejects out-of-order and duplicate attendance even when written directly', async () => {
    const { db } = await seededStore();
    await expect(db.transaction([rawAttendance(2)])).rejects.toThrow(/stage_order/);
    await db.transaction([rawAttendance(1)]);
    await expect(db.transaction([rawAttendance(1)])).rejects.toThrow(/UNIQUE/);
    await db.transaction([rawAttendance(2)]);
    await expect(db.run('UPDATE attendance_records SET stage = 3 WHERE stage = 2')).rejects.toThrow(/immutable/);
    await expect(db.run('INSERT INTO attendance_records (id, journey_id, division_id, employee_id, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      ['x', IDS.journey, IDS.division, IDS.janitor1, 't', 't'])).rejects.toThrow(/CHECK/);
  });

  it('enforces inspection round and phase order, and slot uniqueness, in SQL', async () => {
    const { db } = await seededStore();
    const raw = (round, phase) => ({
      sql: `INSERT INTO inspection_records (id, journey_id, division_id, coach_code, day, round, phase, origin, sync_status, created_at, updated_at)
            VALUES (?, ?, ?, 'B1', 1, ?, ?, 'local', 'pending', 't', 't')`,
      params: [crypto.randomUUID(), IDS.journey, IDS.division, round, phase],
    });
    await expect(db.transaction([raw(1, 'A')])).rejects.toThrow(/phase_order/);
    await expect(db.transaction([raw(2, 'B')])).rejects.toThrow(/round_order/);
    await db.transaction([raw(1, 'B')]);
    await expect(db.transaction([raw(1, 'B')])).rejects.toThrow(/UNIQUE/);
    await db.transaction([raw(1, 'A')]);
    expect((await db.query('SELECT phase FROM inspection_records ORDER BY phase')).map((r) => r.phase)).toEqual(['A', 'B']);
  });

  it('rolls back the whole capture when any statement fails, including media and outbox', async () => {
    const { db, files, store } = await seededStore();
    const capture = inspectionPayload({ round: 2 }); // round 1 missing: the capture must be refused
    await expect(store.capture(capture)).rejects.toMatchObject({ code: 'round_order' });
    for (const t of ['inspection_records', 'media_files', 'sync_outbox', 'audit_events']) expect(await db.query(`SELECT * FROM ${t}`), t).toEqual([]);
    expect(files.map.size).toBe(0);
  });

  it('removes staged media files when the transaction itself fails', async () => {
    const { db, files, store } = await seededStore();
    const capture = attendancePayload();
    await store.capture(capture);
    // Same record id again: validation passes the slot check only if we bypass it, so reuse the id
    // with the next stage to make the INSERT (primary key) fail inside the transaction.
    const again = attendancePayload({ stage: 2 });
    again.payload.id = capture.payload.id;
    await expect(store.capture(again)).rejects.toThrow();
    expect(await db.query('SELECT COUNT(*) AS n FROM sync_outbox')).toEqual([{ n: 1 }]);
    expect(await db.query('SELECT COUNT(*) AS n FROM media_files')).toEqual([{ n: 1 }]);
    expect(files.map.size).toBe(1);
  });
});

describe('master data ingestion', () => {
  it('stores and updates trains, coaches, question banks, items, categories and policies', async () => {
    const { store } = await seededStore();
    expect((await store.masters.listTrains({ divisionId: IDS.division })).map((t) => t.train_no)).toEqual(['12951', '12952']);
    expect((await store.masters.getTrain(IDS.train)).coaches).toEqual([
      { code: 'B1', classification: 'AC', position: 1 }, { code: 'S1', classification: 'NON_AC', position: 2 },
    ]);
    expect(await store.masters.getPolicy(IDS.division)).toMatchObject({ passenger_pnr_required: true, attendance_photo_required: true, complaint_default_sla_hours: 72 });
    expect(await store.masters.getPolicy(IDS.otherDivision)).toMatchObject({ attendance_photo_required: true }); // defaults

    const changes = changesFixture();
    changes.trains[0].coaches = [{ code: 'A1', classification: 'AC', position: 1 }];
    changes.question_banks[0].questions = changes.question_banks[0].questions.slice(0, 1);
    changes.policies[IDS.division].attendance_photo_required = false;
    changes.journeys = [];
    expect((await store.ingestChanges(changes)).ok).toBe(true);
    expect((await store.masters.getTrain(IDS.train)).coaches.map((c) => c.code)).toEqual(['A1']);
    const bank = await store.masters.activeBank(IDS.division, 'passenger');
    expect(bank.questions.map((q) => q.id)).toEqual([IDS.q1]);
    expect(await store.masters.getQuestion(IDS.q2)).toMatchObject({ is_active: false }); // kept, deactivated
    expect((await store.masters.getPolicy(IDS.division)).attendance_photo_required).toBe(false);
    expect((await store.masters.listCategories(IDS.division)).map((c) => c.name)).toEqual(['Cleanliness', 'Toilet']);
    expect((await store.masters.listItems({ divisionId: IDS.division }))[0]).toMatchObject({ name: 'Phenyl', unit: 'litre', is_active: true });
  });

  it('selects feedback questions by division, falling back to the global bank', async () => {
    const { store } = await seededStore();
    expect((await store.masters.activeBank(IDS.division, 'passenger')).id).toBe(IDS.passengerBank);
    expect((await store.masters.activeBank(IDS.otherDivision, 'passenger')).id).toBe(IDS.globalBank);
    expect((await store.masters.activeBank(IDS.division, 'railway')).id).toBe(IDS.railwayBank);
    const ac = await store.feedback.questionsFor({ journeyId: IDS.journey, coachCode: 'B1', today: '2026-11-04' });
    const nonAc = await store.feedback.questionsFor({ journeyId: IDS.journey, coachCode: 'S1', today: '2026-11-04' });
    expect(ac.questions.map((q) => q.id)).toEqual([IDS.q1, IDS.q2, IDS.q3]);
    expect(nonAc.questions.map((q) => q.id)).toEqual([IDS.q1, IDS.q3]); // q2 is AC-only
  });
});
