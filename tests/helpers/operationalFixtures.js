// A realistic GET /sync/changes payload (backend ChangesOut shape) and capture payload builders,
// all on a fixed clock so business-date rules are deterministic.
import { createMemoryDb } from './memoryDb.js';
import { createMemoryFiles } from './memoryFiles.js';
import { createLocalStore } from '../../src/services/localStore.js';
import { addDays } from '../../src/utils/businessDate.js';

export const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 2026-11-04 11:30 in Asia/Kolkata.
export const NOW = new Date('2026-11-04T06:00:00Z');
export const TS = '2026-11-04T11:00:00+05:30';
export const GPS = { latitude: 28.6139, longitude: 77.209, gps_accuracy_m: 12 };

export const IDS = {
  division: uid(1), otherDivision: uid(2), train: uid(10), linkedTrain: uid(11), journey: uid(20), futureJourney: uid(21),
  pastJourney: uid(22), cancelledJourney: uid(23), supervisor: uid(30), janitor1: uid(31), janitor2: uid(32), outsider: uid(33),
  passengerBank: uid(40), globalBank: uid(41), railwayBank: uid(42), q1: uid(50), q2: uid(51), q3: uid(52), r1: uid(53), r2: uid(54),
  item: uid(60), department: uid(70), category: uid(71), subcategory: uid(72),
};

const coaches = [{ code: 'B1', classification: 'AC', position: 1 }, { code: 'S1', classification: 'NON_AC', position: 2 }];
const staffRow = (journeyId, n, user, name, extra = {}) => ({
  id: uid(1000 + Number(journeyId.slice(-4)) * 10 + n), user_id: user, role_id: 5, name, emp_id: `EMP${n}`, allocated_at: '2026-11-01T00:00:00Z', removed_at: null, ...extra,
});

export function journeyOut(id, journeyDate, endDate, extra = {}) {
  return {
    id, division_id: IDS.division, train_id: IDS.train, train_no: '12951', train_name: 'Mumbai Rajdhani', linked_train_id: IDS.linkedTrain,
    linked_train_no: '12952', journey_date: journeyDate, outbound_end_date: journeyDate, linked_journey_date: endDate, end_date: endDate,
    start_time: '16:30:00', end_time: '08:30:00', return_start_time: null, return_end_time: null, duration_days: 1, operational_days: 2,
    daywise: false, inspection_rounds_per_day: 2, before_inspection_enabled: true, after_inspection_enabled: true,
    supervisor_id: IDS.supervisor, supervisor_name: 'Ravi Kumar', created_by_id: IDS.supervisor, state: 'active', cancel_reason: null,
    cancelled_at: null, version: 1, coaches, updated_at: '2026-11-01T00:00:00Z',
    staff: [staffRow(id, 1, IDS.janitor1, 'Sunita Devi'), staffRow(id, 2, IDS.janitor2, 'Mohan Lal')],
    ...extra,
  };
}

// `today` (YYYY-MM-DD, Asia/Kolkata) anchors the journey dates; the unit tests use a fixed clock.
export function changesFixture(today = '2026-11-04') {
  const train = (id, no, extra = {}) => ({
    id, division_id: IDS.division, train_no: no, name: `Train ${no}`, duration_days: 1, operational_days: 2, start_time: null, end_time: null,
    return_start_time: null, return_end_time: null, daywise: false, inspection_rounds_per_day: 2, before_inspection_enabled: true,
    after_inspection_enabled: true, is_active: true, coaches, updated_at: '2026-10-01T00:00:00Z', ...extra,
  });
  const q = (id, position, extra = {}) => ({
    id, position, text_en: `Question ${position}`, text_hi: null, applies_ac: true, applies_non_ac: true, required: true, psi_weight: 25, ...extra,
  });
  const bank = (id, divisionId, audience, questions, extra = {}) => ({
    id, division_id: divisionId, audience, name: `${audience} bank`, scale_min: 1, scale_max: 5, is_active: true, questions,
    updated_at: '2026-10-01T00:00:00Z', ...extra,
  });
  return {
    cursor: '2026-11-04T05:59:00Z',
    full: true,
    divisions: [
      { id: IDS.division, code: 'NDLS', name: 'Delhi Division', is_active: true, updated_at: '2026-10-01T00:00:00Z' },
      { id: IDS.otherDivision, code: 'BCT', name: 'Mumbai Division', is_active: true, updated_at: '2026-10-01T00:00:00Z' },
    ],
    policies: { [IDS.division]: { passenger_pnr_required: true, railway_feedback_limit_per_journey: 2, complaint_default_sla_hours: 72 } },
    trains: [train(IDS.train, '12951'), train(IDS.linkedTrain, '12952')],
    inventory_items: [{ id: IDS.item, division_id: IDS.division, name: 'Phenyl', unit: 'litre', ideal_qty: 5, is_active: true, updated_at: '2026-10-01T00:00:00Z' }],
    question_banks: [
      bank(IDS.passengerBank, IDS.division, 'passenger', [q(IDS.q1, 1), q(IDS.q2, 2, { applies_non_ac: false }), q(IDS.q3, 3, { required: false })]),
      bank(IDS.globalBank, null, 'passenger', [q(uid(55), 1)]),
      bank(IDS.railwayBank, null, 'railway', [q(IDS.r1, 1), q(IDS.r2, 2, { required: false })]),
    ],
    complaint_departments: [{ id: IDS.department, division_id: IDS.division, name: 'Mechanical (C&W)', is_active: true }],
    complaint_categories: [
      { id: IDS.subcategory, division_id: IDS.division, parent_id: IDS.category, name: 'Toilet', default_department_id: null, sla_hours: 2, sort_order: 1, is_active: true },
      { id: IDS.category, division_id: IDS.division, parent_id: null, name: 'Cleanliness', default_department_id: IDS.department, sla_hours: 4, sort_order: 0, is_active: true },
    ],
    journeys: [
      journeyOut(IDS.journey, today, addDays(today, 1)),
      journeyOut(IDS.futureJourney, addDays(today, 4), addDays(today, 5), { state: 'scheduled' }),
      journeyOut(IDS.pastJourney, addDays(today, -15), addDays(today, -14), { state: 'history' }),
      journeyOut(IDS.cancelledJourney, today, addDays(today, 1), { state: 'cancelled', cancel_reason: 'Rake replaced', cancelled_at: '2026-11-03T00:00:00Z' }),
    ],
  };
}

// A store over a fresh migrated database, seeded through the real ingestion path.
export async function seededStore({ filename, files = createMemoryFiles(), now = () => NOW, seed = true } = {}) {
  const db = await createMemoryDb({ filename });
  const store = createLocalStore({ db, files, now, logger: null });
  if (seed) {
    const result = await store.ingestChanges(changesFixture());
    if (!result.ok) throw new Error('fixture ingestion failed');
  }
  return { db, files, store };
}

// Permissions a field user holds in the fixture division (cached /auth/me shape).
export const FIELD_PERMS = [
  'journeys.read', 'journeys.read_all', 'attendance.submit', 'attendance.read', 'inspections.submit', 'inspections.read',
  'feedback.collect', 'feedback.railway.submit', 'feedback.read', 'complaints.create', 'complaints.read', 'inventory.transact',
  'inventory.read', 'dashboard.read', 'trains.read', 'users.read',
];
export const actorFor = (id, perms = FIELD_PERMS, divisions = [IDS.division]) => ({
  id, permissions: Object.fromEntries(divisions.map((d) => [d, perms])),
});

export const PHOTO = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes-for-tests').toString('base64')}`;

export function attendancePayload(extra = {}) {
  const photo = extra.photo_media_id === undefined ? crypto.randomUUID() : extra.photo_media_id;
  const payload = {
    id: crypto.randomUUID(), journey_id: IDS.journey, employee_id: IDS.janitor1, stage: 1, device_timestamp: TS, ...GPS,
    ...extra, photo_media_id: photo,
  };
  return {
    type: 'attendance.create', payload,
    media: photo ? [{ id: photo, kind: 'attendance_photo', dataUrl: PHOTO }] : [],
    actor: actorFor(IDS.supervisor),
  };
}

export function inspectionPayload(extra = {}) {
  const photo = crypto.randomUUID();
  return {
    type: 'inspection.create',
    payload: { id: crypto.randomUUID(), journey_id: IDS.journey, coach_code: 'B1', day: 1, round: 1, phase: 'B', comments: null, device_timestamp: TS, ...GPS, photo_media_id: photo, ...extra },
    media: [{ id: photo, kind: 'inspection_photo', dataUrl: PHOTO }],
    actor: actorFor(IDS.janitor1),
  };
}
