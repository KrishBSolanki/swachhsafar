// Data access for the local `users` table.

// Columns safe to hand to the UI / sync layer. password_hash and password_salt are
// only read through findCredentialsById for local verification.
const PUBLIC_COLUMNS = `id, username, email, registration_status, sync_status, created_at, updated_at,
  firebase_uid, cloud_profile_id, last_sync_error, synced_at`;

export function createUserRepository(db) {
  return {
    insertStatement(user) {
      return {
        sql: `INSERT INTO users (id, username, email, password_hash, password_salt,
                registration_status, sync_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          user.id, user.username, user.email, user.password_hash, user.password_salt,
          user.registration_status ?? 'pending', user.sync_status ?? 'pending', user.created_at, user.updated_at,
        ],
      };
    },

    async findById(id) {
      const [row] = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [id]);
      return row ?? null;
    },

    async findByEmail(email) {
      const [row] = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = ?`, [email]);
      return row ?? null;
    },

    async findCredentialsById(id) {
      const [row] = await db.query('SELECT password_hash, password_salt FROM users WHERE id = ?', [id]);
      return row ?? null;
    },

    async list() {
      return db.query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at DESC`);
    },

    async markSynced(id, { firebaseUid, cloudProfileId, now }) {
      return db.run(
        `UPDATE users SET registration_status = 'registered', sync_status = 'synced', firebase_uid = ?,
           cloud_profile_id = ?, last_sync_error = NULL, synced_at = ?, updated_at = ? WHERE id = ?`,
        [firebaseUid, cloudProfileId, now, now, id],
      );
    },

    // Retryable failure: the registration stays pending and keeps its outbox entry.
    async markSyncRetry(id, { error, now }) {
      return db.run(
        `UPDATE users SET sync_status = 'pending', last_sync_error = ?, updated_at = ? WHERE id = ?`,
        [error, now, id],
      );
    },

    // Permanent failure that needs user action (e.g. email already used with another password).
    async markSyncFailed(id, { error, registrationStatus, now }) {
      return db.run(
        `UPDATE users SET sync_status = 'failed', registration_status = COALESCE(?, registration_status),
           last_sync_error = ?, updated_at = ? WHERE id = ?`,
        [registrationStatus ?? null, error, now, id],
      );
    },

    async resetForRetry(id, now) {
      return db.run(
        `UPDATE users SET sync_status = 'pending', registration_status = 'pending', last_sync_error = NULL,
           updated_at = ? WHERE id = ? AND sync_status = 'failed'`,
        [now, id],
      );
    },
  };
}
