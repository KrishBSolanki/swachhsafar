// Media evidence (photos, videos, voice recordings, attachments).
//
// The bytes are written to persistent device storage first: OPFS, through the SQLite worker (see
// sqlite.worker.js `file.*` messages). The metadata row in media_files is inserted in the SAME
// SQLite transaction as the record that owns it, so a record never points at missing metadata.
// If that transaction fails, the file is an orphan that sweepOrphans() removes.
import { insertStatement } from './sqlHelpers.js';
import { LocalRuleError, isStorageFull, storageFullError } from './errors.js';

export const MEDIA_KINDS = ['attendance_photo', 'inspection_photo', 'inspection_video', 'feedback_voice', 'complaint_attachment'];
// Largest file kept on the device, whatever the kind.
export const DEVICE_MAX_BYTES = 25 * 1024 * 1024;
const MB = 1024 * 1024;
const IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

// Content types and sizes the server accepts per kind (backend services/media.py RULES). A capture the
// server would refuse is refused here, before anything is saved, so the user is never told "saved" for
// evidence that can never be delivered. Sizes are capped by DEVICE_MAX_BYTES.
export const MEDIA_RULES = {
  attendance_photo: { types: IMAGES, maxBytes: 8 * MB },
  inspection_photo: { types: IMAGES, maxBytes: 8 * MB },
  inspection_video: { types: ['video/mp4', 'video/3gpp', 'video/webm', 'video/quicktime'], maxBytes: Math.min(100 * MB, DEVICE_MAX_BYTES) },
  feedback_voice: { types: ['audio/mpeg', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/ogg', 'audio/x-wav', 'audio/wav', 'video/webm', 'video/mp4'], maxBytes: 10 * MB },
  complaint_attachment: { types: [...IMAGES, 'application/pdf'], maxBytes: 15 * MB },
};

// 'audio/webm;codecs=opus' -> 'audio/webm'
export const baseMime = (t) => String(t ?? '').split(';')[0].trim().toLowerCase();

// Throws LocalRuleError when `kind` / content type / size would not be accepted.
export function validateMedia({ kind, mimeType, size }) {
  const rule = MEDIA_RULES[kind];
  if (!rule) throw new LocalRuleError('media_kind_unknown', `Unknown media kind: ${kind}`);
  if (!size) throw new LocalRuleError('media_empty', 'The file is empty. Capture it again.');
  const type = baseMime(mimeType);
  if (!rule.types.includes(type)) throw new LocalRuleError('media_type_rejected', `This file type (${type || 'unknown'}) is not accepted for ${kind.replace('_', ' ')}.`);
  if (size > rule.maxBytes) {
    throw new LocalRuleError('media_too_large', `The file is ${(size / MB).toFixed(1)} MB; the limit for ${kind.replace('_', ' ')} is ${rule.maxBytes / MB} MB.`);
  }
  return type;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function dataUrlToBytes(dataUrl) {
  const [head, b64 = ''] = String(dataUrl).split(',');
  const contentType = head.match(/^data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType };
}

export function bytesToDataUrl(bytes, contentType) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${contentType};base64,${btoa(bin)}`;
}

const storagePath = (id) => `media/${id}`;
const fileName = (path) => path.replace(/^media\//, '');

// `files` is the byte store: { write(name, bytes), read(name) -> Uint8Array|null, remove(name), list() -> names }.
export function createMediaStore(db, { files }) {
  return {
    // Writes the bytes and returns the metadata insert for the caller's transaction.
    async stage({ id, kind, bytes, mimeType, divisionId = null, ownerTable, ownerId, now }) {
      if (!(bytes instanceof Uint8Array)) throw new LocalRuleError('media_empty', 'The file is empty. Capture it again.');
      const type = validateMedia({ kind, mimeType, size: bytes.byteLength });
      const path = storagePath(id);
      try {
        await files.write(fileName(path), bytes);
      } catch (e) {
        // A partial file must not survive a failed write (sweepOrphans would also remove it on startup).
        await files.remove(fileName(path)).catch(() => {});
        if (isStorageFull(e)) throw storageFullError();
        throw e;
      }
      const meta = {
        id, owner_table: ownerTable, owner_id: ownerId, kind, mime_type: type, size_bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes), storage_path: path, division_id: divisionId, upload_status: 'pending',
        created_at: now, updated_at: now,
      };
      return { meta, statement: insertStatement('media_files', meta) };
    },

    async getMeta(id) {
      const [row] = await db.query('SELECT * FROM media_files WHERE id = ?', [id]);
      return row ?? null;
    },

    // Bytes plus metadata; `intact` is false if the stored file no longer matches its checksum.
    async read(id) {
      const meta = await this.getMeta(id);
      if (!meta) return null;
      const bytes = await files.read(fileName(meta.storage_path));
      if (!bytes) return { meta, bytes: null, intact: false };
      return { meta, bytes, intact: bytes.byteLength === meta.size_bytes && (await sha256Hex(bytes)) === meta.sha256 };
    },

    async listForOwner(ownerTable, ownerId) {
      return db.query('SELECT * FROM media_files WHERE owner_table = ? AND owner_id = ? ORDER BY created_at', [ownerTable, ownerId]);
    },

    async listPendingUploads() {
      return db.query("SELECT * FROM media_files WHERE upload_status != 'uploaded' ORDER BY created_at");
    },

    async markUploaded(id, now) {
      return db.run(
        "UPDATE media_files SET upload_status = 'uploaded', uploaded_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        [now, now, id],
      );
    },

    async markUploadFailed(id, error, now) {
      return db.run("UPDATE media_files SET upload_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [error, now, id]);
    },

    // Removes stored files that no metadata row refers to (left by a failed transaction).
    async sweepOrphans() {
      const names = await files.list();
      if (!names.length) return [];
      const rows = await db.query('SELECT storage_path FROM media_files');
      const known = new Set(rows.map((r) => fileName(r.storage_path)));
      const orphans = names.filter((n) => !known.has(n));
      for (const n of orphans) await files.remove(n);
      return orphans;
    },
  };
}
