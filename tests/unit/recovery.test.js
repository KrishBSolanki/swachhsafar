// Crash and interruption recovery of the operation outbox.
import { describe, expect, it } from 'vitest';
import { createOperationsQueue } from '../../src/services/operationsQueue.js';
import { recoverAfterStart } from '../../src/database/startupRecovery.js';
import { ApiError } from '../../src/services/apiClient.js';
import { IDS, NOW, actorFor, attendancePayload, inspectionPayload, seededStore } from '../helpers/operationalFixtures.js';

// A server that, like backend sync.process_batch, stores each op_id once and replays it afterwards.
function idempotentServer() {
  const s = {
    committed: new Map(), deliveries: 0, loseNextResponse: false, hang: false,
    async get() { throw new ApiError(404, 'not_found', 'no'); },
    async post(path, body) {
      if (path === '/media') return { ...body, status: 'pending' };
      if (s.hang) return new Promise(() => {}); // the page is closed while waiting
      s.deliveries += 1;
      const results = body.operations.map((o) => {
        const replayed = s.committed.has(o.op_id);
        if (!replayed) s.committed.set(o.op_id, o);
        return { op_id: o.op_id, type: o.type, outcome: 'acknowledged', replayed, server_timestamp: NOW.toISOString() };
      });
      if (s.loseNextResponse) {
        s.loseNextResponse = false;
        throw new ApiError(0, 'network_error', 'timeout'); // committed on the server, response lost
      }
      return { results };
    },
    async putRaw() { return {}; },
  };
  return s;
}

const queueFor = (seeded, api, actorId = IDS.supervisor, online = true) => createOperationsQueue({
  db: seeded.db, store: seeded.store, getApi: async () => api, isOnline: () => online, now: () => NOW.toISOString(),
  getActor: () => ({ actor: actorFor(actorId) }),
});
const outbox = async (db) => db.query('SELECT sync_status FROM sync_outbox');

describe('outbox recovery', () => {
  it('an operation abandoned mid-delivery (page closed) is requeued at startup and delivered', async () => {
    const seeded = await seededStore();
    const api = idempotentServer();
    const c = attendancePayload();
    await queueFor(seeded, api, IDS.supervisor, false).submit(c);
    api.hang = true;
    queueFor(seeded, api).flush(); // never settles: the page is gone
    await new Promise((r) => setTimeout(r, 50));
    expect(await outbox(seeded.db)).toEqual([{ sync_status: 'processing' }]);

    // Next start: without recovery the entry would never be selected again.
    api.hang = false;
    const next = queueFor(seeded, api);
    await next.flush();
    expect(api.deliveries).toBe(0);
    expect((await recoverAfterStart({ db: seeded.db, files: seeded.files, logger: null })).requeued).toBe(1);
    await next.flush();
    expect(await outbox(seeded.db)).toEqual([{ sync_status: 'completed' }]);
    expect((await seeded.store.attendance.get(c.payload.id)).sync_status).toBe('synced');
  });

  it('server committed but the response was lost: retried with the same op_id, stored once, synced once', async () => {
    const seeded = await seededStore();
    const api = idempotentServer();
    const q = queueFor(seeded, api);
    api.loseNextResponse = true;
    const c = inspectionPayload();
    expect((await q.submit(c)).status).toBe('retry');
    expect((await seeded.store.inspections.get(c.payload.id)).sync_status).toBe('pending'); // never synced without an answer
    await q.flush();
    expect(api.deliveries).toBe(2);
    expect(api.committed.size).toBe(1); // one server record
    expect(await outbox(seeded.db)).toEqual([{ sync_status: 'completed' }]);
  });

  it('records of a signed-out user stay pending and owned while another user works; nothing is reassigned', async () => {
    const seeded = await seededStore();
    const api = idempotentServer();
    const c = attendancePayload(); // captured by the supervisor
    await queueFor(seeded, api, IDS.supervisor, false).submit(c);
    const other = queueFor(seeded, api, IDS.janitor1);
    await other.flush();
    expect(api.deliveries).toBe(0);
    expect(other.getState()).toMatchObject({ pending: 0, othersPending: 1 });
    const [row] = await seeded.db.query('SELECT owner_user_id, sync_status FROM sync_outbox');
    expect(row).toEqual({ owner_user_id: IDS.supervisor, sync_status: 'pending' });
    await queueFor(seeded, api, IDS.supervisor).flush();
    expect([...api.committed.values()].map((o) => o.payload.id)).toEqual([c.payload.id]);
  });

  it('startup recovery leaves pending and failed entries alone', async () => {
    const seeded = await seededStore();
    await queueFor(seeded, idempotentServer(), IDS.supervisor, false).submit(attendancePayload());
    await seeded.db.run("UPDATE sync_outbox SET sync_status = 'failed'");
    expect((await recoverAfterStart({ db: seeded.db, files: seeded.files, logger: null })).requeued).toBe(0);
    expect(await outbox(seeded.db)).toEqual([{ sync_status: 'failed' }]);
  });
});
