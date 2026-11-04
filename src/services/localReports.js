// CP-11 reports calculated from the records stored on this device, in the response shapes of the FastAPI
// report endpoints (backend app/services/reports.py; the formulas below mirror it line for line).
//
// These figures are only as complete as the device's data: records captured on other devices appear only
// after they are synchronized here. The Reports screen says so whenever it shows a local calculation.
//
// Scope, as on the server: divisions where the user holds reports.read (narrowed to division_id). Records
// rejected by the server are excluded, and on a shared device another user's unsynced records are never
// counted (they exist only on this device, under that user's ownership).
import { ApiError } from './apiClient.js';
import { daysBetween, istDate } from '../utils/businessDate.js';

const LIVE = "sync_status NOT IN ('rejected', 'conflict')";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round = (v, n) => (v == null ? null : Math.round(v * 10 ** n) / 10 ** n);
const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

// Backend _range: ascending and at most one year.
export function checkRange(from, to) {
  if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) throw new ApiError(422, 'validation_error', 'date_from and date_to are required (YYYY-MM-DD).');
  const span = daysBetween(from, to);
  if (span < 0 || span > 366) throw new ApiError(422, 'business_rule', 'Date range must be ascending and at most one year');
}

// IST business date of a record's timestamp (server_timestamp once synced, else the device time).
const dateOf = (r, ...fields) => {
  const v = fields.map((f) => r[f]).find(Boolean);
  try {
    return v ? istDate(v) : null;
  } catch {
    return null;
  }
};
const inRange = (d, from, to) => d != null && d >= from && d <= to;

export function createLocalReports(db) {
  // Only synced records, or unsynced ones owned by the signed-in user.
  // `ownerCol` may be table-qualified ('a.recorded_by_id'); sync_status takes the same qualifier.
  const visible = (ownerCol) => {
    const alias = ownerCol.includes('.') ? `${ownerCol.split('.')[0]}.` : '';
    return `(${alias}sync_status = 'synced' OR ${ownerCol} = ?)`;
  };

  async function attendance({ divisions, userId, from, to, groupBy = 'employee' }) {
    if (groupBy !== 'employee' && groupBy !== 'journey') throw new ApiError(422, 'business_rule', 'group_by must be employee or journey');
    const rows = await db.query(
      `SELECT a.*, u.name AS emp_name, u.emp_id, j.train_no, j.journey_date
       FROM attendance_records a LEFT JOIN user_profiles u ON u.id = a.employee_id JOIN journeys j ON j.id = a.journey_id
       WHERE a.division_id IN (${marks(divisions.length)}) AND a.${LIVE} AND ${visible('a.recorded_by_id')}`,
      [...divisions, userId],
    );
    const groups = new Map();
    for (const r of rows) {
      // Server-ingested slots may lack device_timestamp; captured_on is the IST date of the capture.
      if (!inRange(r.captured_on ?? dateOf(r, 'device_timestamp', 'server_timestamp'), from, to)) continue;
      const key = groupBy === 'employee' ? r.employee_id : r.journey_id;
      if (!groups.has(key)) {
        groups.set(key, {
          key_id: key,
          label: groupBy === 'employee' ? `${r.emp_name ?? 'Unknown'} (${r.emp_id ?? '—'})` : `${r.train_no} / ${r.journey_date}`,
          sort: groupBy === 'employee' ? [r.emp_name ?? '', r.emp_id ?? ''] : [r.journey_date, r.train_no],
          journeys: new Set(), records: 0, stages: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, verified: 0, rejected: 0,
        });
      }
      const g = groups.get(key);
      g.journeys.add(r.journey_id);
      g.records += 1;
      g.stages[r.stage] += 1;
      if (r.verification_status === 'verified') g.verified += 1;
      if (r.verification_status === 'rejected') g.rejected += 1;
    }
    return [...groups.values()]
      .sort((a, b) => a.sort[0].localeCompare(b.sort[0]) || a.sort[1].localeCompare(b.sort[1]))
      .map(({ sort, journeys, ...g }) => ({ ...g, journeys: journeys.size }));
  }

  // Journeys of the divisions that overlap the period (backend _journeys_in), excluding cancelled ones.
  const journeysIn = (divisions, from, to, { cancelled = false } = {}) => db.query(
    `SELECT * FROM journeys WHERE division_id IN (${marks(divisions.length)}) AND journey_date <= ? AND end_date >= ?
     ${cancelled ? '' : "AND status != 'cancelled'"} ORDER BY journey_date, train_no`,
    [...divisions, to, from],
  );

  async function inspections({ divisions, userId, from, to, coachWise = false }) {
    const journeys = await journeysIn(divisions, from, to);
    if (!journeys.length) return [];
    const ids = journeys.map((j) => j.id);
    const [coaches, done] = await Promise.all([
      db.query(`SELECT journey_id, code, position FROM journey_coaches WHERE journey_id IN (${marks(ids.length)}) ORDER BY position`, ids),
      db.query(
        `SELECT journey_id, coach_code, COUNT(*) AS done, SUM(verification_status = 'verified') AS verified,
                SUM(verification_status = 'rejected') AS rejected
         FROM inspection_records WHERE journey_id IN (${marks(ids.length)}) AND ${LIVE} AND ${visible('inspector_id')}
         GROUP BY journey_id, coach_code`,
        [...ids, userId],
      ),
    ]);
    const doneOf = new Map(done.map((d) => [`${d.journey_id}:${d.coach_code}`, d]));
    const out = [];
    for (const j of journeys) {
      const required = j.operational_days * j.inspection_rounds_per_day * (Number(!!j.before_inspection_enabled) + Number(!!j.after_inspection_enabled));
      const rows = coaches.filter((c) => c.journey_id === j.id).map((c) => {
        const d = doneOf.get(`${j.id}:${c.code}`);
        return { coach_code: c.code, required, done: d?.done ?? 0, verified: d?.verified ?? 0, rejected: d?.rejected ?? 0 };
      });
      const base = { journey_id: j.id, train_no: j.train_no, journey_date: j.journey_date };
      if (coachWise) {
        for (const r of rows) out.push({ ...base, ...r, completion_pct: r.required ? round((100 * r.done) / r.required, 2) : null });
      } else if (rows.length) {
        const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
        const req = sum('required');
        out.push({ ...base, coach_code: null, required: req, done: sum('done'), completion_pct: req ? round((100 * sum('done')) / req, 2) : null, verified: sum('verified'), rejected: sum('rejected') });
      }
    }
    return out;
  }

  const FEEDBACK = {
    passenger: { table: 'passenger_feedback', ratings: 'passenger_feedback_ratings', owner: 'collected_by_id' },
    railway: { table: 'railway_feedback', ratings: 'railway_feedback_ratings', owner: 'submitted_by_id' },
  };

  // Backend _bank_for: the bank given, or the single bank used in these divisions.
  async function bankFor(divisions, audience, bankId) {
    if (bankId) {
      const [bank] = await db.query('SELECT * FROM question_banks WHERE id = ?', [bankId]);
      if (!bank || bank.audience !== audience || (bank.division_id && !divisions.includes(bank.division_id))) {
        throw new ApiError(422, 'business_rule', 'Question bank not available');
      }
      return bank;
    }
    const used = await db.query(
      `SELECT DISTINCT bank_id FROM ${FEEDBACK[audience].table} WHERE bank_id IS NOT NULL AND division_id IN (${marks(divisions.length)})`, divisions,
    );
    if (used.length > 1) throw new ApiError(422, 'bank_required', 'Several question banks are in use; pass bank_id', used.map((u) => u.bank_id));
    if (!used.length) return null;
    const [bank] = await db.query('SELECT * FROM question_banks WHERE id = ?', [used[0].bank_id]);
    return bank ?? null;
  }

  const questionsOf = (bankId) => db.query('SELECT * FROM feedback_questions WHERE bank_id = ? ORDER BY position', [bankId]);

  async function feedbackRows(audience, divisions, userId, journeyId) {
    const { table, owner } = FEEDBACK[audience];
    return db.query(
      `SELECT * FROM ${table} WHERE division_id IN (${marks(divisions.length)}) AND ${LIVE} AND ${visible(owner)}
       ${journeyId ? 'AND journey_id = ?' : ''}`,
      [...divisions, userId, ...(journeyId ? [journeyId] : [])],
    );
  }

  async function ratingStats(audience, ids) {
    if (!ids.length) return new Map();
    const rows = await db.query(
      `SELECT question_id, COUNT(*) AS n, AVG(value) AS avg FROM ${FEEDBACK[audience].ratings}
       WHERE feedback_id IN (${marks(ids.length)}) GROUP BY question_id`, ids,
    );
    return new Map(rows.map((r) => [r.question_id, r]));
  }

  async function feedback({ audience, divisions, userId, from, to, journeyId, bankId }) {
    if (!FEEDBACK[audience]) throw new ApiError(422, 'validation_error', 'audience must be passenger or railway');
    const bank = await bankFor(divisions, audience, bankId);
    const rows = (await feedbackRows(audience, divisions, userId, journeyId))
      .filter((r) => inRange(dateOf(r, 'server_timestamp', 'device_timestamp', 'created_at'), from, to));
    const byStatus = {};
    const byClass = {};
    let counted;
    if (audience === 'passenger') {
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      counted = rows.filter((r) => r.status === 'completed');
      for (const r of counted) if (r.coach_class) byClass[r.coach_class] = (byClass[r.coach_class] ?? 0) + 1;
    } else {
      // Server verification state where this device has received it (backend keys: submitted / verified /
      // rejected). Records not yet on the server count as not_synced; synced records whose status was
      // never received as status_unknown. Counted like the server: everything except rejected.
      for (const r of rows) {
        const k = r.sync_status !== 'synced' ? 'not_synced' : r.verification_status ?? 'status_unknown';
        byStatus[k] = (byStatus[k] ?? 0) + 1;
      }
      counted = rows.filter((r) => r.verification_status !== 'rejected');
    }
    const questions = [];
    if (bank) {
      const stats = await ratingStats(audience, counted.filter((r) => r.bank_id === bank.id).map((r) => r.id));
      for (const q of await questionsOf(bank.id)) {
        const s = stats.get(q.id);
        questions.push({ question_id: q.id, position: q.position, text_en: q.text_en, responses: s?.n ?? 0, average: s ? round(s.avg, 3) : null });
      }
    }
    return {
      audience, bank_id: bank?.id ?? null, scale_min: bank?.scale_min ?? null, scale_max: bank?.scale_max ?? null,
      total: rows.length, by_status: byStatus, by_coach_class: byClass, questions,
    };
  }

  // Backend psi_report: sum(w * (avg - min) / (max - min)) / sum(w) * 100 per journey, completed feedback only.
  async function psi({ divisions, userId, from, to, bankId }) {
    const bank = await bankFor(divisions, 'passenger', bankId);
    if (!bank) return [];
    const questions = await questionsOf(bank.id);
    if (!questions.length || questions.some((q) => q.psi_weight == null)) {
      throw new ApiError(409, 'psi_not_configured', 'PSI weights are not configured for this question bank');
    }
    const weight = new Map(questions.map((q) => [q.id, q.psi_weight]));
    const span = bank.scale_max - bank.scale_min;
    const done = (await feedbackRows('passenger', divisions, userId))
      .filter((f) => f.bank_id === bank.id && f.status === 'completed' && inRange(f.feedback_date, from, to));
    const byJourney = new Map();
    for (const f of done) byJourney.set(f.journey_id, [...(byJourney.get(f.journey_id) ?? []), f.id]);
    const out = [];
    for (const [journeyId, ids] of byJourney) {
      const per = await db.query(
        `SELECT question_id, AVG(value) AS avg FROM passenger_feedback_ratings WHERE feedback_id IN (${marks(ids.length)}) GROUP BY question_id`, ids,
      );
      const rated = per.filter((p) => weight.has(p.question_id));
      if (!rated.length) continue;
      const w = rated.reduce((n, p) => n + weight.get(p.question_id), 0);
      const score = (rated.reduce((n, p) => n + (weight.get(p.question_id) * (p.avg - bank.scale_min)) / span, 0) / w) * 100;
      const [j] = await db.query('SELECT train_no, journey_date FROM journeys WHERE id = ?', [journeyId]);
      out.push({ journey_id: journeyId, train_no: j?.train_no ?? null, journey_date: j?.journey_date ?? null, responses: ids.length, psi: round(score, 2) });
    }
    return out.sort((a, b) => String(a.journey_date).localeCompare(String(b.journey_date)));
  }

  async function complaints({ divisions, userId, from, to, nowIso }) {
    const rows = (await db.query(
      `SELECT c.*, k.name AS category_name FROM complaints c JOIN complaint_categories k ON k.id = c.category_id
       WHERE c.division_id IN (${marks(divisions.length)}) AND c.${LIVE} AND ${visible('c.created_by_id')}`,
      [...divisions, userId],
    )).filter((c) => inRange(dateOf(c, 'server_timestamp', 'device_timestamp', 'created_at'), from, to));
    const byStatus = {};
    const cats = new Map();
    let overdue = 0;
    const hours = [];
    for (const c of rows) {
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      const open = c.status !== 'completed';
      if (open && c.due_at && c.due_at < nowIso) overdue += 1;
      const k = cats.get(c.category_id) ?? { category_id: c.category_id, category: c.category_name, total: 0, open: 0 };
      k.total += 1;
      if (open) k.open += 1;
      cats.set(c.category_id, k);
      if (c.closed_at && c.server_timestamp) hours.push((Date.parse(c.closed_at) - Date.parse(c.server_timestamp)) / 3_600_000);
    }
    return {
      total: rows.length, by_status: byStatus, overdue, by_category: [...cats.values()].sort((a, b) => b.total - a.total),
      avg_resolution_hours: hours.length ? round(hours.reduce((a, b) => a + b, 0) / hours.length, 2) : null,
    };
  }

  async function inventory({ divisions, userId, from, to }) {
    const journeys = await journeysIn(divisions, from, to, { cancelled: true });
    if (!journeys.length) return [];
    const ids = journeys.map((j) => j.id);
    const rows = await db.query(
      `SELECT t.item_id, i.name AS item_name, i.unit,
              SUM(CASE t.txn_type WHEN 'issue' THEN t.quantity ELSE 0 END) AS issued,
              SUM(CASE t.txn_type WHEN 'return' THEN t.quantity ELSE 0 END) AS returned,
              COUNT(DISTINCT t.journey_id) AS journeys
       FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
       WHERE t.journey_id IN (${marks(ids.length)}) AND t.${LIVE} AND (t.sync_status = 'synced' OR t.recorded_by_id = ?)
       GROUP BY t.item_id, i.name, i.unit ORDER BY i.name`,
      [...ids, userId],
    );
    return rows.map((r) => ({ ...r, issued: Number(r.issued), returned: Number(r.returned), consumed: Number(r.issued) - Number(r.returned) }));
  }

  return { attendance, inspections, feedback, psi, complaints, inventory };
}
