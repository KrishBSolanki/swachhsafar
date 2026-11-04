// Offline-first synchronization of operational records with FastAPI.
//
// Push: submit() saves the record locally first (localStore.capture: record + media metadata +
// sync_outbox row in one SQLite transaction), then tries to deliver queued operations through
// POST /sync/batch. Media bytes are read from device storage and uploaded (POST /media + PUT content)
// before their record. Media ids are generated at capture time, so re-running an interrupted upload is
// idempotent server-side. An operation is only marked completed, and its record 'synced', after the
// server explicitly acknowledges it.
//
// Pull: pull() fetches GET /sync/changes since the stored checkpoint and stores master data and
// journeys in SQLite, so screens can read them offline.
import { createOutboxRepository } from '../database/outboxRepository.js';
import { LocalRuleError } from '../database/errors.js';
import { CHANGES_SCOPE, OUTBOX_ENTITY, createLocalStore } from './localStore.js';
import { dataUrlToBytes, sha256Hex } from '../database/mediaStore.js';

export const ENTITY_TYPE = OUTBOX_ENTITY;

export function createOperationsQueue({
  db, store, files, getApi, isOnline = () => true, now = () => new Date().toISOString(), getActor = () => null,
  captureDisabledReason = null,
}) {
  const local = store ?? createLocalStore({ db, files });
  const outbox = createOutboxRepository(db);
  const listeners = new Set();
  // `revision` increases after delivery outcomes or pulled changes are COMMITTED to SQLite; screens re-read
  // their data when it changes (useResource), so they never keep showing a state the database has left.
  let state = { pending: 0, failed: [], othersPending: 0, running: false, lastError: null, pulling: false, lastPullAt: null, pullError: null, revision: 0 };
  // Operations are delivered only for the user who captured them (sync_outbox.owner_user_id).
  // Entries queued before Phase 2 carry no owner and are delivered by whoever is signed in.
  const currentOwner = () => getActor()?.actor?.id ?? null;
  const isMine = (row, owner) => row.owner_user_id == null || (owner != null && row.owner_user_id === owner);
  let inFlight = null;
  let pullInFlight = null;

  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };

  async function refresh() {
    const rows = await db.query(
      `SELECT id, operation, entity_id, sync_status, last_error, retry_count, created_at, owner_user_id FROM sync_outbox
       WHERE entity_type = ? AND sync_status != 'completed' ORDER BY created_at ASC`,
      [ENTITY_TYPE],
    );
    const checkpoint = await local.syncState.getCheckpoint(CHANGES_SCOPE);
    const owner = currentOwner();
    const mine = rows.filter((r) => isMine(r, owner));
    emit({
      pending: mine.filter((r) => r.sync_status !== 'failed').length,
      failed: mine.filter((r) => r.sync_status === 'failed'),
      othersPending: rows.length - mine.length,
      lastPullAt: checkpoint?.last_success_at ?? null,
      pullError: checkpoint?.last_error ?? null,
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

  // Media bytes come from device storage; entries queued before Phase 2 still carry a data URL.
  async function mediaBytes(item) {
    if (item.dataUrl) {
      const { bytes, contentType } = dataUrlToBytes(item.dataUrl);
      return { bytes, contentType, sha256: await sha256Hex(bytes) };
    }
    const stored = await local.media.read(item.id);
    if (!stored?.bytes) throw new LocalRuleError('media_unavailable', `Media ${item.id} is missing from this device.`);
    if (!stored.intact) throw new LocalRuleError('media_corrupt', `Media ${item.id} failed its integrity check.`);
    return { bytes: stored.bytes, contentType: stored.meta.mime_type, sha256: stored.meta.sha256 };
  }

  async function uploadMedia(api, item) {
    const meta = await local.media.getMeta(item.id);
    if (meta?.upload_status === 'uploaded') return;
    const existing = await api.get(`/media/${item.id}`).catch(() => null);
    if (existing?.status !== 'uploaded') {
      const { bytes, contentType, sha256 } = await mediaBytes(item);
      await api.post('/media', {
        id: item.id, division_id: item.division_id, kind: item.kind,
        content_type: contentType, size_bytes: bytes.byteLength, sha256,
      });
      await api.putRaw(`/media/${item.id}/content`, bytes, contentType);
    }
    if (meta) await local.media.markUploaded(item.id, now());
  }

  async function processEntry(api, entry, device) {
    if (!(await outbox.claim(entry.id, now()))) return { status: 'skipped' };
    const { op, media = [] } = JSON.parse(entry.payload);
    // The outbox transition and the record's state are committed together (see localStore.markOutcome).
    const settle = (o, outboxStatement, extra = {}) => local.markOutcome({
      type: entry.operation, entityId: entry.entity_id, outboxId: entry.id, outcome: o, outboxStatement, ...extra,
    });
    const retry = (message) => settle('retry', outbox.retryStatement(entry.id, { error: message, now: now() }), { message });
    const fail = (o, message, extra = {}) => settle(o, outbox.failedStatement(entry.id, { error: message, now: now() }), { message, ...extra });
    try {
      for (const item of media) await uploadMedia(api, item);
      const { results } = await api.post('/sync/batch', { device_id: device, operations: [{ op_id: entry.id, ...op }] });
      const result = results[0];
      if (result.outcome === 'acknowledged') {
        await settle('synced', outbox.completedStatement(entry.id, now()), { serverTimestamp: result.server_timestamp ?? null });
        return { status: 'synced', result };
      }
      const message = result.error?.message ?? `Server returned ${result.outcome}`;
      if (result.outcome === 'retry') {
        await retry(message);
        return { status: 'retry', message };
      }
      await fail(result.outcome === 'conflict' ? 'conflict' : 'rejected', message, { code: result.error?.code ?? null, detail: result.error ?? null });
      return { status: 'failed', message };
    } catch (e) {
      if (e.retryable === false || e instanceof LocalRuleError) {
        await fail('rejected', e.message, { code: e.code ?? null });
        return { status: 'failed', message: e.message };
      }
      await retry(e.message);
      return { status: 'retry', message: e.message };
    }
  }

  async function runOnce() {
    if (!isOnline()) return refresh();
    const owner = currentOwner();
    if (!owner) return refresh();
    const api = await getApi();
    if (!api) return refresh();
    const entries = await outbox.listPending(ENTITY_TYPE, { ownerId: owner });
    if (!entries.length) return refresh();
    emit({ running: true, lastError: null });
    const device = await deviceId();
    const results = {};
    for (const entry of entries) results[entry.id] = await processEntry(api, entry, device);
    const problem = Object.values(results).find((r) => r.status === 'retry' || r.status === 'failed');
    const settled = Object.values(results).some((r) => r.status === 'synced' || r.status === 'failed');
    emit({ running: false, lastError: problem?.message ?? null, ...(settled ? { revision: state.revision + 1 } : {}) });
    await refresh();
    return results;
  }

  function flush() {
    inFlight ??= runOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function pullOnce() {
    if (!isOnline()) return { status: 'offline' };
    const api = await getApi();
    if (!api) return { status: 'unavailable' };
    const checkpoint = await local.syncState.getCheckpoint(CHANGES_SCOPE);
    emit({ pulling: true });
    try {
      const changes = await api.get('/sync/changes', checkpoint?.cursor ? { since: checkpoint.cursor } : undefined);
      const result = await local.ingestChanges(changes);
      emit({ revision: state.revision + 1 });
      return { status: result.ok ? 'pulled' : 'partial', ...result };
    } catch (e) {
      await local.syncState.recordCheckpointError(CHANGES_SCOPE, { error: e.message, now: now() });
      return { status: 'error', message: e.message };
    } finally {
      emit({ pulling: false });
      await refresh();
    }
  }

  return {
    store: local,
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh,
    flush,

    pull() {
      pullInFlight ??= pullOnce().finally(() => {
        pullInFlight = null;
      });
      return pullInFlight;
    },

    // Saves the record locally (atomically with its outbox operation), then tries to deliver it.
    // Outcomes: 'invalid' (a local rule rejected it; nothing saved), 'offline'/'queued'/'retry' (saved on
    // the device, not yet on the server), 'synced' (server acknowledged), 'failed' (server rejected).
    async submit({ type, payload, media = [] }) {
      if (captureDisabledReason) return { status: 'invalid', code: 'capture_disabled', message: captureDisabledReason };
      let saved;
      try {
        saved = await local.capture({ type, payload, media, ...(getActor() ?? {}) });
      } catch (e) {
        if (e instanceof LocalRuleError) return { status: 'invalid', code: e.code, message: e.message };
        throw e;
      }
      await refresh();
      // A run already in progress may have listed the outbox before this row existed: run once more.
      let results = await flush();
      if (!results?.[saved.outboxId]) results = await flush();
      return results?.[saved.outboxId] ?? { status: isOnline() ? 'queued' : 'offline' };
    },

    // Puts server-rejected operations back in the queue, together with their local records.
    async retryFailed() {
      for (const row of state.failed) {
        try {
          await local.reopen(row.operation, row.entity_id);
        } catch {
          continue; // its slot was re-captured meanwhile: the old record stays rejected
        }
        await outbox.resetFailed(row.id, now());
      }
      return flush();
    },
  };
}
