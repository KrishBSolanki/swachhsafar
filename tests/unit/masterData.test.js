// CP-03: master-data administration — validation, permissions, online-only writes through the local-first
// API, local cache updates from confirmed server responses, and offline reads with division isolation.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/services/apiClient.js';
import { createLocalApi } from '../../src/services/localApi.js';
import { createLocalFirstApi } from '../../src/services/localFirstApi.js';
import { canManageMaster } from '../../src/services/authorization.js';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createLocalStore } from '../../src/services/localStore.js';
import {
  POLICY_FIELDS, bankPayload, policyPayload, validateBank, validateCategory, validateDepartment, validateItem, validatePolicy,
} from '../../src/utils/masterValidation.js';
import { FIELD_PERMS, IDS, NOW, actorFor, attendancePayload, seededStore, uid } from '../helpers/operationalFixtures.js';

const ADMIN_PERMS = [...FIELD_PERMS, 'questions.manage', 'complaints.masters.manage', 'inventory.items.manage', 'policies.manage'];
const me = (perms, divisions = [IDS.division], roleId = 2) => ({
  user: { id: IDS.supervisor, role_id: roleId }, divisions: Object.fromEntries(divisions.map((d) => [d, perms])),
});

// A fake FastAPI for the master endpoints, with the backend's permission rules.
function fakeServer(session) {
  const calls = [];
  const allowed = (perm, division) => session.me.divisions[division]?.includes(perm);
  const deny = () => { throw new ApiError(403, 'permission_denied', 'Missing permission'); };
  const handlers = {
    'POST /complaints/categories': (b) => (allowed('complaints.masters.manage', b.division_id) ? { id: uid(800), parent_id: null, sort_order: 0, sla_hours: null, default_department_id: null, is_active: true, ...b } : deny()),
    'PATCH /complaints/departments/': (b, id) => ({ id, division_id: IDS.division, name: 'Mechanical (C&W)', is_active: true, ...b }),
    'POST /inventory/items': (b) => (b.name.length < 2 ? (() => { throw new ApiError(422, 'validation_error', 'name: too short'); })() : { id: uid(801), is_active: true, updated_at: '2026-11-04T06:00:00Z', ...b }),
    'PUT /divisions/': (b) => b,
    'POST /feedback/question-banks': (b) => ({ id: uid(802), is_active: false, updated_at: '2026-11-04T06:00:00Z', ...b, questions: b.questions.map((q, i) => ({ id: uid(810 + i), position: i + 1, ...q })) }),
    'POST /feedback/question-banks/': (b, id) => ({ ...session.created, id, is_active: true }),
  };
  const call = async (method, path, body) => {
    calls.push([method, path, body]);
    if (session.down) throw new ApiError(0, 'network_error', 'Cannot reach the Swachh Safar server.');
    const key = Object.keys(handlers).find((k) => `${method} ${path}` === k) ?? Object.keys(handlers).find((k) => k.endsWith('/') && `${method} ${path}`.startsWith(k));
    if (!key) throw new ApiError(404, 'endpoint_unavailable', 'nope');
    const id = path.split('/').filter(Boolean)[2];
    const out = handlers[key](body ?? {}, id);
    if (key === 'POST /feedback/question-banks') session.created = out;
    return structuredClone(out);
  };
  return {
    calls,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

async function setup({ perms = ADMIN_PERMS, online = true } = {}) {
  const seeded = await seededStore();
  const session = { me: me(perms), online, down: false };
  const remote = fakeServer(session);
  const ctx = () => ({ userId: session.me.user.id, permissions: session.me.divisions });
  const api = createLocalFirstApi({
    remote, local: createLocalApi({ store: seeded.store, getContext: ctx }), store: seeded.store, isOnline: () => session.online, getContext: ctx, logger: null,
  });
  return { ...seeded, session, remote, api };
}

describe('master-data form validation (mirrors the Pydantic schemas)', () => {
  const q = (extra = {}) => ({ text_en: 'Toilet cleanliness', text_hi: '', applies_ac: true, applies_non_ac: true, required: true, psi_weight: '', ...extra });

  it('validates question banks and builds the create payload', () => {
    expect(validateBank({ name: 'Passenger 2026', audience: 'passenger', scale_min: 1, scale_max: 5, questions: [q()] })).toEqual({});
    const bad = validateBank({ name: 'P', audience: 'x', scale_min: 5, scale_max: 5, questions: [q({ text_en: 'ok', applies_ac: false, applies_non_ac: false, psi_weight: '150' })] });
    expect(Object.keys(bad).sort()).toEqual(['audience', 'name', 'q0.applies', 'q0.psi_weight', 'q0.text_en', 'scale_max']);
    expect(validateBank({ name: 'Bank', audience: 'railway', scale_min: 1, scale_max: 5, questions: [] }).questions).toBeDefined();
    expect(validateBank({ name: 'Bank', audience: 'railway', scale_min: 1, scale_max: 5, questions: Array.from({ length: 21 }, () => q()) }).questions).toBeDefined();
    expect(bankPayload({ name: ' Bank ', audience: 'railway', scale_min: 1, scale_max: 5, questions: [q({ text_hi: ' ', psi_weight: '25' })] }, IDS.division)).toEqual({
      division_id: IDS.division, audience: 'railway', name: 'Bank', scale_min: 1, scale_max: 5,
      questions: [{ text_en: 'Toilet cleanliness', text_hi: null, applies_ac: true, applies_non_ac: true, required: true, psi_weight: 25 }],
    });
  });

  it('validates departments, categories and items', () => {
    expect(validateDepartment({ name: 'C' })).toHaveProperty('name');
    expect(validateDepartment({ name: 'C&W' })).toEqual({});
    expect(validateCategory({ name: 'Water', sla_hours: '', sort_order: 0 })).toEqual({});
    expect(validateCategory({ name: 'Water', sla_hours: '2000', sort_order: 'x' })).toEqual({ sla_hours: expect.any(String), sort_order: expect.any(String) });
    expect(validateItem({ name: 'Phenyl', unit: 'ltr', ideal_qty: 5 }, { creating: true })).toEqual({});
    expect(validateItem({ name: 'Phenyl', unit: 'litre', ideal_qty: -1 }, { creating: true })).toEqual({ unit: expect.any(String), ideal_qty: expect.any(String) });
    expect(validateItem({ name: 'Phenyl', unit: 'litre', ideal_qty: 1 }, { creating: false })).toEqual({}); // unit fixed after creation
  });

  it('validates policies and sends exactly the PolicySettings fields', () => {
    const good = { passenger_pnr_required: true, passenger_otp_required: false, pnr_train_day_mapping: false, pnr_coach_match_required: true,
      passenger_feedback_per_coach_day: '', railway_feedback_limit_per_journey: '2', attendance_photo_required: true, attendance_late_grace_days: 1,
      inspection_photo_required: true, complaint_default_sla_hours: 72, stray: 'x' };
    expect(validatePolicy(good)).toEqual({});
    expect(Object.keys(validatePolicy({ ...good, attendance_late_grace_days: 9, complaint_default_sla_hours: '', railway_feedback_limit_per_journey: 1.5 })).sort())
      .toEqual(['attendance_late_grace_days', 'complaint_default_sla_hours', 'railway_feedback_limit_per_journey']);
    const body = policyPayload(good);
    expect(Object.keys(body).sort()).toEqual(POLICY_FIELDS.map((f) => f.key).sort());
    expect(body).toMatchObject({ passenger_feedback_per_coach_day: null, railway_feedback_limit_per_journey: 2 });
  });
});

describe('master-data permissions', () => {
  it('requires the area permission in the record division', () => {
    const admin = me(ADMIN_PERMS);
    const readOnly = me(FIELD_PERMS);
    for (const area of ['questionBanks', 'complaintMasters', 'inventoryItems', 'policies']) {
      expect(canManageMaster(admin, area, IDS.division), area).toBe(true);
      expect(canManageMaster(readOnly, area, IDS.division), area).toBe(false);
      expect(canManageMaster(admin, area, IDS.otherDivision), area).toBe(false);
    }
    const onlyItems = me([...FIELD_PERMS, 'inventory.items.manage']);
    expect(canManageMaster(onlyItems, 'inventoryItems', IDS.division)).toBe(true);
    expect(canManageMaster(onlyItems, 'complaintMasters', IDS.division)).toBe(false);
    expect(canManageMaster(null, 'policies', IDS.division)).toBe(false);
  });

  it('lets only a Super Admin manage the default (all-division) question banks', () => {
    expect(canManageMaster(me(ADMIN_PERMS), 'questionBanks', null)).toBe(false);
    expect(canManageMaster(me(ADMIN_PERMS, [IDS.division], 1), 'questionBanks', null)).toBe(true);
    expect(canManageMaster(me(ADMIN_PERMS, [IDS.division], 1), 'policies', null)).toBe(false);
  });
});

describe('master-data writes (online only) and the local cache', () => {
  it('stores the server-confirmed category, department and item, readable offline afterwards', async () => {
    const { api, session, store } = await setup();
    await api.post('/complaints/categories', { division_id: IDS.division, name: 'Pest control', sort_order: 3 });
    await api.patch(`/complaints/departments/${IDS.department}`, { is_active: false });
    await api.post('/inventory/items', { division_id: IDS.division, name: 'Garbage bags', unit: 'nos', ideal_qty: 50 });
    session.online = false;
    const cats = await api.getWithSource('/complaints/categories', { division_id: IDS.division });
    expect(cats.source).toBe('local');
    expect(cats.data.map((c) => c.name)).toContain('Pest control');
    expect((await api.get('/complaints/departments', { division_id: IDS.division }))[0]).toMatchObject({ id: IDS.department, is_active: false });
    expect((await api.get('/inventory/items', { division_id: IDS.division })).map((i) => [i.name, i.unit])).toContainEqual(['Garbage bags', 'nos']);
    expect((await store.masters.getItem(uid(801))).ideal_qty).toBe(50);
  });

  it('stores a saved policy and serves it offline; PolicySettings drive local capture rules', async () => {
    const { api, session, store } = await setup();
    const before = await api.get(`/divisions/${IDS.division}/policy`).catch(() => null);
    expect(before).toBeNull(); // the fake server has no GET: falls back only when unreachable
    const settings = { ...(await store.masters.getPolicy(IDS.division)), attendance_photo_required: false, complaint_default_sla_hours: 24 };
    await api.put(`/divisions/${IDS.division}/policy`, settings);
    session.online = false;
    expect(await api.getWithSource(`/divisions/${IDS.division}/policy`)).toMatchObject({ source: 'local', data: { attendance_photo_required: false, complaint_default_sla_hours: 24 } });
    // The cached policy is what offline capture validates against.
    await store.capture({ ...attendancePayload({ photo_media_id: null }), actor: actorFor(IDS.supervisor) });
  });

  it('saves a new question bank version and, on activation, retires the previous active bank of that scope', async () => {
    const { api, session, store } = await setup();
    const created = await api.post('/feedback/question-banks', {
      division_id: IDS.division, audience: 'passenger', name: 'Passenger v2', scale_min: 1, scale_max: 10,
      questions: [{ text_en: 'Overall cleanliness', text_hi: null, applies_ac: true, applies_non_ac: true, required: true, psi_weight: null }],
    });
    expect((await store.masters.activeBank(IDS.division, 'passenger')).id).toBe(IDS.passengerBank); // inactive until activated
    await api.post(`/feedback/question-banks/${created.id}/activate`);
    session.online = false;
    const banks = await api.get('/feedback/question-banks', { division_id: IDS.division });
    expect(banks.map((b) => [b.name, b.is_active]).sort()).toEqual([['Passenger v2', true], ['passenger bank', false]]);
    // Division-specific question selection for feedback now uses the new bank; railway is untouched.
    const qs = await api.get('/feedback/questions', { journey_id: IDS.journey, coach_code: 'B1' });
    expect(qs.map((q) => q.text_en)).toEqual(['Overall cleanliness']);
    expect((await store.masters.activeBank(IDS.division, 'railway')).id).toBe(IDS.railwayBank);
  });

  it('refuses writes offline with a clear error and writes nothing locally or to the outbox', async () => {
    const { api, db, remote, session } = await setup({ online: false });
    for (const [method, path, body] of [
      ['post', '/complaints/categories', { division_id: IDS.division, name: 'Pest control' }],
      ['patch', `/complaints/departments/${IDS.department}`, { is_active: false }],
      ['post', '/inventory/items', { division_id: IDS.division, name: 'Bags', unit: 'nos', ideal_qty: 1 }],
      ['put', `/divisions/${IDS.division}/policy`, {}],
      ['post', '/feedback/question-banks', {}],
    ]) {
      await expect(api[method](path, body)).rejects.toMatchObject({ status: 0, code: 'offline_action', message: expect.stringMatching(/needs a connection/) });
    }
    expect(remote.calls).toEqual([]);
    expect(await db.query('SELECT * FROM sync_outbox')).toEqual([]);
    expect((await db.query("SELECT COUNT(*) AS n FROM complaint_categories WHERE name = 'Pest control'"))[0].n).toBe(0);
    session.online = true;
    session.down = true; // "online" but unreachable: same honest failure
    await expect(api.post('/inventory/items', { division_id: IDS.division, name: 'Bags', unit: 'nos', ideal_qty: 1 })).rejects.toMatchObject({ code: 'offline_action' });
  });

  it('shows server validation and permission errors and keeps the cache unchanged', async () => {
    const { api, db, session } = await setup();
    await expect(api.post('/inventory/items', { division_id: IDS.division, name: 'x', unit: 'nos', ideal_qty: 1 })).rejects.toMatchObject({ status: 422, message: 'name: too short' });
    session.me = me(FIELD_PERMS); // read-only user bypassing the hidden buttons
    await expect(api.post('/complaints/categories', { division_id: IDS.division, name: 'Pest control' })).rejects.toMatchObject({ status: 403 });
    expect((await db.query('SELECT COUNT(*) AS n FROM inventory_items'))[0].n).toBe(1);
    expect((await db.query("SELECT COUNT(*) AS n FROM complaint_categories WHERE name = 'Pest control'"))[0].n).toBe(0);
  });

  it('never touches pending operational records or the outbox when master data is refreshed', async () => {
    const { api, db, store } = await setup();
    const capture = attendancePayload();
    await store.capture(capture);
    await api.post('/inventory/items', { division_id: IDS.division, name: 'Garbage bags', unit: 'nos', ideal_qty: 50 });
    await api.put(`/divisions/${IDS.division}/policy`, await store.masters.getPolicy(IDS.division));
    expect(await store.attendance.get(capture.payload.id)).toMatchObject({ sync_status: 'pending' });
    expect(await db.query('SELECT sync_status, owner_user_id FROM sync_outbox')).toEqual([{ sync_status: 'pending', owner_user_id: IDS.supervisor }]);
  });
});

describe('master-data offline reads and division isolation', () => {
  it('serves cached master data offline only within the user divisions', async () => {
    const { store } = await seededStore();
    const scoped = (permissions) => createLocalApi({ store, getContext: () => ({ userId: IDS.outsider, permissions }) });
    const member = scoped({ [IDS.division]: FIELD_PERMS }); // read-only member
    expect((await member.get('/complaints/categories', { division_id: IDS.division })).length).toBe(2);
    expect((await member.get('/complaints/departments', { division_id: IDS.division })).length).toBe(1);
    expect((await member.get('/inventory/items', { division_id: IDS.division })).length).toBe(1);
    expect((await member.get(`/divisions/${IDS.division}/policy`)).passenger_pnr_required).toBe(true);
    expect((await member.get('/feedback/question-banks', { division_id: IDS.division })).map((b) => b.id)).toEqual([IDS.passengerBank]);
    expect((await member.get('/feedback/question-banks')).map((b) => b.id).sort()).toEqual([IDS.globalBank, IDS.railwayBank].sort());

    const outsider = scoped({ [IDS.otherDivision]: ADMIN_PERMS }); // admin elsewhere
    for (const [path, query] of [
      ['/complaints/categories', { division_id: IDS.division }], ['/complaints/departments', { division_id: IDS.division }],
      ['/inventory/items', { division_id: IDS.division }], [`/divisions/${IDS.division}/policy`], ['/feedback/question-banks', { division_id: IDS.division }],
    ]) {
      await expect(outsider.get(path, query), path).rejects.toMatchObject({ status: 403, code: 'division_forbidden' });
    }
  });

  it('keeps stored master data across a reload of the database', async () => {
    const filename = `/masters-${crypto.randomUUID()}.db`;
    const first = await seededStore({ filename });
    await first.store.ingestResponse('POST', '/inventory/items', { id: uid(805), division_id: IDS.division, name: 'Hand towels', unit: 'nos', ideal_qty: 20, is_active: true });
    await first.db.close();
    const store = createLocalStore({ db: await createMemoryDb({ filename }), files: first.files, now: () => NOW, logger: null });
    expect((await store.masters.listItems({ divisionId: IDS.division })).map((i) => i.name)).toEqual(['Hand towels', 'Phenyl']);
  });
});
