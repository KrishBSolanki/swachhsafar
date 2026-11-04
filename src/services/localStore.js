// The device's operational data layer: every repository over the one SQLite connection, plus the
// write paths that must be atomic.
//
// capture(): validates a record against local data and business rules, writes its media bytes to
// persistent storage, then commits media metadata + the record + its sync_outbox operation + an audit
// event in ONE SQLite transaction. Success means the record is durably on this device; it does not
// mean the server has it (that is recorded later by markOutcome() when the server acknowledges).
//
// ingest*(): stores server state (pulled master data and journeys, or confirmed API responses) so
// screens can read it offline. This is the read side of sync, not a second write of user data.
import { istDate } from '../utils/businessDate.js';
import { LocalRuleError, mapSqliteError } from '../database/errors.js';
import { createOutboxRepository } from '../database/outboxRepository.js';
import { createMasterDataRepository } from '../database/masterDataRepository.js';
import { createIdentityRepository } from '../database/identityRepository.js';
import { createJourneyRepository } from '../database/journeyRepository.js';
import { createAttendanceRepository } from '../database/attendanceRepository.js';
import { createInspectionRepository } from '../database/inspectionRepository.js';
import { createFeedbackRepository } from '../database/feedbackRepository.js';
import { createComplaintRepository } from '../database/complaintRepository.js';
import { createInventoryRepository } from '../database/inventoryRepository.js';
import { createMediaStore, dataUrlToBytes } from '../database/mediaStore.js';
import { createSyncStateRepository } from '../database/syncStateRepository.js';
import { authorizeCapture } from './authorization.js';

export const OUTBOX_ENTITY = 'operation';
export const CHANGES_SCOPE = 'changes';

// Operation type (the /sync/batch contract) -> local table and capture rule.
export const OPERATIONS = {
  'attendance.create': { table: 'attendance_records', entity: 'attendance', repo: 'attendance', prepare: 'prepareCapture' },
  'inspection.create': { table: 'inspection_records', entity: 'inspection', repo: 'inspections', prepare: 'prepareCapture' },
  'feedback.passenger.start': { table: 'passenger_feedback', entity: 'passenger_feedback', repo: 'feedback', prepare: 'preparePassengerStart' },
  'feedback.railway.create': { table: 'railway_feedback', entity: 'railway_feedback', repo: 'feedback', prepare: 'prepareRailway' },
  'complaint.create': { table: 'complaints', entity: 'complaint', repo: 'complaints', prepare: 'prepareCreate' },
  'inventory.record': { table: 'inventory_transactions', entity: 'inventory_transaction', repo: 'inventory', prepare: 'prepareRecord' },
};

// Records that may be removed from the device after the server rejected them. Complaints and
// inventory transactions are immutable history and are kept.
const DISCARDABLE = new Set(['attendance.create', 'inspection.create', 'feedback.passenger.start', 'feedback.railway.create']);

const mediaIdsOf = (p) => [p.photo_media_id, p.video_media_id, p.voice_media_id, ...(p.attachment_ids ?? [])].filter(Boolean);

export function createLocalStore({ db, files, now = () => new Date(), logger = console }) {
  const outbox = createOutboxRepository(db);
  const masters = createMasterDataRepository(db);
  const identity = createIdentityRepository(db, { masters });
  const journeys = createJourneyRepository(db, { masters, identity });
  const attendance = createAttendanceRepository(db, { journeys });
  const inspections = createInspectionRepository(db, { journeys });
  const feedback = createFeedbackRepository(db, { journeys, masters });
  const complaints = createComplaintRepository(db, { journeys, masters });
  const inventory = createInventoryRepository(db, { journeys, masters });
  const media = createMediaStore(db, { files });
  const syncState = createSyncStateRepository(db);
  const repos = { attendance, inspections, feedback, complaints, inventory };

  const clock = () => {
    const d = now();
    return { now: d.toISOString(), nowMs: d.getTime(), today: istDate(d) };
  };

  async function divisionOf(payload) {
    if (payload.journey_id) {
      const [row] = await db.query('SELECT division_id FROM journeys WHERE id = ?', [payload.journey_id]);
      if (row) return row.division_id;
    }
    return payload.division_id ?? null;
  }

  // Runs ingestion statements in their own transaction; a bad server row never blocks the others.
  async function tryIngest(label, statements) {
    try {
      await db.transaction(statements);
      return true;
    } catch (e) {
      logger?.warn?.(`[localStore] could not store ${label}: ${e.message}`);
      return false;
    }
  }

  async function journeyExists(id) {
    const [row] = await db.query('SELECT id, division_id FROM journeys WHERE id = ?', [id]);
    return row ?? null;
  }

  const store = {
    db, outbox, masters, identity, journeys, attendance, inspections, feedback, complaints, inventory, media, syncState,
    clock,

    // Saves an operational record locally. `media`: [{ id, kind, dataUrl } | { id, kind, bytes, mimeType }].
    // `actor`: { id, permissions } of the signed-in user (cached /auth/me). The queued operation belongs
    // to that user and is only ever delivered with their credentials.
    // Throws LocalRuleError when authorization or a business rule rejects the record; nothing is written then.
    async capture({ type, payload, media: items = [], actor = null, divisions = null }) {
      const op = OPERATIONS[type];
      if (!op) throw new LocalRuleError('unsupported_operation', `Operation ${type} cannot be captured offline.`);
      if (!actor?.id) throw new LocalRuleError('unauthenticated', 'Sign in to record operational data.');
      const t = clock();
      const provided = new Set(items.map((m) => m.id));
      const missing = mediaIdsOf(payload).filter((id) => !provided.has(id));
      if (missing.length) throw new LocalRuleError('media_missing', 'Referenced media was not supplied.', missing);

      const divisionId = await divisionOf(payload);
      const journey = payload.journey_id ? await journeys.get(payload.journey_id, t.today) : null;
      authorizeCapture(type, { actor, divisionId, journey });
      const policy = await masters.getPolicy(divisionId);
      const scope = divisions ?? Object.keys(actor.permissions ?? {});
      const prepared = await repos[op.repo][op.prepare](payload, { ...t, actor, policy, divisions: scope });

      const staged = [];
      try {
        for (const item of items) {
          const { bytes, contentType } = item.bytes ? { bytes: item.bytes, contentType: item.mimeType } : dataUrlToBytes(item.dataUrl);
          staged.push(await media.stage({
            id: item.id, kind: item.kind, bytes, mimeType: contentType, divisionId: prepared.divisionId,
            ownerTable: op.table, ownerId: payload.id, now: t.now,
          }));
        }
        const outboxId = crypto.randomUUID();
        await db.transaction([
          ...staged.map((s) => s.statement),
          ...prepared.statements,
          outbox.insertStatement({
            id: outboxId, entity_type: OUTBOX_ENTITY, entity_id: payload.id, operation: type, created_at: t.now,
            owner_user_id: actor.id,
            // The outbox holds media references only; bytes are read from media storage at upload time.
            payload: { op: { type, payload }, media: items.map((m) => ({ id: m.id, kind: m.kind, division_id: prepared.divisionId })) },
          }),
          syncState.auditStatement({
            actorId: actor?.id, divisionId: prepared.divisionId, action: `${type}.local`, entityType: op.entity,
            entityId: payload.id, details: { media: items.length }, now: t.now,
          }),
        ]);
        return { record: prepared.row, outboxId };
      } catch (e) {
        await Promise.all(staged.map((s) => files.remove(s.meta.storage_path.replace(/^media\//, '')).catch(() => {})));
        throw mapSqliteError(e);
      }
    },

    // Records the server's answer for a captured record. Only 'synced' means the server has it.
    // Records a delivery outcome. `outboxStatement` (the sync_outbox transition) is committed in the same
    // transaction as the record's sync state, so no reader can observe a completed operation whose record
    // is still pending, and a crash cannot strand a record in that state.
    async markOutcome({ type, entityId, outcome, message = null, code = null, detail = null, outboxId = null, serverTimestamp = null, outboxStatement = null }) {
      const op = OPERATIONS[type];
      const t = clock();
      const statements = outboxStatement ? [outboxStatement] : [];
      if (op && outcome === 'synced') {
        statements.push({
          sql: `UPDATE ${op.table} SET sync_status = 'synced', synced_at = ?, server_timestamp = COALESCE(?, server_timestamp),
                  last_sync_error = NULL, updated_at = ? WHERE id = ?`,
          params: [t.now, serverTimestamp, t.now, entityId],
        });
      } else if (op && outcome === 'retry') {
        statements.push({ sql: `UPDATE ${op.table} SET last_sync_error = ?, updated_at = ? WHERE id = ?`, params: [message, t.now, entityId] });
      } else if (op && (outcome === 'rejected' || outcome === 'conflict')) {
        statements.push(
          { sql: `UPDATE ${op.table} SET sync_status = ?, last_sync_error = ?, updated_at = ? WHERE id = ?`, params: [outcome, message, t.now, entityId] },
          syncState.conflictStatement({ entityType: op.entity, entityId, outboxId, operation: type, outcome, code, message, detail, now: t.now }),
          syncState.auditStatement({ action: `${type}.${outcome}`, entityType: op.entity, entityId, details: { code, message }, now: t.now }),
        );
      }
      if (statements.length) await db.transaction(statements);
    },

    // Returns a rejected record to the queue (after the cause was fixed). Fails if its slot has since
    // been taken by another record (e.g. the stage was re-captured).
    async reopen(type, entityId) {
      const op = OPERATIONS[type];
      if (!op) return false;
      const t = clock();
      try {
        const { changes } = await db.run(
          `UPDATE ${op.table} SET sync_status = 'pending', last_sync_error = NULL, updated_at = ? WHERE id = ? AND sync_status IN ('rejected', 'conflict')`,
          [t.now, entityId],
        );
        return changes > 0;
      } catch (e) {
        throw mapSqliteError(e);
      }
    },

    // Removes a record the server rejected, with its media, and leaves a tombstone.
    async discardRejected(type, entityId) {
      const op = OPERATIONS[type];
      if (!op || !DISCARDABLE.has(type)) throw new LocalRuleError('not_discardable', 'This record is kept as permanent history.');
      const [row] = await db.query(`SELECT sync_status FROM ${op.table} WHERE id = ?`, [entityId]);
      if (!row) return false;
      if (row.sync_status !== 'rejected' && row.sync_status !== 'conflict') {
        throw new LocalRuleError('not_discardable', 'Only records rejected by the server can be discarded.');
      }
      const t = clock();
      const owned = await media.listForOwner(op.table, entityId);
      const entry = await outbox.findOpenForEntity(OUTBOX_ENTITY, entityId);
      await db.transaction([
        { sql: `DELETE FROM ${op.table} WHERE id = ?`, params: [entityId] },
        ...owned.map((m) => ({ sql: 'DELETE FROM media_files WHERE id = ?', params: [m.id] })),
        ...(entry ? [{
          sql: `UPDATE sync_outbox SET sync_status = 'completed', last_error = 'Discarded on this device', completed_at = ?, updated_at = ? WHERE id = ?`,
          params: [t.now, t.now, entry.id],
        }] : []),
        { sql: "UPDATE sync_conflicts SET status = 'discarded', resolved_at = ? WHERE entity_id = ? AND status = 'open'", params: [t.now, entityId] },
        syncState.tombstoneStatement({ entityType: op.entity, entityId, origin: 'local', reason: 'rejected_discarded', now: t.now }),
        syncState.auditStatement({ action: `${type}.discarded`, entityType: op.entity, entityId, now: t.now }),
      ]);
      await Promise.all(owned.map((m) => files.remove(m.storage_path.replace(/^media\//, '')).catch(() => {})));
      return true;
    },

    // Applies a GET /sync/changes response: master data in one transaction, then each journey in its
    // own. The checkpoint only advances when everything was stored, so a failed item is pulled again.
    async ingestChanges(changes) {
      const t = clock();
      const categories = [...(changes.complaint_categories ?? [])].sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
      const masterOk = await tryIngest('master data', [
        ...(changes.divisions ?? []).flatMap((d) => masters.divisionStatements(d, t.now)),
        ...Object.keys(changes.policies ?? {}).map((d) => masters.ensureDivisionStatement(d, t.now)),
        ...Object.entries(changes.policies ?? {}).flatMap(([d, s]) => masters.policyStatements(d, s, t.now)),
        ...(changes.complaint_departments ?? []).flatMap((d) => masters.departmentStatements(d, t.now)),
        ...categories.flatMap((c) => masters.categoryStatements(c, t.now)),
        ...(changes.trains ?? []).flatMap((tr) => masters.trainStatements(tr, t.now)),
        ...(changes.question_banks ?? []).flatMap((b) => masters.bankStatements(b, t.now)),
        ...(changes.inventory_items ?? []).flatMap((i) => masters.itemStatements(i, t.now)),
      ]);
      let journeysStored = 0;
      let failures = masterOk ? 0 : 1;
      for (const j of changes.journeys ?? []) {
        if (await syncState.isTombstoned('journey', j.id)) continue;
        if (await tryIngest(`journey ${j.id}`, journeys.serverStatements(j, t.now))) journeysStored += 1;
        else failures += 1;
      }
      if (!failures && changes.cursor) await db.transaction([syncState.checkpointStatement(CHANGES_SCOPE, { cursor: changes.cursor, now: t.now })]);
      else if (failures) await syncState.recordCheckpointError(CHANGES_SCOPE, { error: `${failures} item(s) could not be stored`, now: t.now });
      return { ok: failures === 0, journeys: journeysStored, failures };
    },

    // Stores a successful API response for offline reading. Unknown paths are ignored.
    async ingestResponse(method, path, data) {
      if (!data || typeof data !== 'object') return;
      const t = clock();
      const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [data];
      let m;
      // ---- master data (CP-03): list responses and confirmed create/update/activate results ----
      if (/^\/feedback\/question-banks(\/[^/]+\/activate)?$/.test(path)) {
        for (const b of items.filter((x) => x?.id && x?.audience)) {
          // Server activate_bank retires the other active bank of the same scope and audience.
          const retire = /\/activate$/.test(path) && b.is_active ? [{
            sql: 'UPDATE question_banks SET is_active = 0, updated_at = ? WHERE audience = ? AND division_id IS ? AND id != ?',
            params: [t.now, b.audience, b.division_id ?? null, b.id],
          }] : [];
          await tryIngest(`question bank ${b.id}`, [...masters.bankStatements(b, t.now), ...retire]);
        }
        return;
      }
      if (/^\/complaints\/departments(\/[^/]+)?$/.test(path)) {
        await tryIngest('departments', items.filter((d) => d?.id && d?.name).flatMap((d) => masters.departmentStatements(d, t.now)));
        return;
      }
      if (/^\/complaints\/categories(\/[^/]+)?$/.test(path)) {
        const sorted = items.filter((c) => c?.id && c?.name).sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
        await tryIngest('categories', sorted.flatMap((c) => masters.categoryStatements(c, t.now)));
        return;
      }
      if (/^\/inventory\/items(\/[^/]+)?$/.test(path)) {
        await tryIngest('inventory items', items.filter((i) => i?.id && i?.unit).flatMap((i) => masters.itemStatements(i, t.now)));
        return;
      }
      if ((m = path.match(/^\/divisions\/([^/]+)\/policy$/)) && !Array.isArray(data)) {
        await tryIngest('policy', [masters.ensureDivisionStatement(m[1], t.now), ...masters.policyStatements(m[1], data, t.now)]);
        return;
      }
      if (/^\/journeys(\/[^/]+)?(\/(cancel|supervisor))?$/.test(path)) {
        for (const j of items.filter((x) => x?.train_no && x?.journey_date)) await tryIngest(`journey ${j.id}`, journeys.serverStatements(j, t.now));
      } else if ((m = path.match(/^\/attendance\/journeys\/([^/]+)\/status$/)) && Array.isArray(data)) {
        const j = await journeyExists(m[1]);
        if (j) {
          await tryIngest('attendance status', [
            ...data.map((r) => identity.ensureProfileStatement({ id: r.employee_id, name: r.name, emp_id: r.emp_id, role_id: r.role_id, division_id: j.division_id }, t.now)),
            ...attendance.serverStatements(j, data, t.now),
          ]);
        }
      } else if ((m = path.match(/^\/inspections\/journeys\/([^/]+)\/status$/)) && Array.isArray(data)) {
        const j = await journeyExists(m[1]);
        if (j) await tryIngest('inspection grid', inspections.serverStatements(j, data, t.now));
      } else if ((m = path.match(/^\/(attendance|inspections)(\/[^/]+)?(\/review)?$/))) {
        // Record lists, details and review results: keep the server's verification on rows this device
        // already holds. Only mutable columns are written (captured facts are immutable).
        const table = m[1] === 'attendance' ? 'attendance_records' : 'inspection_records';
        for (const r of items.filter((x) => x?.id && x?.verification_status)) {
          await tryIngest(`${table} ${r.id}`, [{
            sql: `UPDATE ${table} SET verification_status = ?, server_timestamp = COALESCE(?, server_timestamp), updated_at = ?
                  WHERE id = ? AND sync_status = 'synced'`,
            params: [r.verification_status, r.server_timestamp ?? null, t.now, r.id],
          }]);
        }
      } else if ((m = path.match(/^\/inventory\/journeys\/([^/]+)\/transactions$/)) && Array.isArray(data.items)) {
        if (await journeyExists(m[1])) {
          for (const s of await inventory.serverStatements(data.items, t.now)) await tryIngest('inventory transaction', [s]);
        }
      } else if (/^\/complaints(\/[^/]+(\/transition)?)?$/.test(path) && !/\/(categories|departments)$/.test(path)) {
        for (const c of items.filter((x) => x?.category_id && x?.description)) await tryIngest(`complaint ${c.id}`, complaints.serverStatements(c, t.now));
      } else if (/^\/feedback\/passenger(\/[^/]+(\/[a-z-]+)?)?$/.test(path)) {
        for (const f of items.filter((x) => x?.passenger_name && x?.pnr_status)) {
          if (await journeyExists(f.journey_id)) await tryIngest(`passenger feedback ${f.id}`, feedback.passengerServerStatements(f, t.now));
        }
      } else if (/^\/feedback\/railway(\/[^/]+\/review)?$/.test(path)) {
        // Railway feedback with the server's verification state (stored with a freshness guard).
        for (const f of items.filter((x) => x?.railway_employee_id && x?.journey_id)) {
          if (await journeyExists(f.journey_id)) await tryIngest(`railway feedback ${f.id}`, feedback.railwayServerStatements(f, t.now));
        }
      } else if (path === '/divisions' && method === 'GET') {
        await tryIngest('divisions', items.flatMap((d) => masters.divisionStatements(d, t.now)));
      } else if (path === '/trains' && method === 'GET') {
        for (const tr of items) await tryIngest(`train ${tr.id}`, masters.trainStatements(tr, t.now));
      } else if (path === '/users' && method === 'GET') {
        await tryIngest('users', items.filter((u) => u?.id && u?.name).flatMap((u) => identity.profileStatements(u, t.now)));
      }
    },

    // ---- derived views (same shapes as the matching FastAPI endpoints) ----
    async journeySummary(journeyId) {
      const t = clock();
      const j = await journeys.get(journeyId, t.today);
      if (!j) return null;
      const live = "sync_status NOT IN ('rejected', 'conflict')";
      const [staff, att, insp, pf, rf, cmp, inv] = await Promise.all([
        journeys.activeStaff(journeyId),
        db.query(`SELECT employee_id, stage FROM attendance_records WHERE journey_id = ? AND ${live}`, [journeyId]),
        db.query(`SELECT COUNT(*) AS n FROM inspection_records WHERE journey_id = ? AND ${live}`, [journeyId]),
        db.query(`SELECT status, COUNT(*) AS n FROM passenger_feedback WHERE journey_id = ? AND ${live} GROUP BY status`, [journeyId]),
        db.query(`SELECT COUNT(*) AS n FROM railway_feedback WHERE journey_id = ? AND ${live}`, [journeyId]),
        db.query(
          `SELECT SUM(status != 'completed') AS open, SUM(status != 'completed' AND due_at < ?) AS overdue, SUM(status = 'completed') AS closed
           FROM complaints WHERE journey_id = ? AND ${live}`,
          [t.now, journeyId],
        ),
        db.query(`SELECT COUNT(*) AS n FROM inventory_transactions WHERE journey_id = ? AND ${live}`, [journeyId]),
      ]);
      const byStage = {};
      const perStaff = {};
      for (const a of att) {
        byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;
        perStaff[a.employee_id] = (perStaff[a.employee_id] ?? 0) + 1;
      }
      const phases = Number(j.before_inspection_enabled) + Number(j.after_inspection_enabled);
      const required = j.coaches.length * j.operational_days * j.inspection_rounds_per_day * phases;
      const fb = Object.fromEntries(pf.map((r) => [r.status, r.n]));
      return {
        journey_id: j.id, state: j.state, staff_allocated: staff.length, attendance_records: att.length, attendance_by_stage: byStage,
        staff_fully_attended: staff.filter((s) => perStaff[s.user_id] === 5).length, inspections_required: required,
        inspections_done: insp[0].n, inspection_completion_pct: required ? (insp[0].n / required) * 100 : null,
        passenger_feedback_counted: (fb.draft ?? 0) + (fb.verified ?? 0) + (fb.completed ?? 0),
        passenger_feedback_completed: fb.completed ?? 0, passenger_feedback_pending: (fb.draft ?? 0) + (fb.verified ?? 0),
        passenger_feedback_void: fb.void ?? 0, railway_feedback: rf[0].n, complaints_open: cmp[0].open ?? 0,
        complaints_overdue: cmp[0].overdue ?? 0, complaints_closed: cmp[0].closed ?? 0, inventory_lines: inv[0].n,
      };
    },

    async divisionDashboard(divisionId) {
      const t = clock();
      const [active, scheduled, att, insp, pf, rf, cmp] = await Promise.all([
        journeys.list({ state: 'active', divisionId, today: t.today }),
        journeys.list({ state: 'scheduled', divisionId, today: t.today }),
        attendance.countOn(divisionId, t.today),
        inspections.countOn(divisionId, t.today),
        feedback.countOn('passenger_feedback', divisionId, t.today),
        feedback.countOn('railway_feedback', divisionId, t.today),
        complaints.counts(divisionId, t.now),
      ]);
      return {
        division_id: divisionId, date: t.today, journeys_active: active.length, journeys_scheduled: scheduled.length,
        attendance_today: att, inspections_today: insp, passenger_feedback_today: pf, railway_feedback_today: rf,
        complaints_open: cmp.open, complaints_overdue: cmp.overdue,
      };
    },
  };
  return store;
}
