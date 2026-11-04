// Five-stage staff attendance (1 Source, 2 Enroute 1, 3 Destination, 4 Enroute 2, 5 End).
// Rules: the employee must be allocated to the journey, stages are recorded in order, and each stage
// at most once. Order and uniqueness are also enforced by trg_attendance_stage_order and
// idx_attendance_slot, so two concurrent captures cannot both succeed.
import { LocalRuleError } from './errors.js';
import { requireCaptureWindow, requireDeviceTimestamp, requireGps, requireInt, requireUuid } from './captureRules.js';
import { insertStatement, placeholders } from './sqlHelpers.js';

export const STAGE_COUNT = 5;

// A local row in the shape of the backend AttendanceOut, plus where it stands between device and server.
// Rows stored from a server status grid carry only their slot; their details stay on the server.
export const attendanceOut = (r) => ({
  id: r.id, journey_id: r.journey_id, division_id: r.division_id, employee_id: r.employee_id, stage: r.stage,
  device_timestamp: r.device_timestamp, server_timestamp: r.server_timestamp, latitude: r.latitude, longitude: r.longitude,
  gps_accuracy_m: r.gps_accuracy_m, photo_media_id: r.photo_media_id, group_submission_id: null, created_by_id: r.recorded_by_id,
  verification_status: r.verification_status, verified_by_id: null, review_remarks: null,
  origin: r.origin, sync_status: r.sync_status, last_sync_error: r.last_sync_error,
});
const LIVE = "sync_status NOT IN ('rejected', 'conflict')";

// Cell states for one employee. `taken` = acknowledged by the server, `pending` = saved on this device.
export function attendanceCells(taken, pending) {
  const has = (s) => taken.has(s) || pending.has(s);
  let next = null;
  for (let s = 1; s <= STAGE_COUNT; s += 1) {
    if (!has(s)) {
      next = s;
      break;
    }
  }
  return {
    stages: Array.from({ length: STAGE_COUNT }, (_, i) => {
      const stage = i + 1;
      if (taken.has(stage)) return { stage, status: 'taken', attendance_id: taken.get(stage) };
      if (pending.has(stage)) return { stage, status: 'pending', attendance_id: pending.get(stage) };
      return { stage, status: stage === next ? 'next' : 'locked', attendance_id: null };
    }),
    completed: next === null && [...pending.keys()].every((s) => taken.has(s)),
  };
}

export function createAttendanceRepository(db, { journeys }) {
  async function liveStages(journeyId, employeeId) {
    return db.query(
      `SELECT id, stage, sync_status FROM attendance_records WHERE journey_id = ? AND employee_id = ? AND ${LIVE}`,
      [journeyId, employeeId],
    );
  }

  return {
    // Validates a capture against local data and returns the statements that insert it.
    async prepareCapture(p, { actor, policy, nowMs, now, today }) {
      requireUuid(p.id, 'id');
      requireUuid(p.journey_id, 'journey_id');
      requireUuid(p.employee_id, 'employee_id');
      const stage = requireInt(p.stage, 'stage', 1, STAGE_COUNT);
      const capturedOn = requireDeviceTimestamp(p.device_timestamp, nowMs);
      const gps = requireGps(p);
      const journey = await journeys.get(p.journey_id, today);
      requireCaptureWindow(journey, capturedOn);
      if (!(await journeys.isAllocated(journey.id, p.employee_id))) {
        throw new LocalRuleError('not_allocated', 'This employee is not allocated to the journey.');
      }
      // Backend _may_submit_for: the employee, the journey supervisor, or attendance.review in the division.
      const reviewer = actor?.permissions?.[journey.division_id]?.includes('attendance.review');
      if (actor && !reviewer && actor.id !== p.employee_id && actor.id !== journey.supervisor_id) {
        throw new LocalRuleError('forbidden', 'Only the employee, the journey supervisor or a reviewer may record this attendance.');
      }
      if (policy.attendance_photo_required && !p.photo_media_id) {
        throw new LocalRuleError('photo_required', 'A photograph is required for attendance.');
      }
      const done = new Set((await liveStages(journey.id, p.employee_id)).map((r) => r.stage));
      if (done.has(stage)) throw new LocalRuleError('duplicate_attendance', 'Attendance is already recorded for this stage.');
      if (stage > 1 && !done.has(stage - 1)) {
        throw new LocalRuleError('stage_order', `Stage ${stage - 1} must be recorded first.`, { recorded_stages: [...done].sort() });
      }
      const row = {
        id: p.id, journey_id: journey.id, division_id: journey.division_id, employee_id: p.employee_id, stage, ...gps,
        device_timestamp: p.device_timestamp, captured_on: capturedOn, photo_media_id: p.photo_media_id ?? null,
        recorded_by_id: actor?.id ?? null, origin: 'local', sync_status: 'pending', created_at: now, updated_at: now,
      };
      return { row, divisionId: journey.division_id, statements: [insertStatement('attendance_records', row)] };
    },

    // Server-confirmed records seen in GET /attendance/journeys/{id}/status. INSERT OR IGNORE keeps
    // this device's own copy; a slot already held locally is left for the sync outcome to decide.
    serverStatements(journey, statusRows, now) {
      return statusRows.flatMap((r) => r.stages.filter((c) => c.status === 'taken' && c.attendance_id).map((c) => insertStatement('attendance_records', {
        id: c.attendance_id, journey_id: journey.id, division_id: journey.division_id, employee_id: r.employee_id, stage: c.stage,
        origin: 'server', sync_status: 'synced', synced_at: now, created_at: now, updated_at: now,
      }, { orIgnore: true })));
    },

    async get(id) {
      const [r] = await db.query('SELECT * FROM attendance_records WHERE id = ?', [id]);
      return r ?? null;
    },

    async listForJourney(journeyId) {
      return db.query('SELECT * FROM attendance_records WHERE journey_id = ? ORDER BY employee_id, stage, created_at', [journeyId]);
    },

    // Records in `divisions` (GET /attendance filters), newest first, as attendanceOut().
    async listRecords({ divisions = [], journeyId, employeeId, stage, verificationStatus } = {}) {
      if (!divisions.length) return [];
      const rows = await db.query(
        `SELECT * FROM attendance_records WHERE division_id IN (${placeholders(divisions)})
           AND (? IS NULL OR journey_id = ?) AND (? IS NULL OR employee_id = ?) AND (? IS NULL OR stage = ?)
           AND (? IS NULL OR verification_status = ?)
         ORDER BY COALESCE(device_timestamp, server_timestamp, created_at) DESC, stage DESC`,
        [...divisions, journeyId ?? null, journeyId ?? null, employeeId ?? null, employeeId ?? null, stage ?? null, stage ?? null,
          verificationStatus ?? null, verificationStatus ?? null],
      );
      return rows.map(attendanceOut);
    },

    async pendingForJourney(journeyId) {
      return db.query(
        "SELECT id, employee_id, stage FROM attendance_records WHERE journey_id = ? AND sync_status = 'pending'",
        [journeyId],
      );
    },

    // Same shape as GET /attendance/journeys/{id}/status, plus 'pending' cells for unsynced records.
    async journeyStatus(journeyId) {
      const [staff, records] = await Promise.all([
        journeys.activeStaff(journeyId),
        db.query(`SELECT id, employee_id, stage, sync_status FROM attendance_records WHERE journey_id = ? AND ${LIVE}`, [journeyId]),
      ]);
      return staff.map((s) => {
        const mine = records.filter((r) => r.employee_id === s.user_id);
        const taken = new Map(mine.filter((r) => r.sync_status === 'synced').map((r) => [r.stage, r.id]));
        const pending = new Map(mine.filter((r) => r.sync_status === 'pending').map((r) => [r.stage, r.id]));
        return { employee_id: s.user_id, name: s.name, emp_id: s.emp_id, role_id: s.role_id, ...attendanceCells(taken, pending) };
      });
    },

    // Adds this device's unsynced records to a server status response.
    async overlayStatus(journeyId, rows) {
      const pending = await this.pendingForJourney(journeyId);
      if (!pending.length) return rows;
      return rows.map((r) => {
        const taken = new Map(r.stages.filter((c) => c.status === 'taken').map((c) => [c.stage, c.attendance_id]));
        const mine = new Map(pending.filter((p) => p.employee_id === r.employee_id && !taken.has(p.stage)).map((p) => [p.stage, p.id]));
        return mine.size ? { ...r, ...attendanceCells(taken, mine) } : r;
      });
    },

    async countOn(divisionId, date) {
      const [row] = await db.query(
        `SELECT COUNT(*) AS n FROM attendance_records WHERE division_id = ? AND captured_on = ? AND ${LIVE}`,
        [divisionId, date],
      );
      return row.n;
    },
  };
}
