// Journeys, their coach lists and staff allocations.
//
// Journeys are created and changed by managers through the server (the backend assigns journey IDs
// and checks `version` for concurrent edits), so this repository ingests server journeys and serves
// them locally. List state (active/scheduled/history/cancelled) is derived from Asia/Kolkata dates.
import { journeyState } from '../utils/businessDate.js';
import { bool, fromBool, insertStatement, placeholders, upsertStatement } from './sqlHelpers.js';

const STATE_SQL = {
  cancelled: "j.status = 'cancelled'",
  scheduled: "j.status = 'planned' AND j.journey_date > ?",
  history: "j.status = 'planned' AND j.end_date < ?",
  active: "j.status = 'planned' AND j.journey_date <= ? AND j.end_date >= ?",
};
const STATE_PARAMS = { cancelled: () => [], scheduled: (t) => [t], history: (t) => [t], active: (t) => [t, t] };
const STATE_ORDER = { active: 'j.journey_date ASC', scheduled: 'j.journey_date ASC', history: 'j.journey_date DESC', cancelled: 'j.journey_date DESC' };

export function createJourneyRepository(db, { masters, identity }) {
  async function hydrate(rows, today) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [coaches, staff] = await Promise.all([
      db.query(`SELECT * FROM journey_coaches WHERE is_active = 1 AND journey_id IN (${placeholders(ids)}) ORDER BY position`, ids),
      db.query(
        `SELECT s.*, p.name, p.emp_id FROM journey_staff s JOIN user_profiles p ON p.id = s.user_id
         WHERE s.journey_id IN (${placeholders(ids)}) ORDER BY s.allocated_at, p.name`,
        ids,
      ),
    ]);
    return rows.map((j) => ({
      id: j.id, division_id: j.division_id, train_id: j.train_id, train_no: j.train_no, train_name: j.train_name,
      linked_train_id: j.linked_train_id, linked_train_no: j.linked_train_no, journey_date: j.journey_date,
      outbound_end_date: j.outbound_end_date, linked_journey_date: j.linked_journey_date, end_date: j.end_date,
      start_time: j.start_time, end_time: j.end_time, return_start_time: j.return_start_time, return_end_time: j.return_end_time,
      duration_days: j.duration_days, operational_days: j.operational_days, daywise: fromBool(j.daywise),
      inspection_rounds_per_day: j.inspection_rounds_per_day, before_inspection_enabled: fromBool(j.before_inspection_enabled),
      after_inspection_enabled: fromBool(j.after_inspection_enabled), supervisor_id: j.supervisor_id,
      supervisor_name: j.supervisor_name ?? '', created_by_id: j.created_by_id, status: j.status,
      state: journeyState(j, today), cancel_reason: j.cancel_reason, cancelled_at: j.cancelled_at, version: j.version,
      coaches: coaches.filter((c) => c.journey_id === j.id).map(({ code, classification, position }) => ({ code, classification, position })),
      staff: staff.filter((s) => s.journey_id === j.id).map((s) => ({
        id: s.id, user_id: s.user_id, role_id: s.role_id, name: s.name, emp_id: s.emp_id, allocated_at: s.allocated_at, removed_at: s.removed_at,
      })),
      sync_status: j.sync_status, updated_at: j.server_updated_at ?? j.updated_at,
    }));
  }

  const SELECT = `SELECT j.*, p.name AS supervisor_name FROM journeys j LEFT JOIN user_profiles p ON p.id = j.supervisor_id`;

  return {
    // Ingests a server JourneyOut (with `staff` as returned by /sync/changes or /journeys/{id}).
    // All referenced rows (division, trains, people) are ensured in the same transaction.
    serverStatements(j, now) {
      const staff = [...(j.staff ?? [])].sort((a, b) => (a.removed_at ? 0 : 1) - (b.removed_at ? 0 : 1));
      const coaches = j.coaches ?? [];
      return [
        masters.ensureDivisionStatement(j.division_id, now),
        masters.ensureTrainStatement({ id: j.train_id, division_id: j.division_id, train_no: j.train_no, name: j.train_name }, now),
        ...(j.linked_train_id ? [masters.ensureTrainStatement({
          id: j.linked_train_id, division_id: j.division_id, train_no: j.linked_train_no, name: j.linked_train_no,
        }, now)] : []),
        identity.ensureProfileStatement({ id: j.supervisor_id, name: j.supervisor_name, division_id: j.division_id, role_id: 4 }, now),
        ...staff.map((s) => identity.ensureProfileStatement({ id: s.user_id, name: s.name, emp_id: s.emp_id, role_id: s.role_id, division_id: j.division_id }, now)),
        upsertStatement('journeys', {
          id: j.id, division_id: j.division_id, train_id: j.train_id, linked_train_id: j.linked_train_id ?? null,
          train_no: j.train_no, train_name: j.train_name, linked_train_no: j.linked_train_no ?? null, journey_date: j.journey_date,
          outbound_end_date: j.outbound_end_date ?? null, linked_journey_date: j.linked_journey_date ?? null, end_date: j.end_date,
          start_time: j.start_time ?? null, end_time: j.end_time ?? null, return_start_time: j.return_start_time ?? null,
          return_end_time: j.return_end_time ?? null, duration_days: j.duration_days ?? 1, operational_days: j.operational_days ?? 1,
          daywise: bool(j.daywise), inspection_rounds_per_day: j.inspection_rounds_per_day ?? 1,
          before_inspection_enabled: bool(j.before_inspection_enabled ?? true), after_inspection_enabled: bool(j.after_inspection_enabled ?? true),
          supervisor_id: j.supervisor_id, created_by_id: j.created_by_id ?? null,
          status: j.state === 'cancelled' || j.status === 'cancelled' ? 'cancelled' : 'planned',
          cancel_reason: j.cancel_reason ?? null, cancelled_at: j.cancelled_at ?? null, version: j.version ?? 1,
          origin: 'server', sync_status: 'synced', synced_at: now, server_updated_at: j.updated_at ?? null, created_at: now, updated_at: now,
        }),
        { sql: 'UPDATE journey_coaches SET is_active = 0 WHERE journey_id = ?', params: [j.id] },
        ...coaches.map((c, i) => upsertStatement('journey_coaches', {
          journey_id: j.id, code: c.code, classification: c.classification, position: c.position ?? i + 1, is_active: 1,
        }, { key: ['journey_id', 'code'], insertOnly: [] })),
        ...staff.map((s) => upsertStatement('journey_staff', {
          id: s.id, journey_id: j.id, user_id: s.user_id, role_id: s.role_id ?? null, allocated_at: s.allocated_at ?? now,
          removed_at: s.removed_at ?? null, origin: 'server', sync_status: 'synced', synced_at: now, created_at: now, updated_at: now,
        })),
      ];
    },

    async ingest(j, now) {
      await db.transaction(this.serverStatements(j, now));
    },

    // Local allocation change (server-confirmed): adds staff, or marks an allocation removed.
    allocateStatement({ id = crypto.randomUUID(), journeyId, userId, roleId = null, now }) {
      return insertStatement('journey_staff', {
        id, journey_id: journeyId, user_id: userId, role_id: roleId, allocated_at: now, origin: 'server',
        sync_status: 'synced', synced_at: now, created_at: now, updated_at: now,
      });
    },

    removeStaffStatement({ journeyId, userId, now }) {
      return {
        sql: 'UPDATE journey_staff SET removed_at = ?, updated_at = ? WHERE journey_id = ? AND user_id = ? AND removed_at IS NULL',
        params: [now, now, journeyId, userId],
      };
    },

    async list({ state, divisionId, mineUserId, today, divisions } = {}) {
      const where = [];
      const params = [];
      if (state) {
        where.push(STATE_SQL[state]);
        params.push(...STATE_PARAMS[state](today));
      }
      if (divisionId) {
        where.push('j.division_id = ?');
        params.push(divisionId);
      } else if (divisions) {
        where.push(divisions.length ? `j.division_id IN (${placeholders(divisions)})` : '0');
        params.push(...divisions);
      }
      if (mineUserId) {
        where.push('(j.supervisor_id = ? OR EXISTS (SELECT 1 FROM journey_staff s WHERE s.journey_id = j.id AND s.user_id = ? AND s.removed_at IS NULL))');
        params.push(mineUserId, mineUserId);
      }
      const rows = await db.query(
        `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${STATE_ORDER[state] ?? 'j.journey_date DESC'}, j.train_no`,
        params,
      );
      return hydrate(rows, today);
    },

    async get(id, today) {
      const rows = await db.query(`${SELECT} WHERE j.id = ?`, [id]);
      return (await hydrate(rows, today))[0] ?? null;
    },

    async coach(journeyId, code) {
      const [c] = await db.query('SELECT * FROM journey_coaches WHERE journey_id = ? AND code = ? AND is_active = 1', [journeyId, code]);
      return c ?? null;
    },

    async isAllocated(journeyId, userId) {
      const [row] = await db.query(
        'SELECT 1 AS ok FROM journey_staff WHERE journey_id = ? AND user_id = ? AND removed_at IS NULL',
        [journeyId, userId],
      );
      return !!row;
    },

    async activeStaff(journeyId) {
      return db.query(
        `SELECT s.user_id, s.role_id, p.name, p.emp_id FROM journey_staff s JOIN user_profiles p ON p.id = s.user_id
         WHERE s.journey_id = ? AND s.removed_at IS NULL ORDER BY s.allocated_at, p.name`,
        [journeyId],
      );
    },
  };
}
