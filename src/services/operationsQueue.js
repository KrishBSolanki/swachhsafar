// Offline-first queue for operational records (attendance, inspections, feedback, complaints).
//
// Every capture is written to the SQLite `sync_outbox` first (entity_type 'operation', the record's
// device-generated UUID as entity_id), then pushed through POST /sync/batch. Media evidence is held
// in the outbox payload as a data URL and uploaded (POST /media + PUT content) before its record.
// Media ids are generated at capture time, so re-running an interrupted upload is idempotent server-side.
// A row is only marked completed after the server acknowledges it.
import { createOutboxRepository } from '../database/outboxRepository.js';

export const ENTITY_TYPE = 'operation';

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function dataUrlToBytes(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const contentType = head.match(/^data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType };
}

export function createOperationsQueue({ db, getApi, isOnline = () => true, now = () => new Date().toISOString() }) {
  const outbox = createOutboxRepository(db);
  const listeners = new Set();
  let state = { pending: 0, failed: [], running: false, lastError: null };
  let inFlight = null;

  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };

  async function refresh() {
    const rows = await db.query(
      `SELECT id, operation, entity_id, sync_status, last_error, retry_count, created_at FROM sync_outbox
       WHERE entity_type = ? AND sync_status != 'completed' ORDER BY created_at ASC`,
      [ENTITY_TYPE],
    );
    emit({
      pending: rows.filter((r) => r.sync_status !== 'failed').length,
      failed: rows.filter((r) => r.sync_status === 'failed'),
    });
    return state;
  }

  async function deviceId() {
    let id = await outbox.getMeta('device_id');
    if (!id) {
      id = `pwa-${crypto.randomUUID()}`;
      await outbox.setMeta('device_id', id, now());
    }
    return id;
  }

  async function uploadMedia(api, item) {
    const { bytes, contentType } = dataUrlToBytes(item.dataUrl);
    const existing = await api.get(`/media/${item.id}`).catch(() => null);
    if (existing?.status === 'uploaded') return;
    await api.post('/media', {
      id: item.id, division_id: item.division_id, kind: item.kind,
      content_type: contentType, size_bytes: bytes.byteLength, sha256: await sha256Hex(bytes),
    });
    await api.putRaw(`/media/${item.id}/content`, bytes, contentType);
  }

  async function processEntry(api, entry, device) {
    if (!(await outbox.claim(entry.id, now()))) return { status: 'skipped' };
    const { op, media = [] } = JSON.parse(entry.payload);
    try {
      for (const item of media) await uploadMedia(api, item);
      const { results } = await api.post('/sync/batch', { device_id: device, operations: [{ op_id: entry.id, ...op }] });
      const result = results[0];
      if (result.outcome === 'acknowledged') {
        await outbox.markCompleted(entry.id, now());
        return { status: 'synced', result };
      }
      const message = result.error?.message ?? `Server returned ${result.outcome}`;
      if (result.outcome === 'retry') {
        await outbox.markRetry(entry.id, { error: message, now: now() });
        return { status: 'retry', message };
      }
      await outbox.markFailed(entry.id, { error: message, now: now() });
      return { status: 'failed', message };
    } catch (e) {
      if (e.retryable === false) {
        await outbox.markFailed(entry.id, { error: e.message, now: now() });
        return { status: 'failed', message: e.message };
      }
      await outbox.markRetry(entry.id, { error: e.message, now: now() });
      return { status: 'retry', message: e.message };
    }
  }

  async function runOnce() {
    if (!isOnline()) return refresh();
    const api = await getApi();
    if (!api) return refresh();
    const entries = await outbox.listPending(ENTITY_TYPE);
    if (!entries.length) return refresh();
    emit({ running: true, lastError: null });
    const device = await deviceId();
    const results = {};
    for (const entry of entries) results[entry.id] = await processEntry(api, entry, device);
    const problem = Object.values(results).find((r) => r.status === 'retry' || r.status === 'failed');
    emit({ running: false, lastError: problem?.message ?? null });
    await refresh();
    return results;
  }

  function flush() {
    inFlight ??= runOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh,
    flush,

    // Saves the operation locally, then tries to deliver it. Returns 'synced' only after the server acknowledged.
    async submit({ type, payload, media = [] }) {
      const entryId = crypto.randomUUID();
      const statement = outbox.insertStatement({
        id: entryId, entity_type: ENTITY_TYPE, entity_id: payload.id, operation: type,
        payload: { op: { type, payload }, media }, created_at: now(),
      });
      await db.run(statement.sql, statement.params);
      await refresh();
      // A run already in progress may have listed the outbox before this row existed: run once more.
      let results = await flush();
      if (!results?.[entryId]) results = await flush();
      return results?.[entryId] ?? { status: isOnline() ? 'queued' : 'offline' };
    },

    async retryFailed() {
      for (const row of state.failed) await outbox.resetFailed(row.id, now());
      return flush();
    },
  };
}
