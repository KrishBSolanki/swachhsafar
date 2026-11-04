// CP-11 offline reports: calculated from device records with the backend formulas, scoped by reports.read,
// never counting another user's unsynced records. Plus the offline group attendance and voice-format
// rules the screens rely on.
import { describe, expect, it } from 'vitest';
import { createLocalApi } from '../../src/services/localApi.js';
import { voiceFormat } from '../../src/utils/voiceRecording.js';
import { FIELD_PERMS, GPS, IDS, PHOTO, TS, actorFor, attendancePayload, inspectionPayload, seededStore } from '../helpers/operationalFixtures.js';

const DAY = '2026-11-04';
const RANGE = { date_from: DAY, date_to: DAY };
const REPORT_PERMS = [...FIELD_PERMS, 'reports.read'];

async function setup({ userId = IDS.supervisor, perms = REPORT_PERMS } = {}) {
  const seeded = await seededStore();
  const ctx = { userId, permissions: { [IDS.division]: perms } };
  const api = createLocalApi({ store: seeded.store, getContext: () => ctx });
  return { ...seeded, api, ctx };
}

const txn = (txn_type, quantity) => ({
  type: 'inventory.record',
  payload: { id: crypto.randomUUID(), journey_id: IDS.journey, item_id: IDS.item, coach_code: 'B1', txn_type, quantity, device_timestamp: TS },
  actor: actorFor(IDS.supervisor),
});

describe('local reports (offline)', () => {
  it('attendance: staff-wise and journey-wise counts by stage', async () => {
    const { api, store } = await setup();
    await store.capture(attendancePayload());
    await store.capture(attendancePayload({ stage: 2 }));
    await store.capture(attendancePayload({ employee_id: IDS.janitor2 }));
    const staff = await api.get('/reports/attendance', RANGE);
    expect(staff).toEqual([
      expect.objectContaining({ key_id: IDS.janitor2, journeys: 1, records: 1, stages: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 } }),
      expect.objectContaining({ key_id: IDS.janitor1, journeys: 1, records: 2, stages: { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0 }, verified: 0, rejected: 0 }),
    ]);
    const journeys = await api.get('/reports/attendance', { ...RANGE, group_by: 'journey' });
    expect(journeys).toEqual([expect.objectContaining({ key_id: IDS.journey, label: `12951 / ${DAY}`, records: 3 })]);
    expect(await api.get('/reports/attendance', { date_from: '2026-11-05', date_to: '2026-11-06' })).toEqual([]);
  });

  it('never counts another user\'s unsynced records (shared device)', async () => {
    const { api, store, ctx } = await setup();
    await store.capture(attendancePayload()); // recorded by the supervisor, still pending
    ctx.userId = IDS.janitor1;
    expect(await api.get('/reports/attendance', RANGE)).toEqual([]);
  });

  it('inspections: required = days x rounds x phases per coach, journey-wise and coach-wise', async () => {
    const { api, store } = await setup({ userId: IDS.janitor1 }); // the fixture inspection is janitor1's
    await store.capture(inspectionPayload());
    const rows = await api.get('/reports/inspections', RANGE);
    const active = rows.find((r) => r.journey_id === IDS.journey);
    expect(active).toMatchObject({ coach_code: null, required: 16, done: 1, completion_pct: 6.25 }); // 2 coaches x 2 days x 2 rounds x 2 phases
    expect(rows.some((r) => r.journey_id === IDS.cancelledJourney)).toBe(false);
    const coaches = await api.get('/reports/inspections', { ...RANGE, coach_wise: true });
    expect(coaches.filter((r) => r.journey_id === IDS.journey)).toEqual([
      expect.objectContaining({ coach_code: 'B1', required: 8, done: 1, completion_pct: 12.5 }),
      expect.objectContaining({ coach_code: 'S1', required: 8, done: 0, completion_pct: 0 }),
    ]);
  });

  it('inventory: issued, returned and consumed per item over the journeys of the period', async () => {
    const { api, store } = await setup();
    await store.capture(txn('issue', 10));
    await store.capture(txn('return', 4));
    expect(await api.get('/reports/inventory', RANGE)).toEqual([
      expect.objectContaining({ item_id: IDS.item, item_name: 'Phenyl', unit: 'litre', issued: 10, returned: 4, consumed: 6, journeys: 1 }),
    ]);
  });

  it('complaints: totals by status and category', async () => {
    const { api, store } = await setup({ userId: IDS.janitor1 });
    const media = crypto.randomUUID();
    await store.capture({
      type: 'complaint.create',
      payload: { id: crypto.randomUUID(), division_id: IDS.division, category_id: IDS.category, subcategory_id: IDS.subcategory, journey_id: IDS.journey, coach_code: 'B1', description: 'Toilet not cleaned', latitude: null, longitude: null, device_timestamp: TS, attachment_ids: [media] },
      media: [{ id: media, kind: 'complaint_attachment', dataUrl: PHOTO }],
      actor: actorFor(IDS.janitor1),
    });
    const r = await api.get('/reports/complaints', RANGE);
    expect(r).toMatchObject({ total: 1, by_status: { created: 1 }, overdue: 0, avg_resolution_hours: null });
    expect(r.by_category).toEqual([expect.objectContaining({ category_id: IDS.category, total: 1, open: 1 })]);
  });

  it('railway feedback: question averages from the bank in use; unsynced records count as not_synced', async () => {
    const { api, store } = await setup();
    for (const value of [4, 5]) {
      await store.capture({
        type: 'feedback.railway.create',
        payload: { id: crypto.randomUUID(), journey_id: IDS.journey, coach_code: 'B1', journey_day: 1, railway_employee_id: 'RLY42', official_name: 'A. Inspector', ratings: [{ question_id: IDS.r1, value }], device_timestamp: TS, ...GPS },
        actor: actorFor(IDS.supervisor),
      });
    }
    const r = await api.get('/reports/feedback/railway', RANGE);
    expect(r).toMatchObject({ audience: 'railway', bank_id: IDS.railwayBank, total: 2, by_status: { not_synced: 2 } });
    expect(r.questions.find((q) => q.question_id === IDS.r1)).toMatchObject({ responses: 2, average: 4.5 });
  });

  it('enforces reports.read, division scope and the date range like the server', async () => {
    const { api } = await setup({ perms: FIELD_PERMS });
    await expect(api.get('/reports/attendance', RANGE)).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
    const ok = await setup();
    await expect(ok.api.get('/reports/attendance', { ...RANGE, division_id: IDS.otherDivision })).rejects.toMatchObject({ status: 403, code: 'division_forbidden' });
    await expect(ok.api.get('/reports/attendance', { date_from: DAY, date_to: '2026-11-01' })).rejects.toMatchObject({ status: 422 });
    await expect(ok.api.get('/reports/attendance', { date_from: '2025-01-01', date_to: DAY })).rejects.toMatchObject({ status: 422 });
  });
});

describe('group attendance (offline)', () => {
  it('is one attendance.create per member sharing group_submission_id, delivered as-is to /sync/batch', async () => {
    const { store, db } = await seededStore();
    const group = crypto.randomUUID();
    await store.capture(attendancePayload({ group_submission_id: group }));
    await store.capture(attendancePayload({ employee_id: IDS.janitor2, group_submission_id: group }));
    const ops = (await db.query("SELECT payload FROM sync_outbox WHERE operation = 'attendance.create' ORDER BY created_at")).map((r) => JSON.parse(r.payload).op);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.type === 'attendance.create' && o.payload.group_submission_id === group)).toBe(true);
    expect(new Set(ops.map((o) => o.payload.employee_id))).toEqual(new Set([IDS.janitor1, IDS.janitor2]));
    // Members are independent: a duplicate for one member is refused without affecting the other.
    await expect(store.capture(attendancePayload({ group_submission_id: group }))).rejects.toMatchObject({ code: 'duplicate_attendance' });
  });
});

describe('voice recording format', () => {
  it('prefers WebM/Opus, declared as video/webm (the server content type for WebM voice)', () => {
    expect(voiceFormat((t) => t.startsWith('audio/webm'))).toEqual(['audio/webm;codecs=opus', 'video/webm']);
    expect(voiceFormat((t) => t === 'audio/mp4')).toEqual(['audio/mp4', 'audio/mp4']);
    expect(voiceFormat(() => false)).toBeNull();
  });
});
