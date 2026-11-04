// The API client the screens use when demo mode is off. Same interface as apiClient.
//
// GET: when the device is online the FastAPI response is used, stored in SQLite for later offline
// use, and returned with this device's not-yet-synced records added (attendance/inspection cells
// become 'pending', unsynced complaints and feedback are listed). When the device is offline or the
// server is unreachable, the answer comes from SQLite and getWithSource() reports source 'local'.
// Server responses are never replaced by sample data.
//
// Writes (journey management, complaint status changes, PNR/OTP steps) need the server: they are sent
// as-is, and a confirmed response is stored locally. Offline, they fail with a clear message.
// Operational captures do not go through here; they use operationsQueue.submit (local-first).
import { ApiError } from './apiClient.js';

const OFFLINE_WRITE = 'This action needs a connection to the Swachh Safar server. Nothing was changed.';

// sync_meta key of the last response for a GET route with no local table (reports, audit). Scoped to the
// signed-in user, so on a shared device one user's offline snapshot is never shown to another.
export const responseCacheKey = (userId, path, query) =>
  (userId && path ? `cache:${userId}:${path}?${new URLSearchParams(query ?? {}).toString()}` : null);

export function createLocalFirstApi({ remote, local, store, isOnline, getContext = () => ({}), logger = console }) {
  const keep = (p) => p.catch((e) => logger?.warn?.(`[localFirstApi] ${e.message}`));

  // Adds this device's pending records to a server response.
  async function overlay(path, query, data) {
    let m;
    if ((m = path.match(/^\/attendance\/journeys\/([^/]+)\/status$/)) && Array.isArray(data)) {
      return store.attendance.overlayStatus(m[1], data);
    }
    if ((m = path.match(/^\/inspections\/journeys\/([^/]+)\/status$/)) && Array.isArray(data)) {
      const journey = await store.journeys.get(m[1], store.clock().today);
      return journey ? store.inspections.overlayGrid(journey, data) : data;
    }
    // Only the signed-in user's own unsynced records, in their own divisions (shared devices).
    const { userId, permissions = {} } = getContext();
    const list = async (rows, ownerField) => {
      const known = new Set(data.items.map((x) => x.id));
      const extra = rows.filter((r) => r.sync_status === 'pending' && !known.has(r.id) && r[ownerField] === userId && permissions[r.division_id]);
      return extra.length ? { ...data, items: [...extra, ...data.items], total: data.total + extra.length } : data;
    };
    const q = query ?? {};
    if (path === '/complaints' && data?.items && (!q.status || q.status === 'created')) {
      return list(await store.complaints.list({ divisionId: q.division_id || undefined, nowIso: store.clock().now }), 'created_by_id');
    }
    if (path === '/feedback/passenger' && data?.items && (!q.status || q.status === 'draft')) {
      return list(await store.feedback.listPassenger({ divisionId: q.division_id || undefined }), 'collected_by_id');
    }
    // Pending captures have no server verification yet, so they only join unfiltered-by-verification lists.
    const divisions = q.division_id ? [q.division_id] : Object.keys(permissions);
    if (path === '/attendance' && data?.items && !q.verification_status) {
      return list(await store.attendance.listRecords({
        divisions, journeyId: q.journey_id, employeeId: q.employee_id, stage: q.stage == null ? null : Number(q.stage),
      }), 'created_by_id');
    }
    if (path === '/inspections' && data?.items && !q.verification_status) {
      return list(await store.inspections.listRecords({
        divisions, journeyId: q.journey_id, coachCode: q.coach_code, day: q.day == null ? null : Number(q.day), phase: q.phase,
      }), 'created_by_id');
    }
    if (path === '/feedback/railway' && data?.items) {
      return list(await store.feedback.listRailway({ divisions, journeyId: q.journey_id }), 'created_by_id');
    }
    if ((m = path.match(/^\/inventory\/journeys\/([^/]+)\/transactions$/)) && data?.items) {
      return list(await store.inventory.ledger(m[1]), 'created_by_id');
    }
    return data;
  }

  async function getWithSource(path, query) {
    let unreachable = null;
    if (isOnline()) {
      try {
        const data = await remote.get(path, query);
        await keep(store.ingestResponse('GET', path, data));
        return { data: await overlay(path, query, data).catch(() => data), source: 'remote' };
      } catch (e) {
        if (e.status !== 0) throw e;
        unreachable = e;
      }
    }
    try {
      return { data: await local.get(path, query), source: 'local' };
    } catch (e) {
      if (e.code === 'not_available_offline') {
        throw unreachable ?? new ApiError(0, 'offline', 'You are offline and this information is not stored on this device.');
      }
      throw e;
    }
  }

  async function write(method, path, send) {
    if (!isOnline()) throw new ApiError(0, 'offline_action', OFFLINE_WRITE);
    let data;
    try {
      data = await send();
    } catch (e) {
      if (e.status === 0) throw new ApiError(0, 'offline_action', OFFLINE_WRITE, e.detail);
      throw e;
    }
    await keep(store.ingestResponse(method, path, data));
    return data;
  }

  return {
    getWithSource,
    // True when SQLite can answer this GET route offline.
    hasLocal: (path) => local.has(path),
    get: async (path, query) => (await getWithSource(path, query)).data,
    request: (method, path, opts) => (method === 'GET' ? getWithSource(path, opts?.query).then((r) => r.data) : write(method, path, () => remote.request(method, path, opts))),
    post: (path, body, query) => write('POST', path, () => remote.post(path, body, query)),
    patch: (path, body) => write('PATCH', path, () => remote.patch(path, body)),
    put: (path, body) => write('PUT', path, () => remote.put(path, body)),
    del: (path) => write('DELETE', path, () => remote.del(path)),
    putRaw: (path, raw, contentType) => write('PUT', path, () => remote.putRaw(path, raw, contentType)),
    // Server media bytes; nothing is stored locally (device-captured media is read from media storage).
    getBlob: async (path) => {
      if (!isOnline()) throw new ApiError(0, 'offline', 'You are offline and this file is not stored on this device.');
      return remote.getBlob(path);
    },
  };
}
