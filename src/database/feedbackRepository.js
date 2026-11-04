// Passenger and railway-official feedback.
//
// Passenger feedback is captured in two parts. The details (journey, coach, seat, PNR, mobile) can be
// captured offline and are queued as 'feedback.passenger.start'. PNR validation and OTP delivery are
// server integrations: offline they stay in their pending state (pnr_status 'pending', otp_status
// 'not_sent') and only the server ever changes them. Ratings for passengers follow OTP verification,
// so they are online-only. Railway feedback (ratings included) is captured fully offline.
//
// Questions come from the journey division's active bank, falling back to the global default bank.
import { istDate } from '../utils/businessDate.js';
import { LocalRuleError } from './errors.js';
import {
  MOBILE_RE, PNR_RE, optionalText, requireCaptureWindow, requireDeviceTimestamp, requireGps, requireInt, requireText, requireUuid,
} from './captureRules.js';
import { insertStatement, placeholders } from './sqlHelpers.js';

const LIVE = "sync_status NOT IN ('rejected', 'conflict')";

export const maskMobile = (m) => (m ? `${m.slice(0, 2)}XXXXX${m.slice(-3)}` : null);

// Questions of a bank that apply to a coach class (backend feedback.applicable).
export const applicableQuestions = (bank, coachClass) => (bank?.questions ?? [])
  .filter((q) => (coachClass == null ? true : coachClass === 'AC' ? q.applies_ac : q.applies_non_ac));

function validateRatings(bank, coachClass, ratings) {
  if (!Array.isArray(ratings) || ratings.length < 1 || ratings.length > 20) {
    throw new LocalRuleError('invalid_value', 'Between 1 and 20 ratings are required.');
  }
  const ids = ratings.map((r) => r.question_id);
  if (new Set(ids).size !== ids.length) throw new LocalRuleError('invalid_value', 'Each question can be rated once.');
  const questions = new Map(applicableQuestions(bank, coachClass).map((q) => [q.id, q]));
  const unknown = ids.filter((id) => !questions.has(id));
  if (unknown.length) throw new LocalRuleError('invalid_question', 'Ratings were given for questions that do not apply.', unknown);
  const missing = [...questions.values()].filter((q) => q.required && !ids.includes(q.id)).map((q) => q.id);
  if (missing.length) throw new LocalRuleError('missing_required', 'All required questions must be rated.', missing);
  for (const r of ratings) {
    if (!Number.isInteger(r.value) || r.value < bank.scale_min || r.value > bank.scale_max) {
      throw new LocalRuleError('invalid_value', `Ratings must be from ${bank.scale_min} to ${bank.scale_max}.`);
    }
  }
}

const passengerOut = (f, ratings = []) => ({
  id: f.id, journey_id: f.journey_id, division_id: f.division_id, bank_id: f.bank_id, coach_code: f.coach_code,
  coach_class: f.coach_class, journey_day: f.journey_day, feedback_date: f.feedback_date, passenger_name: f.passenger_name,
  mobile_masked: f.mobile_masked, pnr: f.pnr, seat_no: f.seat_no, status: f.status, pnr_status: f.pnr_status,
  otp_status: f.otp_status, void_reason: f.void_reason, comments: f.comments, voice_media_id: f.voice_media_id,
  ratings: ratings.map(({ question_id, value }) => ({ question_id, value })), collected_by_id: f.collected_by_id,
  device_timestamp: f.device_timestamp, server_timestamp: f.server_timestamp, verified_at: f.verified_at,
  completed_at: f.completed_at, sync_status: f.sync_status, last_sync_error: f.last_sync_error,
});

const istDateOrNull = (ts) => {
  try {
    return istDate(ts);
  } catch {
    return null;
  }
};

export function createFeedbackRepository(db, { journeys, masters }) {
  async function capturedJourney(p, ctx) {
    requireUuid(p.id, 'id');
    requireUuid(p.journey_id, 'journey_id');
    const capturedOn = requireDeviceTimestamp(p.device_timestamp, ctx.nowMs);
    const gps = requireGps(p);
    const journey = await journeys.get(p.journey_id, ctx.today);
    requireCaptureWindow(journey, capturedOn);
    return { journey, capturedOn, gps, journeyDay: requireInt(p.journey_day, 'journey_day', 1, 30) };
  }

  async function ratingsOf(table, ids) {
    if (!ids.length) return [];
    return db.query(`SELECT * FROM ${table} WHERE feedback_id IN (${placeholders(ids)})`, ids);
  }

  return {
    async questionsFor({ journeyId, coachCode, audience = 'passenger', today }) {
      const journey = await journeys.get(journeyId, today);
      if (!journey) throw new LocalRuleError('journey_not_found', 'This journey is not available on this device.');
      const bank = await masters.activeBank(journey.division_id, audience);
      if (!bank) throw new LocalRuleError('no_question_bank', `No active ${audience} question bank is available on this device.`);
      const coach = coachCode ? await journeys.coach(journeyId, coachCode) : null;
      return { bank, questions: applicableQuestions(bank, coach?.classification ?? null) };
    },

    async preparePassengerStart(p, ctx) {
      const { journey, capturedOn, gps, journeyDay } = await capturedJourney(p, ctx);
      const coach = await journeys.coach(journey.id, p.coach_code);
      if (!coach) throw new LocalRuleError('unknown_coach', 'This coach is not part of the journey.');
      const name = requireText(p.passenger_name, 'Passenger name', 2, 100);
      if (!MOBILE_RE.test(p.mobile ?? '')) throw new LocalRuleError('invalid_mobile', 'Enter a valid 10-digit Indian mobile number.');
      const pnr = p.pnr || null;
      if (pnr && !PNR_RE.test(pnr)) throw new LocalRuleError('invalid_pnr', 'PNR must be 10 digits.');
      if (ctx.policy.passenger_pnr_required && !pnr) throw new LocalRuleError('pnr_required', 'PNR is required in this division.');
      const bank = await masters.activeBank(journey.division_id, 'passenger');
      const row = {
        id: p.id, journey_id: journey.id, division_id: journey.division_id, bank_id: bank?.id ?? null, coach_code: coach.code,
        coach_class: coach.classification, journey_day: journeyDay, feedback_date: capturedOn, passenger_name: name,
        mobile: p.mobile, mobile_masked: maskMobile(p.mobile), pnr, seat_no: optionalText(p.seat_no, 'Seat', 10),
        status: 'draft',
        pnr_status: ctx.policy.passenger_pnr_required ? 'pending' : 'not_required',
        otp_status: ctx.policy.passenger_otp_required ? 'not_sent' : 'not_required',
        ...gps, device_timestamp: p.device_timestamp, collected_by_id: ctx.actor?.id ?? null,
        origin: 'local', sync_status: 'pending', created_at: ctx.now, updated_at: ctx.now,
      };
      return { row, divisionId: journey.division_id, statements: [insertStatement('passenger_feedback', row)] };
    },

    async prepareRailway(p, ctx) {
      const { journey, capturedOn, gps, journeyDay } = await capturedJourney(p, ctx);
      const coach = p.coach_code ? await journeys.coach(journey.id, p.coach_code) : null;
      if (p.coach_code && !coach) throw new LocalRuleError('unknown_coach', 'This coach is not part of the journey.');
      const bank = await masters.activeBank(journey.division_id, 'railway');
      if (!bank) throw new LocalRuleError('no_question_bank', 'No active railway question bank is available on this device.');
      validateRatings(bank, coach?.classification ?? null, p.ratings);
      const limit = ctx.policy.railway_feedback_limit_per_journey;
      // backend create_railway: rejected feedback does not count towards the limit
      const [{ n }] = await db.query(
        `SELECT COUNT(*) AS n FROM railway_feedback WHERE journey_id = ? AND ${LIVE} AND verification_status IS NOT 'rejected'`, [journey.id],
      );
      if (limit != null && n >= limit) throw new LocalRuleError('railway_feedback_limit', `At most ${limit} railway feedback entries are allowed per journey.`);
      const row = {
        id: p.id, journey_id: journey.id, division_id: journey.division_id, bank_id: bank.id, coach_code: coach?.code ?? null,
        journey_day: journeyDay, feedback_date: capturedOn,
        railway_employee_id: requireText(p.railway_employee_id, 'Railway employee ID', 2, 32),
        official_name: requireText(p.official_name, 'Official name', 2, 100),
        designation: optionalText(p.designation, 'Designation', 100), comments: optionalText(p.comments, 'Comments', 2000),
        ...gps, device_timestamp: p.device_timestamp, submitted_by_id: ctx.actor?.id ?? null,
        origin: 'local', sync_status: 'pending', created_at: ctx.now, updated_at: ctx.now,
      };
      return {
        row,
        divisionId: journey.division_id,
        statements: [
          insertStatement('railway_feedback', row),
          ...p.ratings.map((r) => insertStatement('railway_feedback_ratings', { feedback_id: row.id, question_id: r.question_id, value: r.value })),
        ],
      };
    },

    // Server state for a passenger record (GET /feedback/passenger[/{id}]). The full mobile number
    // captured on this device is kept; the server only returns the masked form.
    passengerServerStatements(f, now) {
      return [
        {
          sql: `INSERT INTO passenger_feedback (id, journey_id, division_id, bank_id, coach_code, coach_class, journey_day, feedback_date,
                  passenger_name, mobile_masked, pnr, seat_no, status, pnr_status, otp_status, void_reason, comments, voice_media_id,
                  device_timestamp, collected_by_id, verified_at, completed_at, origin, server_timestamp, synced_at, sync_status,
                  created_at, updated_at)
                VALUES (?, ?, ?, (SELECT id FROM question_banks WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?,
                  'server', ?, ?, 'synced', ?, ?)
                ON CONFLICT(id) DO UPDATE SET bank_id = excluded.bank_id, status = excluded.status, pnr_status = excluded.pnr_status,
                  otp_status = excluded.otp_status, void_reason = excluded.void_reason, comments = excluded.comments,
                  mobile_masked = excluded.mobile_masked, verified_at = excluded.verified_at, completed_at = excluded.completed_at,
                  server_timestamp = excluded.server_timestamp, sync_status = 'synced', synced_at = excluded.synced_at,
                  last_sync_error = NULL, updated_at = excluded.updated_at`,
          params: [
            f.id, f.journey_id, f.division_id, f.bank_id ?? null, f.coach_code, f.coach_class ?? null, f.journey_day, f.feedback_date ?? null,
            f.passenger_name, f.mobile_masked ?? null, f.pnr ?? null, f.seat_no ?? null, f.status, f.pnr_status, f.otp_status,
            f.void_reason ?? null, f.comments ?? null, f.device_timestamp ?? null, f.collected_by_id ?? null, f.verified_at ?? null,
            f.completed_at ?? null, f.server_timestamp ?? null, now, now, now,
          ],
        },
        // Ratings for questions this device has not pulled are skipped rather than failing the batch.
        ...(f.ratings ?? []).map((r) => ({
          sql: `INSERT OR IGNORE INTO passenger_feedback_ratings (feedback_id, question_id, value)
                SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM feedback_questions WHERE id = ?)`,
          params: [f.id, r.question_id, r.value, r.question_id],
        })),
      ];
    },

    async getPassenger(id) {
      const [f] = await db.query('SELECT * FROM passenger_feedback WHERE id = ?', [id]);
      if (!f) return null;
      return passengerOut(f, await ratingsOf('passenger_feedback_ratings', [id]));
    },

    async listPassenger({ divisionId, divisions, journeyId, status } = {}) {
      const scope = divisionId ? [divisionId] : divisions;
      const rows = await db.query(
        `SELECT * FROM passenger_feedback
         WHERE ${scope ? (scope.length ? `division_id IN (${placeholders(scope)})` : '0') : '1'}
           AND (? IS NULL OR journey_id = ?) AND (? IS NULL OR status = ?)
         ORDER BY COALESCE(device_timestamp, created_at) DESC`,
        [...(scope ?? []), journeyId ?? null, journeyId ?? null, status ?? null, status ?? null],
      );
      const ratings = await ratingsOf('passenger_feedback_ratings', rows.map((r) => r.id));
      return rows.map((f) => passengerOut(f, ratings.filter((r) => r.feedback_id === f.id)));
    },

    async listPendingPassenger() {
      return (await this.listPassenger()).filter((f) => f.sync_status === 'pending');
    },

    // Server railway feedback (GET /feedback/railway items, POST .../review results). A record this device
    // does not hold is stored as synced. The verification state is applied only when it is not older than
    // the stored one (verified_at; an unreviewed 'submitted' never replaces a review). A record still
    // pending on this device keeps its sync state: only the outbox acknowledgement changes that.
    railwayServerStatements(f, now) {
      const status = ['submitted', 'verified', 'rejected'].includes(f.verification_status) ? f.verification_status : null;
      return [
        {
          sql: `INSERT INTO railway_feedback (id, journey_id, division_id, bank_id, coach_code, journey_day, feedback_date, railway_employee_id,
                  official_name, designation, comments, device_timestamp, submitted_by_id, verification_status, verified_at, verified_by_id,
                  status_observed_at, origin, server_timestamp, synced_at, sync_status, created_at, updated_at)
                VALUES (?, ?, ?, (SELECT id FROM question_banks WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server', ?, ?, 'synced', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  verification_status = excluded.verification_status, verified_at = excluded.verified_at,
                  verified_by_id = excluded.verified_by_id, status_observed_at = excluded.status_observed_at,
                  server_timestamp = COALESCE(excluded.server_timestamp, railway_feedback.server_timestamp), updated_at = excluded.updated_at
                WHERE excluded.verification_status IS NOT NULL AND (
                  railway_feedback.verification_status IS NULL
                  OR (excluded.verified_at IS NOT NULL AND (railway_feedback.verified_at IS NULL OR excluded.verified_at >= railway_feedback.verified_at))
                  OR (excluded.verified_at IS NULL AND railway_feedback.verified_at IS NULL))`,
          params: [
            f.id, f.journey_id, f.division_id, f.bank_id ?? null, f.coach_code ?? null, f.journey_day,
            f.device_timestamp ? istDateOrNull(f.device_timestamp) : null, f.railway_employee_id, f.official_name, f.designation ?? null,
            f.comments ?? null, f.device_timestamp ?? null, f.created_by_id ?? null, status, f.verified_at ?? null, f.verified_by_id ?? null,
            now, f.server_timestamp ?? null, now, now, now,
          ],
        },
        ...(f.ratings ?? []).map((r) => ({
          sql: `INSERT OR IGNORE INTO railway_feedback_ratings (feedback_id, question_id, value)
                SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM feedback_questions WHERE id = ?)`,
          params: [f.id, r.question_id, r.value, r.question_id],
        })),
      ];
    },

    async getRailway(id) {
      const [f] = await db.query('SELECT * FROM railway_feedback WHERE id = ?', [id]);
      if (!f) return null;
      const ratings = await ratingsOf('railway_feedback_ratings', [id]);
      return { ...f, ratings: ratings.map(({ question_id, value }) => ({ question_id, value })) };
    },

    async listRailway({ divisionId, divisions, journeyId } = {}) {
      const scope = divisionId ? [divisionId] : divisions;
      const rows = await db.query(
        `SELECT * FROM railway_feedback WHERE ${scope ? (scope.length ? `division_id IN (${placeholders(scope)})` : '0') : '1'}
           AND (? IS NULL OR journey_id = ?) ORDER BY COALESCE(device_timestamp, created_at) DESC`,
        [...(scope ?? []), journeyId ?? null, journeyId ?? null],
      );
      const ratings = await ratingsOf('railway_feedback_ratings', rows.map((r) => r.id));
      // created_by_id: the backend RailwayFeedbackOut name for the submitter.
      return rows.map((f) => ({
        ...f, created_by_id: f.submitted_by_id, verification_status: f.verification_status ?? null, verified_at: f.verified_at ?? null,
        ratings: ratings.filter((r) => r.feedback_id === f.id).map(({ question_id, value }) => ({ question_id, value })),
      }));
    },

    async countOn(table, divisionId, date) {
      if (table !== 'passenger_feedback' && table !== 'railway_feedback') throw new Error(`Unknown feedback table ${table}`);
      const [row] = await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE division_id = ? AND feedback_date = ? AND ${LIVE}`, [divisionId, date]);
      return row.n;
    },
  };
}
