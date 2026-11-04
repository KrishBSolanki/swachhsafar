// The screens' API boundary with demo mode off: server first when reachable, SQLite otherwise.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/services/apiClient.js';
import { createLocalApi } from '../../src/services/localApi.js';
import { createLocalFirstApi } from '../../src/services/localFirstApi.js';
import { FIELD_PERMS, IDS, actorFor, attendancePayload, inspectionPayload, journeyOut, seededStore, uid } from '../helpers/operationalFixtures.js';

function fakeRemote(routes = {}) {
  const calls = [];
  const remote = {
    calls,
    down: false,
    async get(path, query) {
      calls.push(['GET', path, query]);
      if (remote.down) throw new ApiError(0, 'network_error', 'Cannot reach the Swachh Safar server.');
      const fn = routes[path];
      if (!fn) throw new ApiError(404, 'endpoint_unavailable', 'nope');
      return typeof fn === 'function' ? fn(query) : structuredClone(fn);
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (remote.down) throw new ApiError(0, 'network_error', 'Cannot reach the Swachh Safar server.');
      const fn = routes[`POST ${path}`];
      return typeof fn === 'function' ? fn(body) : structuredClone(fn);
    },
  };
  return remote;
}

async function setup({ routes, online = { value: true } } = {}) {
  const seeded = await seededStore();
  const remote = fakeRemote(routes);
  const ctx = { userId: IDS.janitor1, permissions: { [IDS.division]: FIELD_PERMS } };
  const local = createLocalApi({ store: seeded.store, getContext: () => ctx });
  const api = createLocalFirstApi({ remote, local, store: seeded.store, isOnline: () => online.value, getContext: () => ctx, logger: null });
  return { ...seeded, remote, api, online, ctx };
}

describe('local-first API (offline reads)', () => {
  it('serves journeys from SQLite with state and "mine" filters, flagged as local', async () => {
    const { api, remote } = await setup({ online: { value: false } });
    const res = await api.getWithSource('/journeys', { state: 'active', mine: true, page_size: 100 });
    expect(res.source).toBe('local');
    expect(res.data).toMatchObject({ total: 1, items: [expect.objectContaining({ id: IDS.journey, state: 'active', train_no: '12951' })] });
    expect((await api.get('/journeys', { state: 'scheduled' })).items.map((j) => j.id)).toEqual([IDS.futureJourney]);
    expect(remote.calls).toEqual([]); // offline: no network attempt
  });

  it('serves journey detail, summary, attendance status and inspection grid', async () => {
    const { api, store } = await setup({ online: { value: false } });
    await store.capture(attendancePayload());
    await store.capture(inspectionPayload());
    expect(await api.get(`/journeys/${IDS.journey}`)).toMatchObject({ id: IDS.journey, coaches: [{ code: 'B1' }, { code: 'S1' }] });
    expect(await api.get(`/journeys/${IDS.journey}/summary`)).toMatchObject({ staff_allocated: 2, attendance_records: 1, inspections_done: 1 });
    const status = await api.get(`/attendance/journeys/${IDS.journey}/status`);
    expect(status.find((r) => r.employee_id === IDS.janitor1).stages.map((s) => s.status)).toEqual(['pending', 'next', 'locked', 'locked', 'locked']);
    const grid = await api.get(`/inspections/journeys/${IDS.journey}/status`);
    expect(grid.find((c) => c.coach_code === 'B1' && c.day === 1).cells[0]).toMatchObject({ round: 1, phase: 'B', status: 'pending' });
    await expect(api.get(`/journeys/${uid(999)}`)).rejects.toMatchObject({ status: 404 });
  });

  it('selects feedback questions for the journey division and coach class', async () => {
    const { api } = await setup({ online: { value: false } });
    expect((await api.get('/feedback/questions', { journey_id: IDS.journey, coach_code: 'S1' })).map((q) => q.id)).toEqual([IDS.q1, IDS.q3]);
    expect((await api.get('/feedback/questions', { journey_id: IDS.journey, audience: 'railway' })).map((q) => q.id)).toEqual([IDS.r1, IDS.r2]);
    expect((await api.get('/feedback/question-banks', { division_id: IDS.division })).map((b) => b.id)).toEqual([IDS.passengerBank]);
    expect((await api.get('/complaints/categories', { division_id: IDS.division })).length).toBe(2);
    expect(await api.get(`/dashboard/divisions/${IDS.division}`)).toMatchObject({ journeys_active: 1 });
  });

  it('reports routes without local data as unreachable so cached responses can be shown', async () => {
    const { api } = await setup({ online: { value: false } });
    await expect(api.get('/audit')).rejects.toMatchObject({ status: 0, code: 'offline' });
    // Reports are calculated from device records offline (tests/unit/localReports.test.js).
    expect(api.hasLocal('/reports/attendance')).toBe(true);
  });

  it('falls back to SQLite when the server is unreachable while "online"', async () => {
    const { api, remote } = await setup();
    remote.down = true;
    const res = await api.getWithSource('/journeys', { state: 'active' });
    expect(res).toMatchObject({ source: 'local', data: { total: 1 } });
    expect(remote.calls).toHaveLength(1);
  });
});

describe('local-first API (online)', () => {
  it('returns server data unchanged in substance, stores it, and serves it offline later', async () => {
    const fresh = journeyOut(uid(25), '2026-11-04', '2026-11-04', { train_no: '22439', train_name: 'Vande Bharat', state: 'active' });
    const online = { value: true };
    const { api } = await setup({ routes: { [`/journeys/${uid(25)}`]: fresh }, online });
    const res = await api.getWithSource(`/journeys/${uid(25)}`);
    expect(res.source).toBe('remote');
    expect(res.data).toEqual(fresh);
    online.value = false;
    expect(await api.getWithSource(`/journeys/${uid(25)}`)).toMatchObject({ source: 'local', data: { train_no: '22439', staff: [{}, {}] } });
  });

  it('never replaces a server error with local data', async () => {
    const { api } = await setup({ routes: {} });
    await expect(api.get('/journeys', { state: 'active' })).rejects.toMatchObject({ status: 404, code: 'endpoint_unavailable' });
  });

  it('adds unsynced records to server lists and status grids', async () => {
    const serverStatus = [{ employee_id: IDS.janitor1, name: 'Sunita Devi', emp_id: 'EMP1', role_id: 5, completed: false,
      stages: [1, 2, 3, 4, 5].map((stage) => ({ stage, status: stage === 1 ? 'next' : 'locked', attendance_id: null })) }];
    const { api, store } = await setup({ routes: {
      [`/attendance/journeys/${IDS.journey}/status`]: serverStatus,
      '/complaints': { items: [], total: 0, page: 1, page_size: 100 },
    } });
    await store.capture(attendancePayload());
    const media = crypto.randomUUID();
    await store.capture({
      type: 'complaint.create',
      payload: { id: crypto.randomUUID(), division_id: IDS.division, category_id: IDS.category, description: 'Water not available', device_timestamp: '2026-11-04T11:00:00+05:30', attachment_ids: [media] },
      media: [{ id: media, kind: 'complaint_attachment', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }],
      actor: actorFor(IDS.janitor1),
    });
    const status = await api.getWithSource(`/attendance/journeys/${IDS.journey}/status`);
    expect(status.source).toBe('remote');
    expect(status.data[0].stages.map((s) => s.status)).toEqual(['pending', 'next', 'locked', 'locked', 'locked']);
    const list = await api.get('/complaints', { division_id: IDS.division });
    expect(list).toMatchObject({ total: 1, items: [expect.objectContaining({ complaint_no: null, sync_status: 'pending' })] });
  });

  it('sends writes to the server and stores the confirmed result; refuses them offline', async () => {
    const online = { value: true };
    const updated = journeyOut(IDS.journey, '2026-11-04', '2026-11-05', { state: 'cancelled', cancel_reason: 'Rake change', version: 2 });
    const { api, store } = await setup({ routes: { [`POST /journeys/${IDS.journey}/cancel`]: updated }, online });
    await api.post(`/journeys/${IDS.journey}/cancel`, { version: 1, reason: 'Rake change' });
    expect(await store.journeys.get(IDS.journey, '2026-11-04')).toMatchObject({ state: 'cancelled', version: 2 });
    online.value = false;
    await expect(api.post(`/journeys/${IDS.journey}/cancel`, {})).rejects.toMatchObject({ status: 0, code: 'offline_action' });
  });
});
