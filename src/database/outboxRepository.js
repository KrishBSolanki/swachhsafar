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
                sync_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
        params: [entry.id, entry.entity_type, entry.entity_id, entry.operation,
          JSON.stringify(entry.payload), entry.created_at, entry.created_at],
      };
    },

    // `entityType` scopes a query to one queue: 'user' registrations or 'operation' records.
    async listPending(entityType = null) {
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

    async markCompleted(id, now) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'completed', last_error = NULL, completed_at = ?, updated_at = ?
         WHERE id = ?`,
        [now, now, id],
      );
    },

    async markRetry(id, { error, now }) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'pending', retry_count = retry_count + 1, last_error = ?,
           updated_at = ? WHERE id = ?`,
        [error, now, id],
      );
    },

    // Returns a claimed entry to the queue without counting an attempt (e.g. password not supplied).
    async release(id, now) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'pending', updated_at = ? WHERE id = ? AND sync_status = 'processing'`,
        [now, id],
      );
    },

    async markFailed(id, { error, now }) {
      return db.run(
        `UPDATE sync_outbox SET sync_status = 'failed', retry_count = retry_count + 1, last_error = ?,
           updated_at = ? WHERE id = ?`,
        [error, now, id],
      );
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

    async setMeta(key, value, now) {
      return db.run(
        `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, now],
      );
    },
  };
}
