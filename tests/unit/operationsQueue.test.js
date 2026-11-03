import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createOperationsQueue } from '../../src/services/operationsQueue.js';
import { ApiError, createApiClient } from '../../src/services/apiClient.js';

const PHOTO = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`;

function fakeApi(outcome = 'acknowledged') {
  const calls = [];
  const media = new Map();
  const api = {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      const m = media.get(path.split('/')[2]);
      if (!m) throw new ApiError(404, 'not_found', 'Media not found');
      return m;
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (path === '/media') {
        media.set(body.id, { id: body.id, status: 'pending' });
        return media.get(body.id);
      }
      if (api.down) throw new ApiError(0, 'network_error', 'offline');
      return { results: body.operations.map((o) => ({ op_id: o.op_id, type: o.type, outcome, http_status: 201, error: outcome === 'rejected' ? { message: 'bad stage' } : null })) };
    },
    async putRaw(path) {
      calls.push(['PUT', path]);
      media.get(path.split('/')[2]).status = 'uploaded';
      return {};
    },
  };
  return api;
}

const statuses = async (db) => (await db.query(`SELECT sync_status FROM sync_outbox WHERE entity_type = 'operation'`)).map((r) => r.sync_status);

describe('operationsQueue', () => {
  it('uploads media first, then submits the record and marks it completed only on acknowledgement', async () => {
    const db = await createMemoryDb();
    const api = fakeApi();
    const queue = createOperationsQueue({ db, getApi: async () => api });
    const out = await queue.submit({
      type: 'attendance.create',
      payload: { id: 'rec-1', stage: 1, photo_media_id: 'm-1' },
      media: [{ id: 'm-1', division_id: 'd-1', kind: 'attendance_photo', dataUrl: PHOTO }],
    });
    expect(out.status).toBe('synced');
    const order = api.calls.map((c) => `${c[0]} ${c[1]}`);
    expect(order.indexOf('PUT /media/m-1/content')).toBeLessThan(order.indexOf('POST /sync/batch'));
    const init = api.calls.find((c) => c[1] === '/media')[2];
    expect(init.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(init.content_type).toBe('image/jpeg');
    expect(await statuses(db)).toEqual(['completed']);
  });

  it('keeps records pending while offline and delivers them on flush', async () => {
    const db = await createMemoryDb();
    const api = fakeApi();
    const net = { online: false };
    const queue = createOperationsQueue({ db, getApi: async () => api, isOnline: () => net.online });
    const out = await queue.submit({ type: 'inspection.create', payload: { id: 'rec-2' } });
    expect(out.status).toBe('offline');
    expect(await statuses(db)).toEqual(['pending']);
    expect(queue.getState().pending).toBe(1);
    net.online = true;
    await queue.flush();
    expect(await statuses(db)).toEqual(['completed']);
    expect(queue.getState().pending).toBe(0);
  });

  it('retries on network failure and marks server rejections failed, never synced', async () => {
    const db = await createMemoryDb();
    const api = fakeApi();
    api.down = true;
    const queue = createOperationsQueue({ db, getApi: async () => api });
    expect((await queue.submit({ type: 'attendance.create', payload: { id: 'rec-3' } })).status).toBe('retry');
    expect(await statuses(db)).toEqual(['pending']);

    const rejecting = createOperationsQueue({ db: await createMemoryDb(), getApi: async () => fakeApi('rejected') });
    const out = await rejecting.submit({ type: 'attendance.create', payload: { id: 'rec-4' } });
    expect(out).toEqual({ status: 'failed', message: 'bad stage' });
    expect(rejecting.getState().failed).toHaveLength(1);
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
