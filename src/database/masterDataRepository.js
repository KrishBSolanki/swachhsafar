// Master data pulled from the server: divisions, operating policies, trains and coaches, question
// banks, inventory items and complaint departments/categories. Reads return the same shapes as the
// FastAPI endpoints so screens can use either source.
import { bool, fromBool, insertStatement, parseJson, placeholders, upsertStatement } from './sqlHelpers.js';

// Backend PolicySettings defaults (app/schemas/policy.py): the strict choice unless a division relaxes it.
export const DEFAULT_POLICY = Object.freeze({
  passenger_pnr_required: true,
  passenger_otp_required: true,
  pnr_train_day_mapping: false,
  pnr_coach_match_required: true,
  passenger_feedback_per_coach_day: null,
  railway_feedback_limit_per_journey: 2,
  attendance_photo_required: true,
  attendance_late_grace_days: 1,
  inspection_photo_required: true,
  complaint_default_sla_hours: 72,
});

const synced = (row, now) => ({ sync_status: 'synced', server_updated_at: row.updated_at ?? null, created_at: now, updated_at: now });

const trainOut = (t, coaches) => ({
  id: t.id, division_id: t.division_id, train_no: t.train_no, name: t.name, linked_train_id: t.linked_train_id,
  duration_days: t.duration_days, operational_days: t.operational_days, start_time: t.start_time, end_time: t.end_time,
  return_start_time: t.return_start_time, return_end_time: t.return_end_time, daywise: fromBool(t.daywise),
  inspection_rounds_per_day: t.inspection_rounds_per_day, before_inspection_enabled: fromBool(t.before_inspection_enabled),
  after_inspection_enabled: fromBool(t.after_inspection_enabled), is_active: fromBool(t.is_active),
  coaches: coaches.map(({ code, classification, position }) => ({ code, classification, position })),
  updated_at: t.server_updated_at ?? t.updated_at,
});

const questionOut = (q) => ({
  id: q.id, position: q.position, text_en: q.text_en, text_hi: q.text_hi, applies_ac: fromBool(q.applies_ac),
  applies_non_ac: fromBool(q.applies_non_ac), required: fromBool(q.required), psi_weight: q.psi_weight,
});

export function createMasterDataRepository(db) {
  async function questionsFor(bankIds) {
    if (!bankIds.length) return {};
    const rows = await db.query(
      `SELECT * FROM feedback_questions WHERE is_active = 1 AND bank_id IN (${placeholders(bankIds)}) ORDER BY position`,
      bankIds,
    );
    const out = {};
    for (const q of rows) (out[q.bank_id] ??= []).push(questionOut(q));
    return out;
  }

  async function bankRows(rows) {
    const questions = await questionsFor(rows.map((b) => b.id));
    return rows.map((b) => ({
      id: b.id, division_id: b.division_id, audience: b.audience, name: b.name, scale_min: b.scale_min,
      scale_max: b.scale_max, is_active: fromBool(b.is_active), questions: questions[b.id] ?? [],
      updated_at: b.server_updated_at ?? b.updated_at,
    }));
  }

  return {
    // ---- statements for ingestion (run inside the caller's transaction) ----
    divisionStatements(d, now) {
      return [upsertStatement('divisions', {
        id: d.id, code: d.code ?? '', name: d.name, is_active: bool(d.is_active ?? true), is_placeholder: 0, ...synced(d, now),
      })];
    },

    // Referenced before its details are known (e.g. from an authorization snapshot). A later pull fills it in.
    ensureDivisionStatement(id, now) {
      return insertStatement('divisions', {
        id, code: '', name: `Division ${String(id).slice(0, 8)}`, is_placeholder: 1, ...synced({}, now),
      }, { orIgnore: true });
    },

    policyStatements(divisionId, settings, now) {
      return [upsertStatement('operating_policies', { division_id: divisionId, settings: JSON.stringify(settings ?? {}), ...synced({}, now) }, { key: ['division_id'] })];
    },

    trainStatements(t, now) {
      return [
        upsertStatement('trains', {
          id: t.id, division_id: t.division_id, train_no: t.train_no, name: t.name, linked_train_id: t.linked_train_id ?? null,
          duration_days: t.duration_days ?? 1, operational_days: t.operational_days ?? 1, start_time: t.start_time ?? null,
          end_time: t.end_time ?? null, return_start_time: t.return_start_time ?? null, return_end_time: t.return_end_time ?? null,
          daywise: bool(t.daywise), inspection_rounds_per_day: t.inspection_rounds_per_day ?? 1,
          before_inspection_enabled: bool(t.before_inspection_enabled ?? true), after_inspection_enabled: bool(t.after_inspection_enabled ?? true),
          is_active: bool(t.is_active ?? true), is_placeholder: 0, ...synced(t, now),
        }),
        { sql: 'DELETE FROM train_coaches WHERE train_id = ?', params: [t.id] },
        ...(t.coaches ?? []).map((c, i) => insertStatement('train_coaches', {
          train_id: t.id, code: c.code, classification: c.classification, position: c.position ?? i + 1,
        })),
      ];
    },

    // A journey can reference a train this device has not pulled (e.g. a linked train of another division).
    ensureTrainStatement({ id, division_id, train_no, name }, now) {
      return insertStatement('trains', {
        id, division_id, train_no: train_no ?? '', name: name ?? '', is_placeholder: 1, is_active: 1, ...synced({}, now),
      }, { orIgnore: true });
    },

    // Questions already answered must stay referenceable, so missing ones are deactivated, not deleted.
    bankStatements(b, now) {
      const ids = (b.questions ?? []).map((q) => q.id);
      return [
        upsertStatement('question_banks', {
          id: b.id, division_id: b.division_id ?? null, audience: b.audience, name: b.name, scale_min: b.scale_min,
          scale_max: b.scale_max, is_active: bool(b.is_active), ...synced(b, now),
        }),
        {
          sql: `UPDATE feedback_questions SET is_active = 0 WHERE bank_id = ?${ids.length ? ` AND id NOT IN (${placeholders(ids)})` : ''}`,
          params: [b.id, ...ids],
        },
        ...(b.questions ?? []).map((q) => upsertStatement('feedback_questions', {
          id: q.id, bank_id: b.id, position: q.position, text_en: q.text_en, text_hi: q.text_hi ?? null,
          applies_ac: bool(q.applies_ac ?? true), applies_non_ac: bool(q.applies_non_ac ?? true), required: bool(q.required ?? true),
          psi_weight: q.psi_weight ?? null, is_active: 1,
        }, { insertOnly: [] })),
      ];
    },

    itemStatements(i, now) {
      return [upsertStatement('inventory_items', {
        id: i.id, division_id: i.division_id, name: i.name, unit: i.unit, ideal_qty: i.ideal_qty ?? 0, is_active: bool(i.is_active ?? true), ...synced(i, now),
      })];
    },

    departmentStatements(d, now) {
      return [upsertStatement('complaint_departments', {
        id: d.id, division_id: d.division_id, name: d.name, is_active: bool(d.is_active ?? true), ...synced(d, now),
      })];
    },

    categoryStatements(c, now) {
      return [upsertStatement('complaint_categories', {
        id: c.id, division_id: c.division_id, parent_id: c.parent_id ?? null, name: c.name,
        default_department_id: c.default_department_id ?? null, sla_hours: c.sla_hours ?? null, sort_order: c.sort_order ?? 0,
        is_active: bool(c.is_active ?? true), ...synced(c, now),
      })];
    },

    // ---- reads ----
    async listDivisions() {
      const rows = await db.query('SELECT * FROM divisions ORDER BY is_placeholder, name');
      return rows.map((d) => ({ id: d.id, code: d.code, name: d.name, is_active: fromBool(d.is_active), updated_at: d.server_updated_at ?? d.updated_at }));
    },

    async getPolicy(divisionId) {
      const [row] = await db.query('SELECT settings FROM operating_policies WHERE division_id = ?', [divisionId]);
      return { ...DEFAULT_POLICY, ...parseJson(row?.settings, {}) };
    },

    async listTrains({ divisionId, active } = {}) {
      const rows = await db.query(
        `SELECT * FROM trains WHERE is_placeholder = 0 AND (? IS NULL OR division_id = ?) AND (? IS NULL OR is_active = ?)
         ORDER BY train_no`,
        [divisionId ?? null, divisionId ?? null, active == null ? null : bool(active), active == null ? null : bool(active)],
      );
      if (!rows.length) return [];
      const coaches = await db.query(
        `SELECT * FROM train_coaches WHERE train_id IN (${placeholders(rows)}) ORDER BY position`,
        rows.map((t) => t.id),
      );
      return rows.map((t) => trainOut(t, coaches.filter((c) => c.train_id === t.id)));
    },

    async getTrain(id) {
      const [t] = await db.query('SELECT * FROM trains WHERE id = ?', [id]);
      if (!t) return null;
      return trainOut(t, await db.query('SELECT * FROM train_coaches WHERE train_id = ? ORDER BY position', [id]));
    },

    // Backend semantics: with a division, that division's banks; without, the global default banks.
    async listBanks({ divisionId } = {}) {
      const rows = divisionId
        ? await db.query('SELECT * FROM question_banks WHERE division_id = ? ORDER BY audience, name', [divisionId])
        : await db.query('SELECT * FROM question_banks WHERE division_id IS NULL ORDER BY audience, name');
      return bankRows(rows);
    },

    // The division's active bank for an audience, else the global default (backend active_bank).
    async activeBank(divisionId, audience) {
      const [row] = await db.query(
        `SELECT * FROM question_banks WHERE audience = ? AND is_active = 1 AND (division_id = ? OR division_id IS NULL)
         ORDER BY division_id IS NULL LIMIT 1`,
        [audience, divisionId],
      );
      return row ? (await bankRows([row]))[0] : null;
    },

    async getQuestion(id) {
      const [q] = await db.query('SELECT * FROM feedback_questions WHERE id = ?', [id]);
      return q ? { ...questionOut(q), bank_id: q.bank_id, is_active: fromBool(q.is_active) } : null;
    },

    async listItems({ divisionId, active } = {}) {
      const rows = await db.query(
        `SELECT * FROM inventory_items WHERE (? IS NULL OR division_id = ?) AND (? IS NULL OR is_active = ?) ORDER BY name`,
        [divisionId ?? null, divisionId ?? null, active == null ? null : bool(active), active == null ? null : bool(active)],
      );
      return rows.map((i) => ({
        id: i.id, division_id: i.division_id, name: i.name, unit: i.unit, ideal_qty: i.ideal_qty, is_active: fromBool(i.is_active),
        updated_at: i.server_updated_at ?? i.updated_at,
      }));
    },

    async getItem(id) {
      const [i] = await db.query('SELECT * FROM inventory_items WHERE id = ?', [id]);
      return i ? { ...i, is_active: fromBool(i.is_active) } : null;
    },

    async listDepartments(divisionId) {
      const rows = await db.query('SELECT * FROM complaint_departments WHERE division_id = ? ORDER BY name', [divisionId]);
      return rows.map((d) => ({ id: d.id, division_id: d.division_id, name: d.name, is_active: fromBool(d.is_active) }));
    },

    async listCategories(divisionId) {
      const rows = await db.query('SELECT * FROM complaint_categories WHERE division_id = ? ORDER BY sort_order, name', [divisionId]);
      return rows.map((c) => ({
        id: c.id, division_id: c.division_id, parent_id: c.parent_id, name: c.name, default_department_id: c.default_department_id,
        sla_hours: c.sla_hours, sort_order: c.sort_order, is_active: fromBool(c.is_active),
      }));
    },

    async getCategory(id) {
      const [c] = await db.query('SELECT * FROM complaint_categories WHERE id = ?', [id]);
      return c ? { ...c, is_active: fromBool(c.is_active) } : null;
    },
  };
}
