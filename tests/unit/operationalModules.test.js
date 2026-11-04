// CRUD and business rules for every operational module, on real SQLite.
import { describe, expect, it } from 'vitest';
import { istDate, journeyDayFor, journeyState, todayIst } from '../../src/utils/businessDate.js';
import { GPS, IDS, NOW, PHOTO, TS, actorFor, attendancePayload, changesFixture, inspectionPayload, journeyOut, seededStore, uid } from '../helpers/operationalFixtures.js';

const TODAY = '2026-11-04';
const ME = {
  user: { id: IDS.supervisor, emp_id: 'EMP9', name: 'Ravi Kumar', email: 'Ravi@demo.in', role_id: 4, division_id: IDS.division, status: 'active', updated_at: '2026-11-01T00:00:00Z' },
  divisions: { [IDS.division]: ['attendance.submit', 'inspections.submit'], [IDS.otherDivision]: ['journeys.read'] },
};

describe('business dates (Asia/Kolkata)', () => {
  it('uses the IST calendar date regardless of UTC date', () => {
    expect(istDate('2026-11-04T18:29:59Z')).toBe('2026-11-04');
    expect(istDate('2026-11-04T18:30:00Z')).toBe('2026-11-05'); // midnight IST
    expect(istDate('2026-11-05T00:10:00+05:30')).toBe('2026-11-05');
    expect(todayIst(new Date('2026-11-04T20:00:00Z'))).toBe('2026-11-05');
    expect(journeyDayFor('2026-11-04', '2026-11-05')).toBe(2);
  });

  it('derives journey list states', () => {
    const j = { status: 'planned', journey_date: '2026-11-04', end_date: '2026-11-05' };
    expect(journeyState(j, '2026-11-03')).toBe('scheduled');
    expect(journeyState(j, '2026-11-04')).toBe('active');
    expect(journeyState(j, '2026-11-05')).toBe('active');
    expect(journeyState(j, '2026-11-06')).toBe('history');
    expect(journeyState({ ...j, status: 'cancelled' }, '2026-11-04')).toBe('cancelled');
  });
});

describe('identity and authorization', () => {
  it('caches profile, division assignments, permissions and the snapshot atomically', async () => {
    const { store } = await seededStore();
    await store.identity.saveAuthorization(ME, { firebaseUid: 'fb-1', now: NOW.toISOString() });
    expect(await store.identity.getProfile(IDS.supervisor)).toMatchObject({ name: 'Ravi Kumar', email: 'ravi@demo.in', role_id: 4 });
    expect(await store.identity.permissionsFor(IDS.supervisor)).toEqual({
      [IDS.division]: ['attendance.submit', 'inspections.submit'], [IDS.otherDivision]: ['journeys.read'],
    });
    expect((await store.identity.findSnapshotByEmail('RAVI@demo.in')).divisions).toEqual(ME.divisions);

    // Permissions removed on the server are removed locally on the next snapshot.
    await store.identity.saveAuthorization({ ...ME, divisions: { [IDS.division]: ['attendance.submit'] } }, { now: NOW.toISOString() });
    expect(await store.identity.permissionsFor(IDS.supervisor)).toEqual({ [IDS.division]: ['attendance.submit'] });
  });

  it('creates placeholder divisions for assignments not yet pulled', async () => {
    const { store } = await seededStore({ seed: false });
    const unknown = uid(9);
    await store.identity.saveAuthorization({ ...ME, divisions: { [unknown]: ['journeys.read'] } }, { now: NOW.toISOString() });
    expect((await store.masters.listDivisions()).map((d) => d.id)).toEqual([unknown]);
  });

  it('tracks local sessions', async () => {
    const { store } = await seededStore();
    await store.identity.saveAuthorization(ME, { now: NOW.toISOString() });
    const id = await store.identity.startSession({ userId: IDS.supervisor, email: 'ravi@demo.in', mode: 'offline', now: 't1' });
    await store.identity.touchSession(id, 't2');
    await store.identity.endSession(id, 't3');
    expect(await store.identity.listSessions(IDS.supervisor)).toEqual([expect.objectContaining({ id, mode: 'offline', started_at: 't1', ended_at: 't3' })]);
  });
});

describe('journeys', () => {
  it('lists active, scheduled, history and cancelled journeys by IST date', async () => {
    const { store } = await seededStore();
    const ids = async (state, today = TODAY) => (await store.journeys.list({ state, today })).map((j) => j.id);
    expect(await ids('active')).toEqual([IDS.journey]);
    expect(await ids('scheduled')).toEqual([IDS.futureJourney]);
    expect(await ids('history')).toEqual([IDS.pastJourney]);
    expect(await ids('cancelled')).toEqual([IDS.cancelledJourney]);
    expect(await ids('history', '2026-11-06')).toEqual([IDS.journey, IDS.pastJourney]);
  });

  it('returns the journey with coaches, staff, supervisor and linked train', async () => {
    const { store } = await seededStore();
    const j = await store.journeys.get(IDS.journey, TODAY);
    expect(j).toMatchObject({
      state: 'active', supervisor_id: IDS.supervisor, supervisor_name: 'Ravi Kumar', linked_train_id: IDS.linkedTrain, linked_train_no: '12952',
      journey_date: '2026-11-04', end_date: '2026-11-05', before_inspection_enabled: true,
    });
    expect(j.coaches.map((c) => c.code)).toEqual(['B1', 'S1']);
    expect(j.staff.map((s) => s.name)).toEqual(['Mohan Lal', 'Sunita Devi']); // same allocation time: by name
  });

  it('associates staff with their assigned journeys', async () => {
    const { store } = await seededStore();
    expect((await store.journeys.list({ state: 'active', today: TODAY, mineUserId: IDS.janitor1 })).map((j) => j.id)).toEqual([IDS.journey]);
    expect(await store.journeys.list({ state: 'active', today: TODAY, mineUserId: IDS.outsider })).toEqual([]);
    expect((await store.journeys.list({ today: TODAY, mineUserId: IDS.supervisor })).length).toBe(4);
  });

  it('updates from the server: staff removal, coach changes, cancellation', async () => {
    const { store } = await seededStore();
    const j = journeyOut(IDS.journey, '2026-11-04', '2026-11-05', {
      coaches: [{ code: 'B1', classification: 'AC', position: 1 }],
      version: 2,
    });
    j.staff[1].removed_at = '2026-11-04T05:00:00Z';
    await store.journeys.ingest(j, NOW.toISOString());
    let got = await store.journeys.get(IDS.journey, TODAY);
    expect(got.coaches.map((c) => c.code)).toEqual(['B1']);
    expect(await store.journeys.isAllocated(IDS.journey, IDS.janitor2)).toBe(false);
    expect(got.version).toBe(2);

    await store.journeys.ingest({ ...j, state: 'cancelled', cancel_reason: 'Rake change' }, NOW.toISOString());
    got = await store.journeys.get(IDS.journey, TODAY);
    expect(got).toMatchObject({ state: 'cancelled', cancel_reason: 'Rake change' });
  });
});

describe('attendance', () => {
  it('captures the five stages in order with GPS, timestamp and photo metadata', async () => {
    const { store } = await seededStore();
    for (let stage = 1; stage <= 5; stage += 1) await store.capture(attendancePayload({ stage }));
    const rows = await store.attendance.listForJourney(IDS.journey);
    expect(rows.map((r) => r.stage)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0]).toMatchObject({ latitude: GPS.latitude, longitude: GPS.longitude, device_timestamp: TS, captured_on: TODAY, division_id: IDS.division, sync_status: 'pending' });
    expect(await store.media.getMeta(rows[0].photo_media_id)).toMatchObject({ kind: 'attendance_photo', owner_table: 'attendance_records', owner_id: rows[0].id, upload_status: 'pending' });
    const status = (await store.attendance.journeyStatus(IDS.journey)).find((r) => r.employee_id === IDS.janitor1);
    expect(status.stages.map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('enforces stage order', async () => {
    const { store } = await seededStore();
    await expect(store.capture(attendancePayload({ stage: 2 }))).rejects.toMatchObject({ code: 'stage_order' });
    await store.capture(attendancePayload({ stage: 1 }));
    await expect(store.capture(attendancePayload({ stage: 3 }))).rejects.toMatchObject({ code: 'stage_order' });
    const s = (await store.attendance.journeyStatus(IDS.journey)).find((r) => r.employee_id === IDS.janitor1);
    expect(s.stages.map((c) => c.status)).toEqual(['pending', 'next', 'locked', 'locked', 'locked']);
  });

  it('prevents duplicate attendance submissions', async () => {
    const { db, store } = await seededStore();
    await store.capture(attendancePayload({ stage: 1 }));
    await expect(store.capture(attendancePayload({ stage: 1 }))).rejects.toMatchObject({ code: 'duplicate_attendance' });
    // Another employee's stage 1 is independent.
    await store.capture(attendancePayload({ stage: 1, employee_id: IDS.janitor2 }));
    expect((await db.query('SELECT COUNT(*) AS n FROM attendance_records'))[0].n).toBe(2);
    expect((await db.query('SELECT COUNT(*) AS n FROM sync_outbox'))[0].n).toBe(2);
  });

  it('frees a stage when the server rejects it, so it can be captured again', async () => {
    const { store } = await seededStore();
    const first = attendancePayload({ stage: 1 });
    await store.capture(first);
    await store.markOutcome({ type: 'attendance.create', entityId: first.payload.id, outcome: 'rejected', message: 'outside journey' });
    await store.capture(attendancePayload({ stage: 1 }));
    await expect(store.reopen('attendance.create', first.payload.id)).rejects.toMatchObject({ code: 'duplicate_attendance' });
  });

  it('refuses staff not allocated, cancelled journeys, captures outside the journey and missing photo or GPS', async () => {
    const { store } = await seededStore();
    await expect(store.capture(attendancePayload({ employee_id: IDS.outsider }))).rejects.toMatchObject({ code: 'not_allocated' });
    await expect(store.capture(attendancePayload({ journey_id: IDS.cancelledJourney }))).rejects.toMatchObject({ code: 'journey_cancelled' });
    await expect(store.capture(attendancePayload({ journey_id: IDS.pastJourney }))).rejects.toMatchObject({ code: 'outside_journey' });
    await expect(store.capture(attendancePayload({ photo_media_id: null }))).rejects.toMatchObject({ code: 'photo_required' });
    await expect(store.capture(attendancePayload({ latitude: undefined }))).rejects.toMatchObject({ code: 'gps_required' });
    await expect(store.capture(attendancePayload({ device_timestamp: '2026-11-04T11:00:00' }))).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(store.capture({ ...attendancePayload(), actor: actorFor(IDS.outsider) })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('ingests server-confirmed stages and overlays local pending ones on a server status', async () => {
    const { store } = await seededStore();
    const server = [{ employee_id: IDS.janitor1, name: 'Sunita Devi', emp_id: 'EMP1', role_id: 5, completed: false,
      stages: [{ stage: 1, status: 'taken', attendance_id: uid(500) }, { stage: 2, status: 'next', attendance_id: null }, ...[3, 4, 5].map((stage) => ({ stage, status: 'locked', attendance_id: null }))] }];
    await store.ingestResponse('GET', `/attendance/journeys/${IDS.journey}/status`, server);
    expect(await store.attendance.get(uid(500))).toMatchObject({ origin: 'server', sync_status: 'synced', stage: 1 });
    await store.capture(attendancePayload({ stage: 2 }));
    const [row] = await store.attendance.overlayStatus(IDS.journey, server);
    expect(row.stages.map((s) => s.status)).toEqual(['taken', 'pending', 'next', 'locked', 'locked']);
  });
});

describe('coach inspections', () => {
  it('preserves coach, day, round and Before/After as separate records', async () => {
    const { store } = await seededStore();
    await store.capture(inspectionPayload({ phase: 'B' }));
    await store.capture(inspectionPayload({ phase: 'A' }));
    await store.capture(inspectionPayload({ phase: 'B', coach_code: 'S1' }));
    await store.capture(inspectionPayload({ phase: 'B', round: 2 }));
    const rows = await store.inspections.listForJourney(IDS.journey);
    expect(rows.map((r) => `${r.coach_code}/${r.day}/${r.round}/${r.phase}`)).toEqual(['B1/1/1/A', 'B1/1/1/B', 'B1/1/2/B', 'S1/1/1/B']);
    expect(rows.find((r) => r.coach_code === 'S1').coach_class).toBe('NON_AC');
  });

  it('enforces uniqueness, phase order, round order, open day and configuration', async () => {
    const { store } = await seededStore();
    await expect(store.capture(inspectionPayload({ phase: 'A' }))).rejects.toMatchObject({ code: 'phase_order' });
    await expect(store.capture(inspectionPayload({ round: 2 }))).rejects.toMatchObject({ code: 'round_order' });
    await store.capture(inspectionPayload());
    await expect(store.capture(inspectionPayload())).rejects.toMatchObject({ code: 'duplicate_inspection' });
    await expect(store.capture(inspectionPayload({ day: 2 }))).rejects.toMatchObject({ code: 'day_not_open' }); // day 2 opens on 5 Nov IST
    await expect(store.capture(inspectionPayload({ day: 3 }))).rejects.toMatchObject({ code: 'day_out_of_range' });
    await expect(store.capture(inspectionPayload({ round: 3 }))).rejects.toMatchObject({ code: 'round_out_of_range' });
    await expect(store.capture(inspectionPayload({ coach_code: 'Z9' }))).rejects.toMatchObject({ code: 'unknown_coach' });
  });

  it('opens day 2 on the second IST journey day', async () => {
    const { store } = await seededStore({ now: () => new Date('2026-11-05T03:00:00Z') });
    await store.capture(inspectionPayload({ day: 2, device_timestamp: '2026-11-05T08:00:00+05:30' }));
    const grid = await store.inspections.journeyGrid(await store.journeys.get(IDS.journey, '2026-11-05'), '2026-11-05');
    const b1d2 = grid.find((c) => c.coach_code === 'B1' && c.day === 2);
    expect(b1d2.day_open).toBe(true);
    expect(b1d2.cells.map((c) => `${c.round}${c.phase}:${c.status}`)).toEqual(['1B:pending', '1A:open', '2B:open', '2A:locked']);
  });
});

describe('feedback', () => {
  const passenger = (extra = {}) => ({
    type: 'feedback.passenger.start',
    payload: { id: crypto.randomUUID(), journey_id: IDS.journey, coach_code: 'B1', journey_day: 1, passenger_name: 'Amit Patel', mobile: '9876543210', pnr: '2451870001', seat_no: '23', device_timestamp: TS, ...GPS, ...extra },
    actor: actorFor(IDS.janitor1),
  });

  it('stores passenger PNR, coach, seat and mobile with pending verification state', async () => {
    const { store } = await seededStore();
    const capture = passenger();
    await store.capture(capture);
    const fb = await store.feedback.getPassenger(capture.payload.id);
    expect(fb).toMatchObject({
      pnr: '2451870001', coach_code: 'B1', coach_class: 'AC', seat_no: '23', mobile_masked: '98XXXXX210', status: 'draft',
      pnr_status: 'pending', otp_status: 'not_sent', bank_id: IDS.passengerBank, feedback_date: TODAY, sync_status: 'pending',
    });
    const [{ mobile }] = await store.db.query('SELECT mobile FROM passenger_feedback WHERE id = ?', [capture.payload.id]);
    expect(mobile).toBe('9876543210');
  });

  it('validates mobile, PNR and coach, and requires PNR when the division policy does', async () => {
    const { store } = await seededStore();
    await expect(store.capture(passenger({ mobile: '1234567890' }))).rejects.toMatchObject({ code: 'invalid_mobile' });
    await expect(store.capture(passenger({ pnr: '12345' }))).rejects.toMatchObject({ code: 'invalid_pnr' });
    await expect(store.capture(passenger({ pnr: null }))).rejects.toMatchObject({ code: 'pnr_required' });
    await expect(store.capture(passenger({ coach_code: 'Z9' }))).rejects.toMatchObject({ code: 'unknown_coach' });
    await expect(store.capture(passenger({ passenger_name: 'A' }))).rejects.toMatchObject({ code: 'invalid_value' });
  });

  it('keeps the full mobile when the server state is ingested, and updates verification from the server', async () => {
    const { store } = await seededStore();
    const capture = passenger();
    await store.capture(capture);
    await store.ingestResponse('GET', `/feedback/passenger/${capture.payload.id}`, {
      ...capture.payload, division_id: IDS.division, mobile_masked: '98XXXXX210', status: 'verified', pnr_status: 'valid',
      otp_status: 'verified', ratings: [{ question_id: IDS.q1, value: 5 }, { question_id: uid(999), value: 3 }],
    });
    const fb = await store.feedback.getPassenger(capture.payload.id);
    expect(fb).toMatchObject({ status: 'verified', pnr_status: 'valid', otp_status: 'verified', sync_status: 'synced' });
    expect(fb.ratings).toEqual([{ question_id: IDS.q1, value: 5 }]); // unknown question skipped, not fatal
    const [{ mobile }] = await store.db.query('SELECT mobile FROM passenger_feedback WHERE id = ?', [capture.payload.id]);
    expect(mobile).toBe('9876543210');
  });

  it('captures railway feedback with ratings from the division bank, within policy limits', async () => {
    const { store } = await seededStore();
    const railway = (extra = {}) => ({
      type: 'feedback.railway.create',
      payload: { id: crypto.randomUUID(), journey_id: IDS.journey, coach_code: 'B1', journey_day: 1, railway_employee_id: 'RLY42', official_name: 'A. Inspector', ratings: [{ question_id: IDS.r1, value: 4 }], device_timestamp: TS, ...GPS, ...extra },
      actor: actorFor(IDS.supervisor),
    });
    const first = railway();
    await store.capture(first);
    expect((await store.feedback.getRailway(first.payload.id)).ratings).toEqual([{ question_id: IDS.r1, value: 4 }]);
    await expect(store.capture(railway({ ratings: [{ question_id: IDS.r2, value: 4 }] }))).rejects.toMatchObject({ code: 'missing_required' });
    await expect(store.capture(railway({ ratings: [{ question_id: IDS.r1, value: 9 }] }))).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(store.capture(railway({ ratings: [{ question_id: IDS.q1, value: 4 }] }))).rejects.toMatchObject({ code: 'invalid_question' });
    await store.capture(railway());
    await expect(store.capture(railway())).rejects.toMatchObject({ code: 'railway_feedback_limit' }); // policy: 2 per journey
    expect((await store.feedback.listRailway({ journeyId: IDS.journey })).length).toBe(2);
  });
});

describe('complaints', () => {
  const complaint = (extra = {}) => {
    const media = crypto.randomUUID();
    return {
      type: 'complaint.create',
      payload: { id: crypto.randomUUID(), division_id: IDS.division, category_id: IDS.category, subcategory_id: IDS.subcategory, journey_id: IDS.journey, coach_code: 'B1', description: 'Toilet not cleaned', latitude: null, longitude: null, device_timestamp: TS, attachment_ids: [media], ...extra },
      media: [{ id: media, kind: 'complaint_attachment', dataUrl: PHOTO }],
      actor: actorFor(IDS.janitor1),
    };
  };

  it('creates a complaint with provisional SLA, a created history entry and an attachment', async () => {
    const { store } = await seededStore();
    const c = complaint();
    await store.capture(c);
    const got = await store.complaints.get(c.payload.id, NOW.toISOString());
    expect(got).toMatchObject({
      complaint_no: null, status: 'created', sla_hours: 2, due_at_provisional: true, department_id: IDS.department,
      coach_class: 'AC', train_id: IDS.train, attachment_ids: c.payload.attachment_ids, sync_status: 'pending', is_overdue: false,
    });
    expect(got.due_at).toBe('2026-11-04T07:30:00.000Z'); // 11:00 IST + 2 h
    expect(got.history).toEqual([expect.objectContaining({ from_status: null, to_status: 'created', actor_id: IDS.janitor1 })]);
  });

  it('keeps history append-only, adding server transitions without rewriting', async () => {
    const { db, store } = await seededStore();
    const c = complaint();
    await store.capture(c);
    await expect(db.run('UPDATE complaint_history SET remarks = ?', ['edited'])).rejects.toThrow(/append-only/);
    await expect(db.run('DELETE FROM complaint_history')).rejects.toThrow(/append-only/);

    const server = {
      ...c.payload, complaint_no: 'CMP-20261104-001', train_id: IDS.train, coach_class: 'AC', department_id: IDS.department, assigned_to_id: null,
      status: 'forwarded', sla_hours: 2, due_at: '2026-11-04T07:31:00Z', resolution_remarks: null, closed_at: null, closed_by_id: null,
      created_by_id: IDS.janitor1, server_timestamp: '2026-11-04T05:31:00Z',
      history: [
        { id: uid(700), from_status: null, to_status: 'created', actor_id: IDS.janitor1, forwarded_to_id: null, department_id: null, remarks: null, created_at: '2026-11-04T05:31:00Z' },
        { id: uid(701), from_status: 'created', to_status: 'forwarded', actor_id: IDS.supervisor, forwarded_to_id: IDS.supervisor, department_id: IDS.department, remarks: 'To C&W', created_at: '2026-11-04T05:40:00Z' },
      ],
    };
    await store.ingestResponse('POST', `/complaints/${c.payload.id}/transition`, server);
    await store.ingestResponse('GET', `/complaints/${c.payload.id}`, server); // re-ingest is idempotent
    const got = await store.complaints.get(c.payload.id, NOW.toISOString());
    expect(got).toMatchObject({ complaint_no: 'CMP-20261104-001', status: 'forwarded', due_at_provisional: false, sync_status: 'synced' });
    expect(got.history.map((h) => h.to_status)).toEqual(['created', 'forwarded']);
    expect((await db.query('SELECT COUNT(*) AS n FROM complaint_history'))[0].n).toBe(3); // local entry retained
    expect((await store.complaints.list({ divisionId: IDS.division, status: 'forwarded' })).length).toBe(1);
  });

  it('validates category, sub-category, journey and coach', async () => {
    const { store } = await seededStore();
    await expect(store.capture(complaint({ category_id: IDS.subcategory, subcategory_id: null }))).rejects.toMatchObject({ code: 'invalid_category' });
    await expect(store.capture(complaint({ subcategory_id: IDS.category }))).rejects.toMatchObject({ code: 'invalid_subcategory' });
    await expect(store.capture(complaint({ coach_code: 'Z9' }))).rejects.toMatchObject({ code: 'unknown_coach' });
    await expect(store.capture(complaint({ description: 'bad' }))).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(store.capture({ ...complaint(), divisions: [IDS.otherDivision] })).rejects.toMatchObject({ code: 'division_forbidden' });
  });
});

describe('inventory', () => {
  const txn = (txn_type, quantity, extra = {}) => ({
    type: 'inventory.record',
    payload: { id: crypto.randomUUID(), journey_id: IDS.journey, item_id: IDS.item, coach_code: 'B1', txn_type, quantity, device_timestamp: TS, ...extra },
    actor: actorFor(IDS.supervisor),
  });

  it('records issue and return transactions and derives the balance', async () => {
    const { store } = await seededStore();
    await store.capture(txn('issue', 10));
    await store.capture(txn('issue', 2.5));
    await store.capture(txn('return', 4));
    await store.capture(txn('issue', 1, { coach_code: 'S1' }));
    expect(await store.inventory.balance(IDS.journey)).toEqual([
      expect.objectContaining({ item_name: 'Phenyl', unit: 'litre', coach_code: 'B1', issued: 12.5, returned: 4, consumed: 8.5 }),
      expect.objectContaining({ coach_code: 'S1', issued: 1, returned: 0, consumed: 1 }),
    ]);
    expect((await store.inventory.ledger(IDS.journey)).map((t) => `${t.txn_type}:${t.quantity}`)).toEqual(['issue:10', 'issue:2.5', 'return:4', 'issue:1']);
  });

  it('refuses returns above the issued quantity and invalid quantities', async () => {
    const { db, store } = await seededStore();
    await store.capture(txn('issue', 3));
    await expect(store.capture(txn('return', 3.5))).rejects.toMatchObject({ code: 'return_exceeds_issue' });
    await expect(store.capture(txn('return', 1, { coach_code: 'S1' }))).rejects.toMatchObject({ code: 'return_exceeds_issue' });
    await expect(store.capture(txn('issue', 0))).rejects.toMatchObject({ code: 'invalid_quantity' });
    await expect(store.capture(txn('issue', -2))).rejects.toMatchObject({ code: 'invalid_quantity' });
    // The trigger holds even if the service check is bypassed.
    await expect(db.run(`INSERT INTO inventory_transactions (id, journey_id, division_id, item_id, coach_code, txn_type, quantity, unit, created_at, updated_at)
      VALUES ('x', ?, ?, ?, 'B1', 'return', 5, 'litre', 't', 't')`, [IDS.journey, IDS.division, IDS.item])).rejects.toThrow(/return_exceeds_issue/);
  });

  it('keeps transaction history immutable', async () => {
    const { db, store } = await seededStore();
    await store.capture(txn('issue', 3));
    await expect(db.run('UPDATE inventory_transactions SET quantity = 30')).rejects.toThrow(/immutable/);
    await expect(db.run('DELETE FROM inventory_transactions')).rejects.toThrow(/immutable/);
    await db.run("UPDATE inventory_transactions SET sync_status = 'synced'"); // sync bookkeeping is allowed
  });
});

describe('media and sync bookkeeping', () => {
  it('stores bytes outside SQLite with checksum, size and owner, and detects corruption', async () => {
    const { files, store } = await seededStore();
    const capture = attendancePayload();
    await store.capture(capture);
    const id = capture.payload.photo_media_id;
    const meta = await store.media.getMeta(id);
    expect(meta).toMatchObject({ mime_type: 'image/jpeg', size_bytes: 25, storage_path: `media/${id}`, owner_id: capture.payload.id });
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files.map.has(id)).toBe(true);
    files.map.set(id, new TextEncoder().encode('tampered-bytes-for-tests!'));
    expect((await store.media.read(id)).intact).toBe(false);
  });

  it('sweeps orphaned files', async () => {
    const { files, store } = await seededStore();
    await store.capture(attendancePayload());
    files.map.set('orphan', new Uint8Array([1]));
    expect(await store.media.sweepOrphans()).toEqual(['orphan']);
    expect(files.map.size).toBe(1);
  });

  it('writes an audit event with every capture', async () => {
    const { store } = await seededStore();
    const capture = attendancePayload();
    await store.capture(capture);
    expect(await store.syncState.listAudit({ entityId: capture.payload.id })).toEqual([
      expect.objectContaining({ action: 'attendance.create.local', entity_type: 'attendance', actor_id: IDS.supervisor, division_id: IDS.division }),
    ]);
    await expect(store.db.run('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
  });

  it('discards a rejected record with its media and leaves a tombstone', async () => {
    const { db, files, store } = await seededStore();
    const capture = inspectionPayload();
    await store.capture(capture);
    await expect(store.discardRejected('inspection.create', capture.payload.id)).rejects.toMatchObject({ code: 'not_discardable' });
    await store.markOutcome({ type: 'inspection.create', entityId: capture.payload.id, outcome: 'rejected', message: 'day closed', code: 'journey_closed' });
    expect(await store.discardRejected('inspection.create', capture.payload.id)).toBe(true);
    expect(await store.inspections.get(capture.payload.id)).toBeNull();
    expect(files.map.size).toBe(0);
    expect(await store.syncState.isTombstoned('inspection', capture.payload.id)).toBe(true);
    expect((await db.query("SELECT sync_status FROM sync_outbox"))[0].sync_status).toBe('completed');
    expect(await store.syncState.listConflicts()).toEqual([]);
  });

  it('does not resurrect tombstoned journeys on pull, and does not advance the checkpoint on failures', async () => {
    const { db, store } = await seededStore({ seed: false });
    await db.transaction([store.syncState.tombstoneStatement({ entityType: 'journey', entityId: IDS.journey, now: 't' })]);
    const changes = changesFixture();
    changes.journeys.push({ ...journeyOut(uid(29), '2026-11-04', '2026-11-05'), train_id: null }); // invalid row
    const result = await store.ingestChanges(changes);
    expect(result).toMatchObject({ ok: false, journeys: 3, failures: 1 });
    expect(await store.journeys.get(IDS.journey, TODAY)).toBeNull();
    expect((await store.syncState.getCheckpoint('changes')).cursor ?? null).toBeNull();
  });

  it('summarises a journey and a division dashboard from local data', async () => {
    const { store } = await seededStore();
    await store.capture(attendancePayload({ stage: 1 }));
    await store.capture(inspectionPayload());
    const s = await store.journeySummary(IDS.journey);
    expect(s).toMatchObject({ staff_allocated: 2, attendance_records: 1, attendance_by_stage: { 1: 1 }, inspections_required: 16, inspections_done: 1 });
    const d = await store.divisionDashboard(IDS.division);
    expect(d).toMatchObject({ date: TODAY, journeys_active: 1, journeys_scheduled: 1, attendance_today: 1, inspections_today: 1 });
  });
});
