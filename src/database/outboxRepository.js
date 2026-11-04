// Data access for the `sync_outbox` queue and the `sync_meta` key/value table.
//
// Outbox status lifecycle:
//   pending -> processing -> completed
//                         -> pending  (retryable failure, retry_count + 1)
//                         -> failed   (needs user action; can be reset to pending)

export function createOutboxRepository(db) {
  return {
    insertStatement(entry) {
      return {
        sql: `INSERT INTO sync_outbox (id, entity_type, entity_id, operation, payload, retry_count,
                sync_status, created_at, updated_at, owner_user_id)
              VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)`,
        params: [entry.id, entry.entity_type, entry.entity_id, entry.operation,
          JSON.stringify(entry.payload), entry.created_at, entry.created_at, entry.owner_user_id ?? null],
      };
    },

    // `entityType` scopes a query to one queue: 'user' registrations or 'operation' records.
    // `ownerId` limits operations to one user's entries (plus unattributed pre-Phase 2 entries).
    async listPending(entityType = null, { ownerId } = {}) {
      if (ownerId !== undefined) {
        return db.query(
          `SELECT * FROM sync_outbox WHERE sync_status = 'pending' AND entity_type = ?
             AND (owner_user_id = ? OR owner_user_id IS NULL) ORDER BY created_at ASC`,
          [entityType, ownerId],
        );
      }
      return db.query(
        `SELECT * FROM sync_outbox WHERE sync_status = 'pending' AND (? IS NULL OR entity_type = ?) ORDER BY created_at ASC`,
        [entityType, entityType],
      );
    },

    async listOpen(entityType = 'user') {
      return db.query(
        `SELECT * FROM sync_outbox WHERE sync_status != 'completed' AND entity_type = ? ORDER BY created_at ASC`,
        [entityType],
      );
    },

    async countPending(entityType = 'user') {
      const [row] = await db.query(
        `SELECT COUNT(*) AS count FROM sync_outbox WHERE sync_status IN ('pending', 'processing') AND entity_type = ?`,
        [entityType],
      );
      return row.count;
    },

    async findOpenForEntity(entityType, entityId) {
      const [row] = await db.query(
        `SELECT * FROM sync_outbox WHERE entity_type = ? AND entity_id = ? AND sync_status != 'completed'`,
        [entityType, entityId],
      );
      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.query('SELECT * FROM sync_outbox WHERE id = ?', [id]);
      return row ?? null;
    },

    // Atomically claims a pending entry. Returns false if another sync run already took it,
    // which keeps concurrent triggers from processing the same operation twice.
    async claim(id, now) {
      const { changes } = await db.run(
        `UPDATE sync_outbox SET sync_status = 'processing', updated_at = ? WHERE id = ? AND sync_status = 'pending'`,
        [now, id],
      );
      return changes === 1;
    },

    // Statement forms of the outcome transitions, so the queue commits them in the SAME transaction as the
    // record's own sync state (localStore.markOutcome). Readers then never see one without the other.
    completedStatement(id, now) {
      return {
        sql: `UPDATE sync_outbox SET sync_status = 'completed', last_error = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
        params: [now, now, id],
      };
    },
    retryStatement(id, { error, now }) {
      return {
        sql: `UPDATE sync_outbox SET sync_status = 'pending', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        params: [error, now, id],
      };
    },
    failedStatement(id, { error, now }) {
      return {
        sql: `UPDATE sync_outbox SET sync_status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        params: [error, now, id],
      };
    },

    async markCompleted(id, now) {
      const { sql, params } = this.completedStatement(id, now);
      return db.run(sql, params);
    },

    async markRetry(id, { error, now }) {
      const { sql, params } = this.retryStatement(id, { error, now });
      return db.run(sql, params);
    },

    // Returns a claimed entry to the queue without counting an attempt (e.g. password not supplied).
    async release(id, now) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'pending', updated_at = ? WHERE id = ? AND sync_status = 'processing'`,
        [now, id],
      );
    },

    async markFailed(id, { error, now }) {
      const { sql, params } = this.failedStatement(id, { error, now });
      return db.run(sql, params);
    },

    async resetFailed(id, now) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'pending', last_error = NULL, updated_at = ?
         WHERE id = ? AND sync_status = 'failed'`,
        [now, id],
      );
    },

    // Entries left in 'processing' by a closed/crashed app go back to the queue on startup.
    async recoverInterrupted(now) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'pending', updated_at = ? WHERE sync_status = 'processing'`,
        [now],
      );
    },

    async getMeta(key) {
      const [row] = await db.query('SELECT value FROM sync_meta WHERE key = ?', [key]);
      return row?.value ?? null;
    },

    // { value, updated_at } or null: for cached responses that must say when they were loaded.
    async getMetaEntry(key) {
      const [row] = await db.query('SELECT value, updated_at FROM sync_meta WHERE key = ?', [key]);
      return row ?? null;
    },

    async setMeta(key, value, now) {
      return db.run(
        `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, now],
      );
    },
  };
}
