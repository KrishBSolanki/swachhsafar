// Local identity and authorization: employee profiles, per-division permissions, the cached
// /auth/me snapshot used for offline sign-in, and local session metadata.
// Firebase Authentication stays the identity provider; nothing here stores a credential.
import { bool, fromBool, insertStatement, parseJson, upsertStatement } from './sqlHelpers.js';

const profileRow = (u, now, extra = {}) => ({
  id: u.id, emp_id: u.emp_id ?? null, name: u.name ?? '', name_hindi: u.name_hindi ?? null,
  email: u.email ? String(u.email).toLowerCase() : null, mobile: u.mobile ?? null, gender: u.gender ?? null,
  designation: u.designation ?? null, lang: u.lang ?? null, role_id: u.role_id ?? null, division_id: u.division_id ?? null,
  status: u.status ?? 'active', firebase_linked: u.firebase_linked == null ? null : bool(u.firebase_linked),
  sync_status: 'synced', server_updated_at: u.updated_at ?? null, created_at: now, updated_at: now, ...extra,
});

const profileOut = (r) => ({
  id: r.id, emp_id: r.emp_id, name: r.name, name_hindi: r.name_hindi, email: r.email, mobile: r.mobile, gender: r.gender,
  designation: r.designation, lang: r.lang ?? 'en', role_id: r.role_id, division_id: r.division_id, status: r.status,
  firebase_linked: r.firebase_linked == null ? null : fromBool(r.firebase_linked), updated_at: r.server_updated_at ?? r.updated_at,
});

const KNOWN_ROLES = new Set([1, 2, 3, 4, 5, 6]);

export function createIdentityRepository(db, { masters }) {
  return {
    // Full profile from /auth/me or /users.
    profileStatements(u, now) {
      const row = profileRow({ ...u, role_id: KNOWN_ROLES.has(u.role_id) ? u.role_id : null }, now);
      return [upsertStatement('user_profiles', row)];
    },

    // Partial profile (journey staff/supervisor): never overwrite richer fields with nulls.
    ensureProfileStatement({ id, name, emp_id, role_id, division_id }, now) {
      return {
        sql: `INSERT INTO user_profiles (id, emp_id, name, role_id, division_id, status, sync_status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'active', 'synced', ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE user_profiles.name END,
                emp_id = COALESCE(excluded.emp_id, user_profiles.emp_id),
                role_id = COALESCE(user_profiles.role_id, excluded.role_id),
                division_id = COALESCE(user_profiles.division_id, excluded.division_id)`,
        params: [id, emp_id ?? null, name ?? '', KNOWN_ROLES.has(role_id) ? role_id : null, division_id ?? null, now, now],
      };
    },

    // Caches an /auth/me response: profile, division assignments, permissions and the raw snapshot,
    // atomically, so an offline sign-in never sees half of an update.
    async saveAuthorization(me, { firebaseUid = null, now }) {
      const user = me.user;
      const divisions = Object.entries(me.divisions ?? {});
      const perms = [...new Set(divisions.flatMap(([, list]) => list))];
      await db.transaction([
        ...this.profileStatements(user, now),
        { sql: 'UPDATE user_profiles SET local_user_id = (SELECT id FROM users WHERE email = ?) WHERE id = ?', params: [String(user.email ?? '').toLowerCase(), user.id] },
        ...divisions.map(([d]) => masters.ensureDivisionStatement(d, now)),
        ...perms.map((code) => insertStatement('permissions', { code, created_at: now }, { orIgnore: true })),
        { sql: 'DELETE FROM user_division_assignments WHERE user_id = ?', params: [user.id] },
        ...divisions.map(([d]) => insertStatement('user_division_assignments', { user_id: user.id, division_id: d, created_at: now, updated_at: now })),
        ...divisions.flatMap(([d, list]) => [...new Set(list)].map((code) => insertStatement('user_division_permissions', {
          user_id: user.id, division_id: d, permission_code: code,
        }))),
        upsertStatement('authorization_snapshots', {
          user_id: user.id, email: String(user.email ?? '').toLowerCase() || null, firebase_uid: firebaseUid,
          snapshot: JSON.stringify(me), fetched_at: now, created_at: now, updated_at: now,
        }, { key: ['user_id'] }),
      ]);
    },

    // Most recent cached authorization for this email (case-insensitive), or null.
    async findSnapshotByEmail(email) {
      if (!email) return null;
      const [row] = await db.query(
        'SELECT snapshot, fetched_at FROM authorization_snapshots WHERE email = ? ORDER BY fetched_at DESC LIMIT 1',
        [String(email).toLowerCase()],
      );
      const snapshot = parseJson(row?.snapshot);
      return snapshot ? { ...snapshot, fetched_at: row.fetched_at } : null;
    },

    async permissionsFor(userId) {
      const rows = await db.query(
        'SELECT division_id, permission_code FROM user_division_permissions WHERE user_id = ? ORDER BY division_id, permission_code',
        [userId],
      );
      const out = {};
      for (const r of rows) (out[r.division_id] ??= []).push(r.permission_code);
      return out;
    },

    async getProfile(id) {
      const [r] = await db.query('SELECT * FROM user_profiles WHERE id = ?', [id]);
      return r ? profileOut(r) : null;
    },

    async listProfiles({ divisionId, roleId, status, q } = {}) {
      const needle = q ? `%${String(q).toLowerCase()}%` : null;
      const rows = await db.query(
        `SELECT * FROM user_profiles
         WHERE (? IS NULL OR division_id = ?) AND (? IS NULL OR role_id = ?) AND (? IS NULL OR status = ?)
           AND (? IS NULL OR lower(name || ' ' || COALESCE(emp_id, '')) LIKE ?)
         ORDER BY name`,
        [divisionId ?? null, divisionId ?? null, roleId ?? null, roleId ?? null, status ?? null, status ?? null, needle, needle],
      );
      return rows.map(profileOut);
    },

    async startSession({ userId, firebaseUid, email, mode, now }) {
      const id = crypto.randomUUID();
      await db.run(
        `INSERT INTO local_sessions (id, user_id, firebase_uid, email, mode, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, firebaseUid ?? null, email ? String(email).toLowerCase() : null, mode, now, now],
      );
      return id;
    },

    async touchSession(id, now) {
      return db.run('UPDATE local_sessions SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL', [now, id]);
    },

    async endSession(id, now) {
      return db.run('UPDATE local_sessions SET ended_at = ?, last_seen_at = ? WHERE id = ? AND ended_at IS NULL', [now, now, id]);
    },

    async listSessions(userId) {
      return db.query('SELECT * FROM local_sessions WHERE user_id = ? ORDER BY started_at DESC', [userId]);
    },
  };
}
