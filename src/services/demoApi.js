// Frontend Demo / Preview Mode (VITE_DEMO_MODE=true): answers GET requests with sample data so every
// screen can be shown without FastAPI/PostgreSQL. Writes are refused, never pretended to succeed.
import { ApiError } from './apiClient.js';

export const DEMO_MODE = import.meta.env?.VITE_DEMO_MODE === 'true';

const D = '00000000-0000-4000-8000-0000000000d1';
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ts = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const ALL_PERMS = [
  'divisions.manage', 'audit.read', 'users.read', 'users.manage', 'trains.read', 'trains.manage', 'journeys.read',
  'journeys.read_all', 'journeys.manage', 'staff.manage', 'attendance.submit', 'attendance.read', 'inspections.submit',
  'inspections.read', 'feedback.collect', 'feedback.railway.submit', 'feedback.read', 'complaints.create',
  'complaints.read', 'complaints.manage', 'reports.read', 'dashboard.read', 'media.upload',
];

const user = (n, name, role, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000u${String(n).padStart(3, '0')}`, emp_id: `EMP${100 + n}`, name, name_hindi: null,
  email: `${name.split(' ')[0].toLowerCase()}@demo.swachh`, mobile: null, gender: null, designation: null, lang: 'en',
  role_id: role, division_id: D, status: 'active', firebase_linked: true, updated_at: ts(48), ...extra,
});
const USERS = [
  user(1, 'Demo Administrator', 1), user(2, 'Priya Sharma', 3), user(3, 'Ravi Kumar', 4), user(4, 'Anil Verma', 4),
  user(5, 'Sunita Devi', 5), user(6, 'Mohan Lal', 5), user(7, 'Kavita Singh', 5), user(8, 'Rajesh Yadav', 5, { firebase_linked: false }),
];
export const DEMO_ME = { user: USERS[0], divisions: { [D]: ALL_PERMS }, demo: true };

const coaches = (codes) => codes.map((c, i) => ({ code: c, classification: /^[AB]/.test(c) ? 'AC' : 'NON_AC', position: i + 1 }));
const TRAINS = [
  { id: 't1', train_no: '12951 / 12952', name: 'Mumbai Rajdhani Express', coaches: coaches(['A1', 'B1', 'B2', 'B3', 'B4']), inspection_rounds_per_day: 2 },
  { id: 't2', train_no: '12009 / 12010', name: 'Shatabdi Express', coaches: coaches(['C1', 'C2', 'C3', 'D1', 'D2', 'D3']), inspection_rounds_per_day: 1 },
  { id: 't3', train_no: '19019 / 19020', name: 'Dehradun Express', coaches: coaches(['S1', 'S2', 'S3', 'S4', 'B1']), inspection_rounds_per_day: 1 },
].map((t) => ({
  division_id: D, duration_days: 1, operational_days: 2, start_time: '16:30:00', end_time: '08:30:00', return_start_time: null,
  return_end_time: null, daywise: false, before_inspection_enabled: true, after_inspection_enabled: true, is_active: true, updated_at: ts(72), ...t,
}));

const staff = (u) => ({ id: `sa-${u.id}`, user_id: u.id, role_id: u.role_id, name: u.name, emp_id: u.emp_id, allocated_at: ts(30), removed_at: null });
const journey = (id, train, start, state, sup, crew, extra = {}) => ({
  id, division_id: D, train_id: train.id, train_no: train.train_no, train_name: train.name, linked_train_id: null, linked_train_no: null,
  journey_date: day(start), outbound_end_date: day(start + 1), linked_journey_date: day(start + 1), end_date: day(start + 1),
  start_time: train.start_time, end_time: train.end_time, return_start_time: null, return_end_time: null,
  duration_days: train.duration_days, operational_days: train.operational_days, daywise: false,
  inspection_rounds_per_day: train.inspection_rounds_per_day, before_inspection_enabled: true, after_inspection_enabled: true,
  supervisor_id: sup.id, supervisor_name: sup.name, created_by_id: USERS[1].id, state, cancel_reason: null, cancelled_at: null,
  version: 1, coaches: train.coaches, updated_at: ts(5), staff: crew.map(staff), ...extra,
});
const JOURNEYS = [
  journey('j1', TRAINS[0], 0, 'active', USERS[2], USERS.slice(4, 7)),
  journey('j2', TRAINS[1], 0, 'active', USERS[3], USERS.slice(6, 8)),
  journey('j3', TRAINS[2], 3, 'scheduled', USERS[2], USERS.slice(4, 6)),
  journey('j4', TRAINS[0], -6, 'history', USERS[3], USERS.slice(4, 8)),
  journey('j5', TRAINS[1], -3, 'cancelled', USERS[2], [], { cancel_reason: 'Rake replaced at short notice', cancelled_at: ts(80) }),
];

const page = (items, q) => {
  const size = Number(q.page_size ?? 50);
  return { items: items.slice(0, size), total: items.length, page: 1, page_size: size };
};

function attendanceStatus(j) {
  return j.staff.map((s, i) => {
    const taken = Math.max(0, 3 - i);
    return {
      employee_id: s.user_id, name: s.name, emp_id: s.emp_id, role_id: s.role_id, completed: taken === 5,
      stages: [1, 2, 3, 4, 5].map((st) => ({ stage: st, status: st <= taken ? 'taken' : st === taken + 1 ? 'next' : 'locked', attendance_id: null })),
    };
  });
}

function inspectionGrid(j) {
  const phases = ['B', 'A'];
  return [1, 2].flatMap((d) => j.coaches.map((c, ci) => {
    const cells = [];
    for (let r = 1; r <= j.inspection_rounds_per_day; r += 1) {
      phases.forEach((p, pi) => {
        const done = d === 1 && (r === 1 || ci % 2 === 0) && !(pi === 1 && ci === j.coaches.length - 1);
        cells.push({ round: r, phase: p, status: d === 2 ? 'locked' : done ? 'taken' : 'open', inspection_id: null });
      });
    }
    return { coach_code: c.code, day: d, day_open: d === 1, required: cells.length, done: cells.filter((x) => x.status === 'taken').length, cells };
  }));
}

const BANK = {
  id: 'qb1', division_id: D, audience: 'passenger', name: 'Passenger satisfaction', scale_min: 1, scale_max: 5, is_active: true, updated_at: ts(400),
  questions: ['Cleanliness of coach and toilets', 'Availability of water in toilets', 'Behaviour of housekeeping staff', 'Overall satisfaction'].map((t, i) => ({
    id: `q${i + 1}`, position: i + 1, text_en: t, text_hi: null, applies_ac: true, applies_non_ac: true, required: true, psi_weight: 25,
  })),
};
const RAIL_BANK = { ...BANK, id: 'qb2', audience: 'railway', name: 'Railway inspection' };

const FEEDBACK = [
  ['Amit Patel', 'B2', 'completed', 'valid', 'verified'], ['Neha Gupta', 'B1', 'verified', 'valid', 'verified'],
  ['Suresh Rao', 'A1', 'draft', 'pending', 'not_sent'], ['Farah Khan', 'C2', 'completed', 'not_required', 'verified'],
  ['Vikram Joshi', 'B3', 'void', 'invalid', 'not_sent'],
].map(([name, coach, status, pnr, otp], i) => ({
  id: `fb${i + 1}`, journey_id: i === 3 ? 'j2' : 'j1', division_id: D, bank_id: 'qb1', coach_code: coach, coach_class: 'AC', journey_day: 1,
  feedback_date: day(0), passenger_name: name, mobile_masked: `98XXXXX${210 + i}`, pnr: `24518${70000 + i * 37}`, seat_no: `${12 + i}`,
  status, pnr_status: pnr, otp_status: otp, void_reason: status === 'void' ? 'PNR not on this train' : null, comments: null, voice_media_id: null,
  ratings: status === 'completed' ? BANK.questions.map((q, k) => ({ question_id: q.id, value: 4 + ((i + k) % 2) })) : [],
  collected_by_id: USERS[0].id, device_timestamp: ts(i + 1), server_timestamp: ts(i + 1), verified_at: null, completed_at: status === 'completed' ? ts(i) : null,
}));

const CATEGORIES = [
  { id: 'cat1', name: 'Cleanliness', sla_hours: 4 }, { id: 'cat2', name: 'Water supply', sla_hours: 2 },
  { id: 'cat3', name: 'Pest control', sla_hours: 24 }, { id: 'cat3a', name: 'Cockroaches', parent_id: 'cat3', sla_hours: 24 },
].map((c, i) => ({ division_id: D, parent_id: null, default_department_id: 'dep1', sort_order: i, is_active: true, ...c }));
const DEPARTMENTS = [{ id: 'dep1', division_id: D, name: 'Mechanical (C&W)', is_active: true }, { id: 'dep2', division_id: D, name: 'Commercial', is_active: true }];

const COMPLAINTS = [
  ['Toilet in coach B2 not cleaned since departure', 'B2', 'cat1', 'created', 1, false],
  ['No water in wash basin of coach B1', 'B1', 'cat2', 'in_process', 3, true],
  ['Cockroaches seen near berth 23', 'A1', 'cat3', 'forwarded', 10, false],
  ['Dustbin overflowing in vestibule', 'C3', 'cat1', 'completed', 30, false],
].map(([desc, coach, cat, status, age, overdue], i) => ({
  id: `c${i + 1}`, complaint_no: `CMP-${day(0).replace(/-/g, '')}-${String(i + 1).padStart(3, '0')}`, division_id: D,
  journey_id: i === 3 ? 'j2' : 'j1', train_id: 't1', coach_code: coach, coach_class: 'AC', category_id: cat, subcategory_id: null,
  description: desc, latitude: null, longitude: null, department_id: 'dep1', assigned_to_id: null, status, sla_hours: 4,
  due_at: ts(age - 4), is_overdue: overdue, resolution_remarks: status === 'completed' ? 'Cleaned and dustbin emptied by on-board staff.' : null,
  closed_at: status === 'completed' ? ts(age - 2) : null, closed_by_id: null, created_by_id: USERS[2].id, server_timestamp: ts(age), attachment_ids: [],
  history: [{ id: `h${i}a`, from_status: null, to_status: 'created', actor_id: USERS[2].id, forwarded_to_id: null, department_id: null, remarks: null, created_at: ts(age) }]
    .concat(status !== 'created' ? [{ id: `h${i}b`, from_status: 'created', to_status: status, actor_id: USERS[1].id, forwarded_to_id: null, department_id: 'dep1', remarks: 'Assigned to on-board team', created_at: ts(age - 1) }] : []),
}));

const AUDIT = [
  ['journey.create', 'journey', 2], ['attendance.create', 'attendance', 1], ['inspection.create', 'inspection', 1],
  ['complaint.transition', 'complaint', 3], ['feedback.passenger.complete', 'passenger_feedback', 4], ['staff.allocate', 'journey', 6],
].map(([action, entity_type, h], i) => ({ id: `a${i}`, created_at: ts(h), actor_id: USERS[1].id, division_id: D, action, entity_type, entity_id: 'j1', changes: {} }));

const ROUTES = [
  [/^\/divisions$/, () => [{ id: D, code: 'NDLS', name: 'Delhi Division (Demo)', is_active: true, updated_at: ts(500) }]],
  [/^\/dashboard\/divisions\/[^/]+$/, () => ({
    division_id: D, date: day(0), journeys_active: 2, journeys_scheduled: 1, attendance_today: 14, inspections_today: 21,
    passenger_feedback_today: 5, railway_feedback_today: 1, complaints_open: 3, complaints_overdue: 1,
  })],
  [/^\/journeys$/, (q) => page(JOURNEYS.filter((j) => !q.state || j.state === q.state), q)],
  [/^\/journeys\/([^/]+)\/summary$/, (q, [id]) => ({
    journey_id: id, state: JOURNEYS.find((j) => j.id === id)?.state, staff_allocated: 3, attendance_records: 6, attendance_by_stage: { 1: 3, 2: 2, 3: 1 },
    staff_fully_attended: 0, inspections_required: 40, inspections_done: 26, inspection_completion_pct: 65, passenger_feedback_counted: 3,
    passenger_feedback_completed: 2, passenger_feedback_pending: 1, passenger_feedback_void: 1, railway_feedback: 1,
    complaints_open: 3, complaints_overdue: 1, complaints_closed: 1, inventory_lines: 4,
  })],
  [/^\/journeys\/([^/]+)$/, (q, [id]) => JOURNEYS.find((j) => j.id === id)],
  [/^\/attendance\/journeys\/([^/]+)\/status$/, (q, [id]) => attendanceStatus(JOURNEYS.find((j) => j.id === id))],
  [/^\/inspections\/journeys\/([^/]+)\/status$/, (q, [id]) => inspectionGrid(JOURNEYS.find((j) => j.id === id))],
  [/^\/trains$/, (q) => page(TRAINS, q)],
  [/^\/users$/, (q) => page(USERS.filter((u) => (!q.role_id || u.role_id === Number(q.role_id))
    && (!q.q || `${u.name} ${u.emp_id}`.toLowerCase().includes(q.q.toLowerCase()))), q)],
  [/^\/audit$/, (q) => page(AUDIT, q)],
  [/^\/feedback\/passenger$/, (q) => page(FEEDBACK, q)],
  [/^\/feedback\/passenger\/([^/]+)$/, (q, [id]) => FEEDBACK.find((f) => f.id === id)],
  [/^\/feedback\/questions$/, (q) => (q.audience === 'railway' ? RAIL_BANK : BANK).questions],
  [/^\/feedback\/question-banks$/, () => [BANK, RAIL_BANK]],
  [/^\/feedback\/railway$/, (q) => page([], q)],
  [/^\/complaints\/categories$/, () => CATEGORIES],
  [/^\/complaints\/departments$/, () => DEPARTMENTS],
  [/^\/complaints$/, (q) => page(COMPLAINTS.filter((c) => !q.status || c.status === q.status), q)],
  [/^\/complaints\/([^/]+)$/, (q, [id]) => COMPLAINTS.find((c) => c.id === id)],
  [/^\/reports\/attendance$/, (q) => (q.group_by === 'journey' ? JOURNEYS.slice(0, 2) : USERS.slice(4)).map((x, i) => ({
    key_id: x.id, label: x.train_no ?? x.name, journeys: 2 - (i % 2), records: 8 - i, stages: { 1: 3, 2: 2, 3: 2 - (i % 2), 4: 1, 5: i ? 0 : 1 }, verified: 6 - i, rejected: i % 2,
  }))],
  [/^\/reports\/inspections$/, () => JOURNEYS.filter((j) => j.state !== 'scheduled' && j.state !== 'cancelled').map((j, i) => ({
    journey_id: j.id, train_no: j.train_no, journey_date: j.journey_date, coach_code: null, required: 40, done: [26, 18, 40][i], completion_pct: [65, 45, 100][i], verified: 12, rejected: 1,
  }))],
  [/^\/reports\/feedback\/(\w+)$/, (q, [aud]) => ({
    audience: aud, bank_id: 'qb1', scale_min: 1, scale_max: 5, total: aud === 'railway' ? 3 : 42,
    by_status: aud === 'railway' ? { verified: 3 } : { completed: 36, verified: 2, void: 4 }, by_coach_class: { AC: 30, NON_AC: 12 },
    questions: BANK.questions.map((x, i) => ({ question_id: x.id, position: x.position, text_en: x.text_en, responses: 36, average: 4.4 - i * 0.2 })),
  })],
  [/^\/reports\/psi$/, () => JOURNEYS.slice(0, 2).concat(JOURNEYS[3]).map((j, i) => ({ journey_id: j.id, train_no: j.train_no, journey_date: j.journey_date, responses: 12 + i * 5, psi: 86.5 - i * 4.2 }))],
  [/^\/reports\/complaints$/, () => ({
    total: 18, by_status: { created: 3, in_process: 4, forwarded: 2, completed: 9 }, overdue: 2, avg_resolution_hours: 3.6,
    by_category: [{ category_id: 'cat1', name: 'Cleanliness', count: 9 }, { category_id: 'cat2', name: 'Water supply', count: 6 }, { category_id: 'cat3', name: 'Pest control', count: 3 }],
  })],
  [/^\/reports\/inventory$/, () => [['Phenyl', 'litre', 40, 6, 34], ['Garbage bags', 'piece', 600, 120, 480], ['Hand towels', 'piece', 200, 150, 50]]
    .map(([n, u, iss, ret, con], i) => ({ item_id: `inv${i}`, item_name: n, unit: u, issued: iss, returned: ret, consumed: con, journeys: 6 }))],
];

export function createDemoApi() {
  async function request(method, path, { query } = {}) {
    if (method !== 'GET') throw new ApiError(403, 'demo_mode', 'Demo mode: changes are not saved. Connect the backend to record data.');
    const q = Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    for (const [re, fn] of ROUTES) {
      const m = path.match(re);
      if (m) {
        const data = fn(q, m.slice(1));
        if (data === undefined) throw new ApiError(404, 'not_found', 'Not found in demo data');
        return structuredClone(data);
      }
    }
    throw new ApiError(404, 'endpoint_unavailable', `No demo data for GET ${path}`);
  }
  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path) => request('POST', path),
    patch: (path) => request('PATCH', path),
    put: (path) => request('PUT', path),
    del: (path) => request('DELETE', path),
    putRaw: (path) => request('PUT', path),
  };
}
