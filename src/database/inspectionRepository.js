// Coach inspections, keyed by journey + coach + day + round + phase ('B' Before / 'A' After).
// Rules (backend services/inspections.py): the coach is on the journey, the day is open at capture
// time, rounds are taken in order per phase, and After needs the same round's Before when Before is
// enabled. Uniqueness and ordering are also enforced in SQL (idx_inspection_slot and triggers).
import { journeyDayFor } from '../utils/businessDate.js';
import { LocalRuleError } from './errors.js';
import { optionalText, requireCaptureWindow, requireDeviceTimestamp, requireGps, requireInt, requireUuid } from './captureRules.js';
import { insertStatement, placeholders } from './sqlHelpers.js';

// A local row in the shape of the backend InspectionOut, plus its device/server sync state.
export const inspectionOut = (r) => ({
  id: r.id, journey_id: r.journey_id, division_id: r.division_id, coach_code: r.coach_code, coach_class: r.coach_class, day: r.day,
  round: r.round, phase: r.phase, comments: r.comments, device_timestamp: r.device_timestamp, server_timestamp: r.server_timestamp,
  latitude: r.latitude, longitude: r.longitude, gps_accuracy_m: r.gps_accuracy_m, photo_media_id: r.photo_media_id,
  video_media_id: r.video_media_id, created_by_id: r.inspector_id, verification_status: r.verification_status, review_remarks: null,
  origin: r.origin, sync_status: r.sync_status, last_sync_error: r.last_sync_error,
});

const LIVE = "sync_status NOT IN ('rejected', 'conflict')";
export const PHASES = ['B', 'A'];
const slot = (coach, day, round, phase) => `${coach}|${day}|${round}|${phase}`;

export const enabledPhases = (j) => PHASES.filter((ph) => (ph === 'B' ? j.before_inspection_enabled : j.after_inspection_enabled));

export function dayIsOpen(j, day, today) {
  if (j.status === 'cancelled' || today < j.journey_date || today > j.end_date) return false;
  const current = journeyDayFor(j.journey_date, today);
  return j.daywise ? current === day : day >= 1 && day <= current;
}

// Cells for one coach/day. `taken` and `pending` map slot keys to record ids.
export function inspectionCells(j, coach, day, dayOpen, taken, pending) {
  const has = (k) => taken.has(k) || pending.has(k);
  const cells = [];
  for (let round = 1; round <= j.inspection_rounds_per_day; round += 1) {
    for (const phase of enabledPhases(j)) {
      const key = slot(coach, day, round, phase);
      if (taken.has(key)) {
        cells.push({ round, phase, status: 'taken', inspection_id: taken.get(key) });
      } else if (pending.has(key)) {
        cells.push({ round, phase, status: 'pending', inspection_id: pending.get(key) });
      } else {
        const ready = (round === 1 || has(slot(coach, day, round - 1, phase)))
          && (phase === 'B' || !j.before_inspection_enabled || has(slot(coach, day, round, 'B')));
        cells.push({ round, phase, status: dayOpen && ready ? 'open' : 'locked', inspection_id: null });
      }
    }
  }
  return cells;
}

export function createInspectionRepository(db, { journeys }) {
  async function slots(journeyId) {
    const rows = await db.query(
      `SELECT id, coach_code, day, round, phase, sync_status FROM inspection_records WHERE journey_id = ? AND ${LIVE}`,
      [journeyId],
    );
    const taken = new Map();
    const pending = new Map();
    for (const r of rows) (r.sync_status === 'synced' ? taken : pending).set(slot(r.coach_code, r.day, r.round, r.phase), r.id);
    return { taken, pending };
  }

  return {
    async prepareCapture(p, { actor, policy, nowMs, now, today }) {
      requireUuid(p.id, 'id');
      requireUuid(p.journey_id, 'journey_id');
      const capturedOn = requireDeviceTimestamp(p.device_timestamp, nowMs);
      const gps = requireGps(p);
      const journey = await journeys.get(p.journey_id, today);
      requireCaptureWindow(journey, capturedOn);
      const coach = await journeys.coach(journey.id, p.coach_code);
      if (!coach) throw new LocalRuleError('unknown_coach', 'This coach is not part of the journey.');
      const day = requireInt(p.day, 'day', 1, 30);
      if (day > journey.operational_days) throw new LocalRuleError('day_out_of_range', `Day must be between 1 and ${journey.operational_days}.`);
      if (!dayIsOpen(journey, day, capturedOn)) throw new LocalRuleError('day_not_open', 'Inspection for this day is not open at the capture time.');
      const round = requireInt(p.round, 'round', 1, 20);
      if (round > journey.inspection_rounds_per_day) {
        throw new LocalRuleError('round_out_of_range', `Round must be between 1 and ${journey.inspection_rounds_per_day}.`);
      }
      if (!enabledPhases(journey).includes(p.phase)) throw new LocalRuleError('phase_disabled', `Phase ${p.phase} inspections are disabled for this journey.`);
      if (policy.inspection_photo_required && !p.photo_media_id) {
        throw new LocalRuleError('photo_required', 'A photograph is required for the inspection.');
      }
      const { taken, pending } = await slots(journey.id);
      const has = (r, ph) => taken.has(slot(coach.code, day, r, ph)) || pending.has(slot(coach.code, day, r, ph));
      if (has(round, p.phase)) throw new LocalRuleError('duplicate_inspection', 'This coach, day, round and phase is already inspected.');
      if (round > 1 && !has(round - 1, p.phase)) throw new LocalRuleError('round_order', `Round ${round - 1} (${p.phase}) must be recorded first.`);
      if (p.phase === 'A' && journey.before_inspection_enabled && !has(round, 'B')) {
        throw new LocalRuleError('phase_order', 'The Before inspection of this round must be recorded first.');
      }
      const row = {
        id: p.id, journey_id: journey.id, division_id: journey.division_id, coach_code: coach.code, coach_class: coach.classification,
        day, round, phase: p.phase, ...gps, device_timestamp: p.device_timestamp, captured_on: capturedOn,
        photo_media_id: p.photo_media_id ?? null, video_media_id: p.video_media_id ?? null,
        comments: optionalText(p.comments, 'comments', 2000), completion_status: 'completed', inspector_id: actor?.id ?? null,
        origin: 'local', sync_status: 'pending', created_at: now, updated_at: now,
      };
      return { row, divisionId: journey.division_id, statements: [insertStatement('inspection_records', row)] };
    },

    // Server-confirmed cells from GET /inspections/journeys/{id}/status.
    serverStatements(journey, grid, now) {
      return grid.flatMap((c) => c.cells.filter((x) => x.status === 'taken' && x.inspection_id).map((x) => insertStatement('inspection_records', {
        id: x.inspection_id, journey_id: journey.id, division_id: journey.division_id, coach_code: c.coach_code, day: c.day,
        round: x.round, phase: x.phase, origin: 'server', sync_status: 'synced', synced_at: now, created_at: now, updated_at: now,
      }, { orIgnore: true })));
    },

    async get(id) {
      const [r] = await db.query('SELECT * FROM inspection_records WHERE id = ?', [id]);
      return r ?? null;
    },

    async listForJourney(journeyId) {
      return db.query('SELECT * FROM inspection_records WHERE journey_id = ? ORDER BY day, coach_code, round, phase', [journeyId]);
    },

    // Records in `divisions` (GET /inspections filters) in coach/day/round/phase order, as inspectionOut().
    async listRecords({ divisions = [], journeyId, coachCode, day, phase, verificationStatus } = {}) {
      if (!divisions.length) return [];
      const rows = await db.query(
        `SELECT * FROM inspection_records WHERE division_id IN (${placeholders(divisions)})
           AND (? IS NULL OR journey_id = ?) AND (? IS NULL OR coach_code = ?) AND (? IS NULL OR day = ?)
           AND (? IS NULL OR phase = ?) AND (? IS NULL OR verification_status = ?)
         ORDER BY journey_id, day, coach_code, round, CASE phase WHEN 'B' THEN 0 ELSE 1 END`,
        [...divisions, journeyId ?? null, journeyId ?? null, coachCode ?? null, coachCode ?? null, day ?? null, day ?? null,
          phase ?? null, phase ?? null, verificationStatus ?? null, verificationStatus ?? null],
      );
      return rows.map(inspectionOut);
    },

    // Same shape as GET /inspections/journeys/{id}/status, plus 'pending' cells.
    async journeyGrid(journey, today) {
      const { taken, pending } = await slots(journey.id);
      const out = [];
      for (const coach of journey.coaches) {
        for (let day = 1; day <= journey.operational_days; day += 1) {
          const open = dayIsOpen(journey, day, today);
          const cells = inspectionCells(journey, coach.code, day, open, taken, pending);
          out.push({
            coach_code: coach.code, day, day_open: open, required: cells.length,
            done: cells.filter((x) => x.status === 'taken').length, cells,
          });
        }
      }
      return out;
    },

    // Adds this device's unsynced inspections to a server grid response.
    async overlayGrid(journey, grid) {
      const { pending } = await slots(journey.id);
      if (!pending.size) return grid;
      return grid.map((c) => {
        const taken = new Map(c.cells.filter((x) => x.status === 'taken').map((x) => [slot(c.coach_code, c.day, x.round, x.phase), x.inspection_id]));
        const mine = new Map([...pending].filter(([k]) => k.startsWith(`${c.coach_code}|${c.day}|`) && !taken.has(k)));
        if (!mine.size) return c;
        const cells = inspectionCells(journey, c.coach_code, c.day, c.day_open, taken, mine);
        return { ...c, cells };
      });
    },

    async countOn(divisionId, date) {
      const [row] = await db.query(
        `SELECT COUNT(*) AS n FROM inspection_records WHERE division_id = ? AND captured_on = ? AND ${LIVE}`,
        [divisionId, date],
      );
      return row.n;
    },
  };
}
