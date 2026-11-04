// Media evidence integrity: device-side acceptance rules (same as the server), storage exhaustion, the
// voice recording lifecycle, and the upload lifecycle under failures (retry, duplicates, missing or
// corrupt files, restart).
import { describe, expect, it } from 'vitest';
import { MEDIA_RULES, sha256Hex, validateMedia } from '../../src/database/mediaStore.js';
import { createOperationsQueue } from '../../src/services/operationsQueue.js';
import { createLocalStore } from '../../src/services/localStore.js';
import { ApiError } from '../../src/services/apiClient.js';
import { VoiceError, startVoiceRecording, voiceFormat } from '../../src/utils/voiceRecording.js';
import { createMemoryFiles } from '../helpers/memoryFiles.js';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { IDS, NOW, actorFor, inspectionPayload, seededStore } from '../helpers/operationalFixtures.js';

const VIDEO = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);

describe('media acceptance rules (device = server)', () => {
  it('mirrors the backend content types and size limits, capped at 25 MB on the device', () => {
    expect(validateMedia({ kind: 'inspection_video', mimeType: 'video/mp4', size: 10 })).toBe('video/mp4');
    expect(validateMedia({ kind: 'feedback_voice', mimeType: 'audio/webm;codecs=opus'.replace('audio', 'video'), size: 10 })).toBe('video/webm');
    expect(() => validateMedia({ kind: 'inspection_video', mimeType: 'video/x-msvideo', size: 10 })).toThrow(expect.objectContaining({ code: 'media_type_rejected' }));
    expect(() => validateMedia({ kind: 'feedback_voice', mimeType: 'audio/webm', size: 10 })).toThrow(expect.objectContaining({ code: 'media_type_rejected' })); // server refuses audio/webm
    expect(() => validateMedia({ kind: 'attendance_photo', mimeType: 'image/jpeg', size: 8 * 1024 * 1024 + 1 })).toThrow(expect.objectContaining({ code: 'media_too_large' }));
    expect(() => validateMedia({ kind: 'attendance_photo', mimeType: 'image/jpeg', size: 0 })).toThrow(expect.objectContaining({ code: 'media_empty' }));
    expect(MEDIA_RULES.inspection_video.maxBytes).toBe(25 * 1024 * 1024);
  });

  it('refuses an unsupported or oversized capture before anything is written', async () => {
    const { store, db, files } = await seededStore();
    const c = inspectionPayload();
    c.media[0] = { id: c.media[0].id, kind: 'inspection_photo', bytes: VIDEO, mimeType: 'video/mp4' };
    await expect(store.capture(c)).rejects.toMatchObject({ code: 'media_type_rejected' });
    expect(await db.query('SELECT id FROM inspection_records')).toEqual([]);
    expect(await db.query('SELECT id FROM sync_outbox')).toEqual([]);
    expect(await files.list()).toEqual([]);
  });

  it('device storage full: a clear refusal, no partial file, no record, existing data intact', async () => {
    const { store, db, files } = await seededStore();
    await store.capture(inspectionPayload()); // existing evidence
    const before = { files: (await files.list()).sort(), rows: await db.query('SELECT id, sync_status FROM inspection_records') };
    const write = files.write;
    files.write = async (name, bytes) => {
      await write(name, bytes.subarray(0, 3)); // partial write, then the quota error
      throw Object.assign(new Error('The operation failed because quota was exceeded.'), { name: 'QuotaExceededError' });
    };
    await expect(store.capture(inspectionPayload({ coach_code: 'S1' }))).rejects.toMatchObject({ code: 'storage_full' });
    files.write = write;
    expect((await files.list()).sort()).toEqual(before.files);
    expect(await db.query('SELECT id, sync_status FROM inspection_records')).toEqual(before.rows);
    const [meta] = await db.query('SELECT id FROM media_files');
    expect((await store.media.read(meta.id)).intact).toBe(true);
  });

  it('a SQLite "disk is full" failure is reported as storage_full and removes the staged file', async () => {
    const { store, db, files } = await seededStore();
    const tx = db.transaction.bind(db);
    db.transaction = async () => { throw Object.assign(new Error('database or disk is full'), { code: 13 }); };
    await expect(store.capture(inspectionPayload())).rejects.toMatchObject({ code: 'storage_full' });
    db.transaction = tx;
    expect(await files.list()).toEqual([]);
  });
});

// A MediaRecorder / getUserMedia pair driven by the test.
function fakeMedia({ supported = ['audio/webm;codecs=opus'], deny = null } = {}) {
  const track = { listeners: {}, stopped: false, stop() { this.stopped = true; }, addEventListener(t, f) { this.listeners[t] = f; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let current;
  class Recorder {
    static isTypeSupported(t) { return supported.includes(t); }
    constructor(s, opts) { this.opts = opts; this.state = 'inactive'; current = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
    emit(bytes) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
  }
  const timers = [];
  return {
    track,
    recorder: () => current,
    tick: () => timers.forEach((f) => f()),
    opts: {
      Recorder,
      mediaDevices: { getUserMedia: async () => { if (deny) throw Object.assign(new Error('denied'), { name: deny }); return stream; } },
      setInterval: (f) => { timers.push(f); return timers.length; },
      clearInterval: () => {},
    },
  };
}

describe('voice recording lifecycle', () => {
  it('records, stops and returns the bytes with the server-accepted content type', async () => {
    const m = fakeMedia();
    const rec = await startVoiceRecording(m.opts);
    expect(m.recorder().opts.mimeType).toBe('audio/webm;codecs=opus');
    m.recorder().emit([1, 2, 3]);
    rec.stop();
    const out = await rec.done;
    expect(out).toMatchObject({ mimeType: 'video/webm', interrupted: false });
    expect(out.blob.size).toBe(3);
    expect(m.track.stopped).toBe(true); // microphone released
  });

  it('permission denied, no microphone and unsupported browsers fail clearly', async () => {
    await expect(startVoiceRecording(fakeMedia({ deny: 'NotAllowedError' }).opts)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(startVoiceRecording(fakeMedia({ deny: 'NotFoundError' }).opts)).rejects.toMatchObject({ code: 'no_microphone' });
    await expect(startVoiceRecording(fakeMedia({ supported: [] }).opts)).rejects.toBeInstanceOf(VoiceError);
    expect(voiceFormat(() => false)).toBeNull();
    expect(voiceFormat((t) => t === 'audio/mp4')).toEqual(['audio/mp4', 'audio/mp4']);
  });

  it('an empty recording is not a recording', async () => {
    const m = fakeMedia();
    const rec = await startVoiceRecording(m.opts);
    rec.stop();
    await expect(rec.done).rejects.toMatchObject({ code: 'empty' });
  });

  it('an interrupted recording keeps what was recorded and says so', async () => {
    const m = fakeMedia();
    const rec = await startVoiceRecording(m.opts);
    m.recorder().emit([9, 9]);
    m.track.listeners.ended(); // e.g. an incoming call takes the microphone
    expect(await rec.done).toMatchObject({ interrupted: true });
  });

  it('stops at the size limit and refuses the oversized result', async () => {
    const m = fakeMedia();
    const rec = await startVoiceRecording({ ...m.opts, maxBytes: 4 });
    m.recorder().emit([1, 2, 3, 4, 5]);
    await expect(rec.done).rejects.toMatchObject({ code: 'too_large' });
  });
});

// Server double: /media + /sync/batch, with switchable failures.
function server() {
  const media = new Map();
  const s = {
    calls: [], media, failPut: false, failBatch: false, batches: [],
    async get(path) {
      s.calls.push(`GET ${path}`);
      const m = media.get(path.split('/')[2]);
      if (!m) throw new ApiError(404, 'not_found', 'no');
      return m;
    },
    async post(path, body) {
      s.calls.push(`POST ${path}`);
      if (path === '/media') {
        if (!media.has(body.id)) media.set(body.id, { ...body, status: 'pending' });
        return media.get(body.id);
      }
      if (s.failBatch) throw new ApiError(0, 'network_error', 'offline');
      s.batches.push(...body.operations);
      return { results: body.operations.map((o) => ({ op_id: o.op_id, type: o.type, outcome: 'acknowledged', server_timestamp: NOW.toISOString() })) };
    },
    async putRaw(path, bytes) {
      s.calls.push(`PUT ${path}`);
      if (s.failPut) throw new ApiError(0, 'network_error', 'connection reset');
      const m = media.get(path.split('/')[2]);
      m.status = 'uploaded';
      m.bytes = bytes;
      return {};
    },
  };
  return s;
}

async function rig() {
  const seeded = await seededStore();
  const api = server();
  const queue = createOperationsQueue({
    db: seeded.db, store: seeded.store, getApi: async () => api, isOnline: () => true, now: () => NOW.toISOString(),
    getActor: () => ({ actor: actorFor(IDS.janitor1) }),
  });
  return { ...seeded, api, queue };
}
const outboxOf = async (db) => (await db.query('SELECT sync_status, retry_count FROM sync_outbox'))[0];

describe('media upload lifecycle', () => {
  it('upload failure is retried; the file is uploaded once and its checksum matches the stored bytes', async () => {
    const { api, queue, store, db } = await rig();
    api.failPut = true;
    const c = inspectionPayload();
    expect((await queue.submit(c)).status).toBe('retry');
    expect(await outboxOf(db)).toMatchObject({ sync_status: 'pending', retry_count: 1 });
    expect((await store.inspections.get(c.payload.id)).sync_status).toBe('pending');
    api.failPut = false;
    await queue.flush();
    const id = c.payload.photo_media_id;
    const stored = await store.media.read(id);
    expect(api.media.get(id)).toMatchObject({ status: 'uploaded', sha256: stored.meta.sha256, size_bytes: stored.meta.size_bytes, division_id: IDS.division });
    expect(await sha256Hex(api.media.get(id).bytes)).toBe(stored.meta.sha256);
    expect(stored.meta).toMatchObject({ upload_status: 'uploaded', owner_table: 'inspection_records', owner_id: c.payload.id, division_id: IDS.division });
    expect(api.batches.map((o) => o.payload.id)).toEqual([c.payload.id]);
  });

  it('a batch failure after the upload does not upload the file again', async () => {
    const { api, queue } = await rig();
    api.failBatch = true;
    const c = inspectionPayload();
    await queue.submit(c);
    api.failBatch = false;
    await queue.flush();
    expect(api.calls.filter((x) => x === `PUT /media/${c.payload.photo_media_id}/content`)).toHaveLength(1);
    expect(api.batches).toHaveLength(1);
  });

  it('missing or corrupt device files are never uploaded; the record stays, marked failed, not synced', async () => {
    for (const damage of ['missing', 'corrupt']) {
      const { api, queue, store, db, files } = await rig();
      const off = createOperationsQueue({ db, store, getApi: async () => api, isOnline: () => false, now: () => NOW.toISOString(), getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
      const c = inspectionPayload();
      await off.submit(c);
      const name = c.payload.photo_media_id;
      if (damage === 'missing') await files.remove(name);
      else await files.write(name, new Uint8Array([1, 2, 3]));
      await queue.flush();
      expect(api.calls.some((x) => x.startsWith('PUT'))).toBe(false);
      expect(api.batches).toEqual([]);
      expect(await outboxOf(db)).toMatchObject({ sync_status: 'failed' });
      const rec = await store.inspections.get(c.payload.id);
      expect(rec).toBeTruthy(); // never deleted because sync failed
      expect(rec.sync_status).not.toBe('synced');
      expect(await store.media.getMeta(name)).toMatchObject({ upload_status: 'pending' }); // metadata kept for diagnosis
    }
  });

  it('media and its pending operation survive a restart and are delivered afterwards', async () => {
    const filename = `/media-${crypto.randomUUID()}.db`;
    const files = createMemoryFiles();
    const first = await seededStore({ filename, files });
    const off = createOperationsQueue({ db: first.db, store: first.store, getApi: async () => null, isOnline: () => false, now: () => NOW.toISOString(), getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
    const c = inspectionPayload();
    await off.submit(c);
    await first.db.close();
    const db = await createMemoryDb({ filename });
    const store = createLocalStore({ db, files, now: () => NOW, logger: null });
    expect((await store.media.read(c.payload.photo_media_id)).intact).toBe(true);
    const api = server();
    const queue = createOperationsQueue({ db, store, getApi: async () => api, isOnline: () => true, now: () => NOW.toISOString(), getActor: () => ({ actor: actorFor(IDS.janitor1) }) });
    await queue.flush();
    expect(api.media.get(c.payload.photo_media_id)?.status).toBe('uploaded');
    expect((await store.inspections.get(c.payload.id)).sync_status).toBe('synced');
  });
});
