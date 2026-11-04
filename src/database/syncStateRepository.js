// Synchronization bookkeeping beside sync_outbox: conflicts reported by the server, tombstones for
// records removed on this device, pull checkpoints, and the local append-only audit log.
import { insertStatement, parseJson, upsertStatement } from './sqlHelpers.js';

export function createSyncStateRepository(db) {
  return {
    // ---- conflicts ----
    conflictStatement({ entityType, entityId, outboxId, operation, outcome, code, message, detail, now }) {
      return insertStatement('sync_conflicts', {
        id: crypto.randomUUID(), entity_type: entityType, entity_id: entityId, outbox_id: outboxId ?? null,
        operation: operation ?? null, outcome, code: code ?? null, message: message ?? null,
        server_detail: detail == null ? null : JSON.stringify(detail), status: 'open', detected_at: now,
      });
    },

    async listConflicts({ status = 'open' } = {}) {
      const rows = await db.query('SELECT * FROM sync_conflicts WHERE (? IS NULL OR status = ?) ORDER BY detected_at DESC', [status, status]);
      return rows.map((r) => ({ ...r, server_detail: parseJson(r.server_detail) }));
    },

    async resolveConflict(id, { status = 'resolved', now }) {
      return db.run("UPDATE sync_conflicts SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'", [status, now, id]);
    },

    // ---- tombstones ----
    tombstoneStatement({ entityType, entityId, origin = 'local', reason = null, now }) {
      return upsertStatement('sync_tombstones', {
        entity_type: entityType, entity_id: entityId, origin, reason, deleted_at: now,
      }, { key: ['entity_type', 'entity_id'], insertOnly: [] });
    },

    async isTombstoned(entityType, entityId) {
      const [row] = await db.query('SELECT 1 AS t FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?', [entityType, entityId]);
      return !!row;
    },

    async listTombstones(entityType = null) {
      return db.query('SELECT * FROM sync_tombstones WHERE (? IS NULL OR entity_type = ?) ORDER BY deleted_at', [entityType, entityType]);
    },

    // ---- checkpoints ----
    async getCheckpoint(scope) {
      const [row] = await db.query('SELECT * FROM sync_checkpoints WHERE scope = ?', [scope]);
      return row ?? null;
    },

    checkpointStatement(scope, { cursor, now }) {
      return {
        sql: `INSERT INTO sync_checkpoints (scope, cursor, last_attempt_at, last_success_at, last_error, updated_at)
              VALUES (?, ?, ?, ?, NULL, ?)
              ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, last_attempt_at = excluded.last_attempt_at,
                last_success_at = excluded.last_success_at, last_error = NULL, updated_at = excluded.updated_at`,
        params: [scope, cursor, now, now, now],
      };
    },

    async recordCheckpointError(scope, { error, now }) {
      return db.run(
        `INSERT INTO sync_checkpoints (scope, last_attempt_at, last_error, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
        [scope, now, error, now],
      );
    },

    // ---- audit ----
    auditStatement({ actorId, divisionId, action, entityType, entityId, details, now }) {
      return insertStatement('audit_events', {
        id: crypto.randomUUID(), occurred_at: now, actor_id: actorId ?? null, division_id: divisionId ?? null, action,
        entity_type: entityType, entity_id: entityId, details: details == null ? null : JSON.stringify(details),
      });
    },

    async listAudit({ entityType, entityId, limit = 100 } = {}) {
      const rows = await db.query(
        `SELECT * FROM audit_events WHERE (? IS NULL OR entity_type = ?) AND (? IS NULL OR entity_id = ?)
         ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
        [entityType ?? null, entityType ?? null, entityId ?? null, entityId ?? null, limit],
      );
      return rows.map((r) => ({ ...r, details: parseJson(r.details) }));
    },
  };
}
