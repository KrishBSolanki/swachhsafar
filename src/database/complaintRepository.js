// Complaints, their append-only status history and attachments.
//
// A complaint can be raised offline ('complaint.create'): it gets a provisional SLA due time and a
// 'created' history entry; the server assigns the complaint number. Status changes (assignment,
// forwarding, completion) are made through the server, and the confirmed complaint is ingested here.
// complaint_history cannot be updated or deleted (triggers trg_complaint_history_no_*).
import { LocalRuleError } from './errors.js';
import { requireDeviceTimestamp, requireText, requireUuid } from './captureRules.js';
import { insertStatement, placeholders } from './sqlHelpers.js';

export const NEXT_STATUS = {
  created: ['in_process', 'forwarded', 'completed'],
  in_process: ['forwarded', 'completed'],
  forwarded: ['in_process', 'forwarded', 'completed'],
  completed: [],
};

const historyOut = (h) => ({
  id: h.id, from_status: h.from_status, to_status: h.to_status, actor_id: h.actor_id, forwarded_to_id: h.forwarded_to_id,
  department_id: h.department_id, remarks: h.remarks, created_at: h.created_at,
});

export function createComplaintRepository(db, { journeys, masters }) {
  async function hydrate(rows, nowIso) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [history, attachments] = await Promise.all([
      db.query(`SELECT * FROM complaint_history WHERE complaint_id IN (${placeholders(ids)}) ORDER BY created_at, rowid`, ids),
      db.query(`SELECT * FROM complaint_attachments WHERE complaint_id IN (${placeholders(ids)}) ORDER BY position`, ids),
    ]);
    return rows.map((c) => {
      const own = history.filter((h) => h.complaint_id === c.id);
      // Once the server's history is known it is authoritative; this device's provisional
      // 'created' entry stays stored (history is append-only) but is not shown twice.
      const shown = own.some((h) => h.origin === 'server') ? own.filter((h) => h.origin === 'server') : own;
      return {
        id: c.id, complaint_no: c.complaint_no, division_id: c.division_id, journey_id: c.journey_id, train_id: c.train_id,
        coach_code: c.coach_code, coach_class: c.coach_class, category_id: c.category_id, subcategory_id: c.subcategory_id,
        description: c.description, latitude: c.latitude, longitude: c.longitude, department_id: c.department_id,
        assigned_to_id: c.assigned_to_id, status: c.status, sla_hours: c.sla_hours, due_at: c.due_at,
        due_at_provisional: c.due_at_provisional === 1, is_overdue: c.status !== 'completed' && c.due_at < nowIso,
        resolution_remarks: c.resolution_remarks, closed_at: c.closed_at, closed_by_id: c.closed_by_id,
        created_by_id: c.created_by_id, server_timestamp: c.server_timestamp ?? c.device_timestamp,
        attachment_ids: attachments.filter((a) => a.complaint_id === c.id).map((a) => a.media_id),
        history: shown.map(historyOut), sync_status: c.sync_status, last_sync_error: c.last_sync_error,
      };
    });
  }

  return {
    async prepareCreate(p, { actor, policy, nowMs, now, divisions }) {
      requireUuid(p.id, 'id');
      requireUuid(p.division_id, 'division_id');
      if (divisions && !divisions.includes(p.division_id)) throw new LocalRuleError('division_forbidden', 'Outside your authorized divisions.');
      requireDeviceTimestamp(p.device_timestamp, nowMs);
      const category = await masters.getCategory(p.category_id);
      if (!category || category.division_id !== p.division_id || !category.is_active || category.parent_id) {
        throw new LocalRuleError('invalid_category', 'Select an active complaint category of this division.');
      }
      const sub = p.subcategory_id ? await masters.getCategory(p.subcategory_id) : null;
      if (p.subcategory_id && (!sub || sub.parent_id !== category.id || !sub.is_active)) {
        throw new LocalRuleError('invalid_subcategory', 'The sub-category does not belong to the category.');
      }
      let journey = null;
      let coach = null;
      if (p.journey_id) {
        journey = await journeys.get(p.journey_id);
        if (!journey || journey.division_id !== p.division_id) throw new LocalRuleError('journey_not_found', 'The journey is not available in this division.');
      }
      if (p.coach_code) {
        if (!journey) throw new LocalRuleError('invalid_value', 'A coach can only be given together with a journey.');
        coach = await journeys.coach(journey.id, p.coach_code);
        if (!coach) throw new LocalRuleError('unknown_coach', 'This coach is not part of the journey.');
      }
      const attachments = p.attachment_ids ?? [];
      if (attachments.length > 10 || new Set(attachments).size !== attachments.length) {
        throw new LocalRuleError('invalid_value', 'Up to 10 distinct attachments are allowed.');
      }
      const slaHours = sub?.sla_hours ?? category.sla_hours ?? policy.complaint_default_sla_hours;
      const row = {
        id: p.id, complaint_no: null, division_id: p.division_id, journey_id: journey?.id ?? null, train_id: journey?.train_id ?? null,
        coach_code: coach?.code ?? null, coach_class: coach?.classification ?? null, category_id: category.id,
        subcategory_id: sub?.id ?? null, description: requireText(p.description, 'Description', 5, 4000),
        latitude: typeof p.latitude === 'number' ? p.latitude : null, longitude: typeof p.longitude === 'number' ? p.longitude : null,
        department_id: category.default_department_id ?? null, status: 'created', sla_hours: slaHours,
        due_at: new Date(Date.parse(p.device_timestamp) + slaHours * 3_600_000).toISOString(), due_at_provisional: 1,
        created_by_id: actor?.id ?? null, device_timestamp: p.device_timestamp, origin: 'local', sync_status: 'pending',
        created_at: now, updated_at: now,
      };
      return {
        row,
        divisionId: p.division_id,
        statements: [
          insertStatement('complaints', row),
          this.historyStatement({ complaintId: row.id, fromStatus: null, toStatus: 'created', actorId: actor?.id ?? null, origin: 'local', createdAt: now }),
          ...attachments.map((mediaId, i) => insertStatement('complaint_attachments', { complaint_id: row.id, media_id: mediaId, position: i, created_at: now })),
        ],
      };
    },

    historyStatement({ id = crypto.randomUUID(), complaintId, fromStatus, toStatus, actorId, forwardedToId = null, departmentId = null, remarks = null, origin, createdAt }) {
      return insertStatement('complaint_history', {
        id, complaint_id: complaintId, from_status: fromStatus, to_status: toStatus, actor_id: actorId, forwarded_to_id: forwardedToId,
        department_id: departmentId, remarks, origin, created_at: createdAt,
      }, { orIgnore: true });
    },

    // Server ComplaintOut (list, detail or transition response). History rows are only ever added.
    serverStatements(c, now) {
      const known = (table) => `(SELECT id FROM ${table} WHERE id = ?)`;
      return [
        {
          sql: `INSERT INTO complaints (id, complaint_no, division_id, journey_id, train_id, coach_code, coach_class, category_id,
                  subcategory_id, description, latitude, longitude, department_id, assigned_to_id, status, sla_hours, due_at,
                  due_at_provisional, resolution_remarks, closed_at, closed_by_id, created_by_id, origin, server_timestamp, synced_at,
                  sync_status, created_at, updated_at)
                VALUES (?, ?, ?, ${known('journeys')}, ${known('trains')}, ?, ?, ?, ${known('complaint_categories')}, ?, ?, ?,
                  ${known('complaint_departments')}, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'server', ?, ?, 'synced', ?, ?)
                ON CONFLICT(id) DO UPDATE SET complaint_no = excluded.complaint_no, department_id = excluded.department_id,
                  assigned_to_id = excluded.assigned_to_id, status = excluded.status, sla_hours = excluded.sla_hours,
                  due_at = excluded.due_at, due_at_provisional = 0, resolution_remarks = excluded.resolution_remarks,
                  closed_at = excluded.closed_at, closed_by_id = excluded.closed_by_id, server_timestamp = excluded.server_timestamp,
                  sync_status = 'synced', synced_at = excluded.synced_at, last_sync_error = NULL, updated_at = excluded.updated_at`,
          params: [
            c.id, c.complaint_no ?? null, c.division_id, c.journey_id ?? null, c.train_id ?? null, c.coach_code ?? null,
            c.coach_class ?? null, c.category_id, c.subcategory_id ?? null, c.description, c.latitude ?? null, c.longitude ?? null,
            c.department_id ?? null, c.assigned_to_id ?? null, c.status, c.sla_hours, c.due_at, c.resolution_remarks ?? null,
            c.closed_at ?? null, c.closed_by_id ?? null, c.created_by_id ?? null, c.server_timestamp ?? null, now, now, now,
          ],
        },
        ...(c.history ?? []).map((h) => this.historyStatement({
          id: h.id, complaintId: c.id, fromStatus: h.from_status ?? null, toStatus: h.to_status, actorId: h.actor_id ?? null,
          forwardedToId: h.forwarded_to_id ?? null, departmentId: h.department_id ?? null, remarks: h.remarks ?? null,
          origin: 'server', createdAt: h.created_at,
        })),
      ];
    },

    async get(id, nowIso = new Date().toISOString()) {
      return (await hydrate(await db.query('SELECT * FROM complaints WHERE id = ?', [id]), nowIso))[0] ?? null;
    },

    async list({ divisionId, divisions, status, journeyId, nowIso = new Date().toISOString() } = {}) {
      const scope = divisionId ? [divisionId] : divisions;
      const rows = await db.query(
        `SELECT * FROM complaints WHERE ${scope ? (scope.length ? `division_id IN (${placeholders(scope)})` : '0') : '1'}
           AND (? IS NULL OR status = ?) AND (? IS NULL OR journey_id = ?)
         ORDER BY COALESCE(server_timestamp, device_timestamp, created_at) DESC`,
        [...(scope ?? []), status || null, status || null, journeyId ?? null, journeyId ?? null],
      );
      return hydrate(rows, nowIso);
    },

    async history(id) {
      return (await db.query('SELECT * FROM complaint_history WHERE complaint_id = ? ORDER BY created_at, rowid', [id])).map(historyOut);
    },

    async counts(divisionId, nowIso) {
      const [row] = await db.query(
        `SELECT SUM(status != 'completed') AS open, SUM(status != 'completed' AND due_at < ?) AS overdue
         FROM complaints WHERE division_id = ? AND sync_status NOT IN ('rejected', 'conflict')`,
        [nowIso, divisionId],
      );
      return { open: row.open ?? 0, overdue: row.overdue ?? 0 };
    },
  };
}
