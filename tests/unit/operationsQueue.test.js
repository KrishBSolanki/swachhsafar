import { describe, expect, it } from 'vitest';
import { createOperationsQueue } from '../../src/services/operationsQueue.js';
import { ApiError, createApiClient } from '../../src/services/apiClient.js';
import { IDS, NOW, PHOTO, actorFor, attendancePayload, changesFixture, inspectionPayload, seededStore } from '../helpers/operationalFixtures.js';

function fakeApi(outcome = 'acknowledged') {
  const calls = [];
  const media = new Map();
  const api = {
    calls,
    async get(path, query) {
      calls.push(['GET', path, query]);
      if (path === '/sync/changes') return api.changes ?? { cursor: '2026-11-04T06:00:00Z', full: false, journeys: [] };
      const m = media.get(path.split('/')[2]);
      if (!m) throw new ApiError(404, 'not_found', 'Media not found');
      return m;
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (path === '/media') {
        media.set(body.id, { id: body.id, status: 'pending', ...body });
        return media.get(body.id);
      }
      if (api.down) throw new ApiError(0, 'network_error', 'offline');
      return {
        results: body.operations.map((o) => ({
          op_id: o.op_id, type: o.type, outcome, http_status: 201, server_timestamp: '2026-11-04T06:00:05Z',
          error: outcome === 'rejected' ? { code: 'stage_order', message: 'bad stage' } : outcome === 'conflict' ? { code: 'duplicate_attendance', message: 'already recorded' } : null,
        })),
      };
    },
    async putRaw(path, bytes) {
      calls.push(['PUT', path, bytes]);
      media.get(path.split('/')[2]).status = 'uploaded';
      return {};
    },
  };
  return api;
}

const statuses = async (db) => (await db.query(`SELECT sync_status FROM sync_outbox WHERE entity_type = 'operation'`)).map((r) => r.sync_status);
const recordStatus = async (db, table, id) => (await db.query(`SELECT sync_status FROM ${table} WHERE id = ?`, [id]))[0]?.sync_status;

async function setup({ api = fakeApi(), online = () => true } = {}) {
  const seeded = await seededStore();
  const queue = createOperationsQueue({
    db: seeded.db, store: seeded.store, getApi: async () => api, isOnline: online, now: () => NOW.toISOString(),
    getActor: () => ({ actor: actorFor(IDS.supervisor) }),
  });
  return { ...seeded, api, queue };
}

describe('operationsQueue', () => {
  it('uploads media from device storage first, then submits the record and marks it synced only on acknowledgement', async () => {
    const { db, api, queue } = await setup();
    const capture = attendancePayload();
    const out = await queue.submit(capture);
    expect(out.status).toBe('synced');
    const order = api.calls.map((c) => `${c[0]} ${c[1]}`);
    const mediaId = capture.payload.photo_media_id;
    expect(order.indexOf(`PUT /media/${mediaId}/content`)).toBeLessThan(order.indexOf('POST /sync/batch'));
    const init = api.calls.find((c) => c[1] === '/media')[2];
    expect(init.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(init.content_type).toBe('image/jpeg');
    expect(init.division_id).toBe(IDS.division);
    const uploaded = api.calls.find((c) => c[0] === 'PUT')[2];
    expect(Buffer.from(uploaded).toString()).toBe('fake-jpeg-bytes-for-tests');
    expect(await statuses(db)).toEqual(['completed']);
    expect(await recordStatus(db, 'attendance_records', capture.payload.id)).toBe('synced');
    expect((await db.query('SELECT upload_status FROM media_files WHERE id = ?', [mediaId]))[0].upload_status).toBe('uploaded');
    // The outbox holds a media reference, never the bytes.
    const [{ payload }] = await db.query('SELECT payload FROM sync_outbox');
    expect(payload).not.toContain('base64');
  });

  it('keeps records pending while offline and delivers them on flush', async () => {
    const net = { online: false };
    const { db, queue } = await setup({ online: () => net.online });
    const capture = inspectionPayload();
    const out = await queue.submit(capture);
    expect(out.status).toBe('offline');
    expect(await statuses(db)).toEqual(['pending']);
    expect(await recordStatus(db, 'inspection_records', capture.payload.id)).toBe('pending');
    expect(queue.getState().pending).toBe(1);
    net.online = true;
    await queue.flush();
    expect(await statuses(db)).toEqual(['completed']);
    expect(await recordStatus(db, 'inspection_records', capture.payload.id)).toBe('synced');
    expect(queue.getState().pending).toBe(0);
  });

  it('retries on network failure and marks server rejections failed, never synced', async () => {
    const api = fakeApi();
    api.down = true;
    const { db, queue } = await setup({ api });
    const capture = attendancePayload();
    expect((await queue.submit(capture)).status).toBe('retry');
    expect(await statuses(db)).toEqual(['pending']);
    expect(await recordStatus(db, 'attendance_records', capture.payload.id)).toBe('pending');

    const rejecting = await setup({ api: fakeApi('rejected') });
    const rejected = attendancePayload();
    const out = await rejecting.queue.submit(rejected);
    expect(out).toEqual({ status: 'failed', message: 'bad stage' });
    expect(rejecting.queue.getState().failed).toHaveLength(1);
    expect(await recordStatus(rejecting.db, 'attendance_records', rejected.payload.id)).toBe('rejected');
    const [conflict] = await rejecting.store.syncState.listConflicts();
    expect(conflict).toMatchObject({ entity_id: rejected.payload.id, outcome: 'rejected', code: 'stage_order' });
  });

  it('records a server conflict and frees the slot for the server copy', async () => {
    const { db, store, queue } = await setup({ api: fakeApi('conflict') });
    const capture = attendancePayload();
    expect((await queue.submit(capture)).status).toBe('failed');
    expect(await recordStatus(db, 'attendance_records', capture.payload.id)).toBe('conflict');
    expect((await store.syncState.listConflicts())[0]).toMatchObject({ outcome: 'conflict', code: 'duplicate_attendance' });
    // The stage is free again locally, e.g. for the record another device made.
    expect((await store.attendance.journeyStatus(IDS.journey)).find((r) => r.employee_id === IDS.janitor1).stages[0].status).toBe('next');
  });

  it('refuses invalid records without writing anything', async () => {
    const { db, queue } = await setup();
    const out = await queue.submit(attendancePayload({ stage: 3 }));
    expect(out).toMatchObject({ status: 'invalid', code: 'stage_order' });
    expect(await statuses(db)).toEqual([]);
    expect(await db.query('SELECT * FROM attendance_records')).toEqual([]);
    expect(await db.query('SELECT * FROM media_files')).toEqual([]);
  });

  it('can be put in a mode where captures are refused (demo mode)', async () => {
    const seeded = await seededStore();
    const queue = createOperationsQueue({ db: seeded.db, store: seeded.store, getApi: async () => null, captureDisabledReason: 'Demo mode', getActor: () => ({ actor: actorFor(IDS.supervisor) }) });
    expect(await queue.submit(attendancePayload())).toEqual({ status: 'invalid', code: 'capture_disabled', message: 'Demo mode' });
    expect(await seeded.db.query('SELECT * FROM sync_outbox')).toEqual([]);
  });

  it('still delivers outbox entries queued before Phase 2 (media as data URL, no local record)', async () => {
    const { db, api, queue } = await setup();
    await db.run(
      `INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, retry_count, sync_status, created_at, updated_at)
       VALUES ('legacy-1', 'operation', 'rec-legacy', 'attendance.create', ?, 0, 'pending', 't', 't')`,
      [JSON.stringify({ op: { type: 'attendance.create', payload: { id: 'rec-legacy' } }, media: [{ id: 'm-legacy', division_id: 'd', kind: 'attendance_photo', dataUrl: PHOTO }] })],
    );
    await queue.flush();
    expect(api.calls.some((c) => c[1] === '/media/m-legacy/content')).toBe(true);
    expect(await statuses(db)).toEqual(['completed']);
  });

  it('retryFailed reopens rejected records unless their slot was re-captured', async () => {
    const api = fakeApi('rejected');
    const { db, queue } = await setup({ api });
    const first = attendancePayload();
    await queue.submit(first);
    expect(await recordStatus(db, 'attendance_records', first.payload.id)).toBe('rejected');
    api.down = true; // the retry should stay queued
    await queue.retryFailed();
    expect(await recordStatus(db, 'attendance_records', first.payload.id)).toBe('pending');
    expect(await statuses(db)).toEqual(['pending']);
  });

  it('pulls /sync/changes into SQLite and advances the checkpoint', async () => {
    const api = fakeApi();
    const { store, queue } = await setup({ api });
    const changes = changesFixture();
    changes.cursor = '2026-11-04T06:10:00Z';
    changes.divisions[0].name = 'Delhi Division (renamed)';
    api.changes = changes;
    expect((await queue.pull()).status).toBe('pulled');
    expect((await store.masters.listDivisions()).find((d) => d.id === IDS.division).name).toBe('Delhi Division (renamed)');
    expect((await store.syncState.getCheckpoint('changes')).cursor).toBe('2026-11-04T06:10:00Z');
    await queue.pull();
    expect(api.calls.filter((c) => c[1] === '/sync/changes').at(-1)[2]).toEqual({ since: '2026-11-04T06:10:00Z' });
  });

  it('does not pull while offline', async () => {
    const api = fakeApi();
    const { queue } = await setup({ api, online: () => false });
    expect((await queue.pull()).status).toBe('offline');
    expect(api.calls).toEqual([]);
  });
});

describe('apiClient', () => {
  it('attaches the Firebase ID token and surfaces backend error codes', async () => {
    const seen = [];
    const api = createApiClient({
      getToken: async () => 'tok-123',
      base: 'http://api.test/api/v1',
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ error: { code: 'division_forbidden', message: 'Outside your divisions' } }), { status: 403 });
      },
    });
    await expect(api.get('/journeys', { state: 'active', empty: '' })).rejects.toMatchObject({ status: 403, code: 'division_forbidden', retryable: false });
    expect(seen[0].init.headers.Authorization).toBe('Bearer tok-123');
    expect(seen[0].url).toBe('http://api.test/api/v1/journeys?state=active');
  });

  it('reports network failures as retryable', async () => {
    const api = createApiClient({ getToken: async () => null, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 0, retryable: true });
  });
});

// Regression: the inspection grid intermittently showed a synced record as "pending" after reconnecting.
// Root cause: on acknowledgement the outbox row was completed and the record marked synced in two separate
// writes. A reader in between (the parallel pull's refresh) saw "All records synced" while the record was
// still pending; a reload/crash in that window stranded it as pending forever with a completed outbox row.
describe('acknowledgement is atomic (outbox state and record state)', () => {
  // A database whose writes are observed (and can be made to fail) at write granularity.
  async function instrumented() {
    const { createLocalStore } = await import('../../src/services/localStore.js');
    const seeded = await seededStore();
    const base = seeded.db;
    const hooks = { afterWrite: null, failWrite: null, writes: 0 };
    const write = (fn) => async (...args) => {
      hooks.writes += 1;
      if (hooks.failWrite?.(hooks.writes)) throw new Error('page closed (simulated)');
      const r = await fn(...args);
      await hooks.afterWrite?.();
      return r;
    };
    const db = { ...base, run: write(base.run.bind(base)), transaction: write(base.transaction.bind(base)), query: base.query.bind(base) };
    const store = createLocalStore({ db, files: seeded.files, now: () => NOW, logger: null });
    return { db, base, store, hooks };
  }
  const invariantBroken = async (db) => (await db.query(
    `SELECT o.id FROM sync_outbox o JOIN inspection_records r ON r.id = o.entity_id
     WHERE o.sync_status = 'completed' AND r.sync_status != 'synced'`,
  )).length > 0;

  it('no reader ever observes a completed outbox entry whose record is not yet synced', async () => {
    const { db, base, store, hooks } = await instrumented();
    const api = fakeApi();
    const queue = createOperationsQueue({ db, store, getApi: async () => api, isOnline: () => false, now: () => NOW.toISOString(), getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
    await queue.submit(inspectionPayload());
    const seen = [];
    hooks.afterWrite = async () => { seen.push(await invariantBroken(base)); };
    const online = createOperationsQueue({ db, store, getApi: async () => api, isOnline: () => true, now: () => NOW.toISOString(), getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
    await online.flush();
    expect(await statuses(base)).toEqual(['completed']);
    expect(seen.includes(true)).toBe(false);
  });

  it('a crash right after the server acknowledged leaves the operation re-deliverable, never stranded', async () => {
    const { db, base, store, hooks } = await instrumented();
    const api = fakeApi();
    const mk = (online) => createOperationsQueue({ db, store, getApi: async () => api, isOnline: () => online, now: () => NOW.toISOString(), getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
    const capture = inspectionPayload();
    await mk(false).submit(capture);
    // The page is closed right after the FIRST write that follows the /sync/batch acknowledgement.
    let ackedAt = null;
    const post = api.post;
    api.post = async (path, body) => { const r = await post(path, body); if (path === '/sync/batch') ackedAt = hooks.writes; return r; };
    hooks.failWrite = (n) => ackedAt != null && n > ackedAt + 1;
    await mk(true).flush().catch(() => {});
    expect(await invariantBroken(base)).toBe(false);
    // "Restart": abandoned 'processing' entries return to the queue and are delivered again (the server replays).
    hooks.failWrite = null;
    const { createOutboxRepository } = await import('../../src/database/outboxRepository.js');
    await createOutboxRepository(base).recoverInterrupted(NOW.toISOString());
    await mk(true).flush();
    expect(await statuses(base)).toEqual(['completed']);
    expect(await recordStatus(base, 'inspection_records', capture.payload.id)).toBe('synced');
  });

  it('publishes a revision only after outcomes are committed, so screens re-read committed data', async () => {
    const { queue } = await setup({ online: () => true });
    const before = queue.getState().revision;
    await queue.submit(inspectionPayload({}));
    expect(queue.getState().revision).toBeGreaterThan(before);
  });
});
