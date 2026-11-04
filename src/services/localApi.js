// Answers the FastAPI GET routes the screens use from the device's SQLite database, in the same
// response shapes. Used by localFirstApi when the server cannot be reached. Routes without local data
// (reports, audit) throw `not_available_offline`, so callers can fall back or say so honestly.
//
// Authorization: every route applies the signed-in user's cached permissions per division, as the
// backend does, so one user of a shared device never reads another user's divisions or records.
// Records hidden this way answer 404 (as the server does), not 403, so their existence is not leaked.
import { ApiError } from './apiClient.js';
import { LocalRuleError } from '../database/errors.js';
import { page } from '../database/sqlHelpers.js';
import { canSeeJourney, divisionsWith, hasPermission, isParticipant } from './authorization.js';
import { attendanceOut } from '../database/attendanceRepository.js';
import { inspectionOut } from '../database/inspectionRepository.js';
import { checkRange, createLocalReports } from './localReports.js';

const truthy = (v) => v === true || v === 'true' || v === '1';
const notFound = (what) => new ApiError(404, 'not_found', `${what} is not available on this device.`);
const forbidden = (perm) => new ApiError(403, 'permission_denied', `Missing permission ${perm}`);
const outside = () => new ApiError(403, 'division_forbidden', 'Outside your authorized divisions');

export function createLocalApi({ store, getContext = () => ({}) }) {
  const { masters, identity, journeys, attendance, inspections, feedback, complaints, inventory } = store;
  const reports = createLocalReports(store.db);

  const ctx = () => {
    const c = getContext();
    return { userId: c.userId ?? null, permissions: c.permissions ?? {} };
  };

  // Divisions where the user holds one of `perms`, narrowed to `q.division_id` if given (backend require_any_division).
  function scopeFor(q, ...perms) {
    const { permissions } = ctx();
    const allowed = divisionsWith(permissions, ...perms);
    if (q.division_id) {
      if (!permissions[q.division_id]) throw outside();
      if (!allowed.includes(q.division_id)) throw forbidden(perms[0]);
      return [q.division_id];
    }
    if (!allowed.length) throw forbidden(perms[0]);
    return allowed;
  }

  function inDivision(divisionId) {
    if (!ctx().permissions[divisionId]) throw outside();
    return divisionId;
  }

  // A journey the user may see, else 404; then `perm` in its division, else 403.
  async function visibleJourney(id, perm) {
    const { userId, permissions } = ctx();
    const j = await journeys.get(id, store.clock().today);
    if (!canSeeJourney(permissions, userId, j)) throw notFound('Journey');
    if (perm && !hasPermission(permissions, perm, j.division_id)) throw forbidden(perm);
    return j;
  }

  // Unsynced records exist only on this device: list only the current user's own.
  const ownPendingOnly = (rows, ownerField) => {
    const { userId } = ctx();
    return rows.filter((r) => r.sync_status !== 'pending' || r[ownerField] === userId);
  };
  // ...and the same for records the server rejected (they never reached it).
  const ownUnsyncedOnly = (rows, ownerField = 'created_by_id') => {
    const { userId } = ctx();
    return rows.filter((r) => r.sync_status === 'synced' || r[ownerField] === userId);
  };

  // Record lists of attendance / inspections / railway feedback (backend list_records): `perm` in the
  // record's division, and there journeys.read_all, or the record is the user's own (`own` fields), or
  // the user supervises its journey.
  async function readableRecords(rows, perm, own) {
    const { userId, permissions } = ctx();
    const supervised = new Map();
    const supervises = async (journeyId) => {
      if (!supervised.has(journeyId)) supervised.set(journeyId, (await journeys.get(journeyId, store.clock().today))?.supervisor_id === userId);
      return supervised.get(journeyId);
    };
    const out = [];
    for (const r of rows) {
      if (!hasPermission(permissions, perm, r.division_id)) continue;
      if (hasPermission(permissions, 'journeys.read_all', r.division_id) || own.some((f) => r[f] === userId) || (await supervises(r.journey_id))) out.push(r);
    }
    return out;
  }
  const intOrNull = (v) => (v == null ? null : Number(v));

  const ROUTES = [
    [/^\/divisions$/, async () => (await masters.listDivisions()).filter((d) => ctx().permissions[d.id])],
    [/^\/divisions\/([^/]+)\/policy$/, (q, [id]) => masters.getPolicy(inDivision(id))],
    [/^\/dashboard\/divisions\/([^/]+)$/, (q, [id]) => {
      if (!hasPermission(ctx().permissions, 'dashboard.read', inDivision(id))) throw forbidden('dashboard.read');
      return store.divisionDashboard(id);
    }],
    [/^\/journeys$/, async (q) => {
      const { userId, permissions } = ctx();
      const divisions = scopeFor(q, 'journeys.read', 'journeys.read_all');
      const rows = await journeys.list({ state: q.state || undefined, divisions, today: store.clock().today });
      // backend list_journeys: what can_see allows; `mine` narrows to journeys the user works on.
      // backend list_journeys date filters: end_date >= date_from, journey_date <= date_to
      const visible = rows.filter((j) => canSeeJourney(permissions, userId, j) && (!truthy(q.mine) || isParticipant(j, userId))
        && (!q.date_from || j.end_date >= q.date_from) && (!q.date_to || j.journey_date <= q.date_to));
      return page(visible, q);
    }],
    // CP-11 reports from this device's records (see localReports.js); reports.read per division.
    [/^\/reports\/(attendance|inspections|feedback\/passenger|feedback\/railway|psi|complaints|inventory)$/, (q, [kind]) => {
      const divisions = scopeFor(q, 'reports.read');
      checkRange(q.date_from, q.date_to);
      const args = { divisions, userId: ctx().userId, from: q.date_from, to: q.date_to };
      switch (kind) {
        case 'attendance': return reports.attendance({ ...args, groupBy: q.group_by || 'employee' });
        case 'inspections': return reports.inspections({ ...args, coachWise: truthy(q.coach_wise) });
        case 'psi': return reports.psi({ ...args, bankId: q.bank_id });
        case 'complaints': return reports.complaints({ ...args, nowIso: store.clock().now });
        case 'inventory': return reports.inventory(args);
        default: return reports.feedback({ ...args, audience: kind.split('/')[1], journeyId: q.journey_id, bankId: q.bank_id });
      }
    }],
    [/^\/journeys\/([^/]+)\/summary$/, async (q, [id]) => {
      await visibleJourney(id);
      return store.journeySummary(id);
    }],
    [/^\/journeys\/([^/]+)$/, (q, [id]) => visibleJourney(id)],
    [/^\/attendance\/journeys\/([^/]+)\/status$/, async (q, [id]) => {
      await visibleJourney(id, 'attendance.read');
      return attendance.journeyStatus(id);
    }],
    [/^\/inspections\/journeys\/([^/]+)\/status$/, async (q, [id]) => inspections.journeyGrid(await visibleJourney(id, 'inspections.read'), store.clock().today)],
    [/^\/attendance$/, async (q) => {
      const divisions = scopeFor(q, 'attendance.read');
      const rows = await attendance.listRecords({
        divisions, journeyId: q.journey_id, employeeId: q.employee_id, stage: intOrNull(q.stage), verificationStatus: q.verification_status,
      });
      return page(ownUnsyncedOnly(await readableRecords(rows, 'attendance.read', ['employee_id', 'created_by_id'])), q);
    }],
    [/^\/attendance\/([^/]+)$/, async (q, [id]) => {
      const row = await attendance.get(id);
      const [r] = row ? ownUnsyncedOnly(await readableRecords([attendanceOut(row)], 'attendance.read', ['employee_id', 'created_by_id'])) : [];
      if (!r) throw notFound('Attendance');
      return r;
    }],
    [/^\/inspections$/, async (q) => {
      const divisions = scopeFor(q, 'inspections.read');
      const rows = await inspections.listRecords({
        divisions, journeyId: q.journey_id, coachCode: q.coach_code, day: intOrNull(q.day), phase: q.phase, verificationStatus: q.verification_status,
      });
      return page(ownUnsyncedOnly(await readableRecords(rows, 'inspections.read', ['created_by_id'])), q);
    }],
    [/^\/inspections\/([^/]+)$/, async (q, [id]) => {
      const row = await inspections.get(id);
      const [r] = row ? ownUnsyncedOnly(await readableRecords([inspectionOut(row)], 'inspections.read', ['created_by_id'])) : [];
      if (!r) throw notFound('Inspection');
      return r;
    }],
    [/^\/trains$/, async (q) => {
      const divisions = scopeFor(q, 'trains.read', 'trains.manage');
      const rows = await masters.listTrains({ active: q.active == null ? null : truthy(q.active) });
      return page(rows.filter((t) => divisions.includes(t.division_id)), q);
    }],
    [/^\/users$/, async (q) => {
      const divisions = scopeFor(q, 'users.read');
      const rows = await identity.listProfiles({ roleId: q.role_id ? Number(q.role_id) : null, status: q.status, q: q.q });
      return page(rows.filter((u) => divisions.includes(u.division_id)), q);
    }],
    [/^\/feedback\/questions$/, async (q) => {
      await visibleJourney(q.journey_id);
      return (await feedback.questionsFor({
        journeyId: q.journey_id, coachCode: q.coach_code, audience: q.audience || 'passenger', today: store.clock().today,
      })).questions;
    }],
    // Without a division: the global default banks, readable by any signed-in user.
    [/^\/feedback\/question-banks$/, (q) => masters.listBanks({ divisionId: q.division_id ? inDivision(q.division_id) : undefined })],
    [/^\/feedback\/passenger$/, async (q) => {
      const { userId, permissions } = ctx();
      const readable = new Set(divisionsWith(permissions, 'feedback.read'));
      if (q.division_id) inDivision(q.division_id);
      const rows = await feedback.listPassenger({ divisionId: q.division_id, divisions: Object.keys(permissions), journeyId: q.journey_id, status: q.status });
      return page(ownPendingOnly(rows.filter((f) => readable.has(f.division_id) || f.collected_by_id === userId), 'collected_by_id'), q);
    }],
    [/^\/feedback\/passenger\/([^/]+)$/, async (q, [id]) => {
      const { userId, permissions } = ctx();
      const f = await feedback.getPassenger(id);
      // backend feedback.get_passenger: the collector, or feedback.read in the division
      if (!f || !permissions[f.division_id] || (f.collected_by_id !== userId && !hasPermission(permissions, 'feedback.read', f.division_id))) throw notFound('Feedback');
      return f;
    }],
    [/^\/feedback\/railway$/, async (q) => {
      const divisions = scopeFor(q, 'feedback.read');
      const rows = await feedback.listRailway({ divisions, journeyId: q.journey_id });
      return page(ownUnsyncedOnly(await readableRecords(rows, 'feedback.read', ['created_by_id'])), q);
    }],
    [/^\/complaints\/categories$/, (q) => masters.listCategories(inDivision(q.division_id))],
    [/^\/complaints\/departments$/, (q) => masters.listDepartments(inDivision(q.division_id))],
    [/^\/complaints$/, async (q) => {
      const { userId, permissions } = ctx();
      if (q.division_id) inDivision(q.division_id);
      const readable = new Set(divisionsWith(permissions, 'complaints.read'));
      const rows = await complaints.list({ divisionId: q.division_id, divisions: Object.keys(permissions), status: q.status, journeyId: q.journey_id, nowIso: store.clock().now });
      // backend complaints list: complaints.read in the division, or raised by / assigned to the user;
      // then the category / assigned_to_me / overdue filters
      const overdue = q.overdue == null ? null : truthy(q.overdue);
      const visible = rows.filter((c) => (readable.has(c.division_id) || c.created_by_id === userId || c.assigned_to_id === userId)
        && (!q.category_id || c.category_id === q.category_id)
        && (!truthy(q.assigned_to_me) || c.assigned_to_id === userId)
        && (overdue === null || !!c.is_overdue === overdue));
      return page(ownPendingOnly(visible, 'created_by_id'), q);
    }],
    [/^\/complaints\/([^/]+)$/, async (q, [id]) => {
      const { userId, permissions } = ctx();
      const c = await complaints.get(id, store.clock().now);
      const ok = c && permissions[c.division_id] && (c.sync_status !== 'pending' || c.created_by_id === userId)
        && (hasPermission(permissions, 'complaints.read', c.division_id) || c.created_by_id === userId || c.assigned_to_id === userId);
      if (!ok) throw notFound('Complaint');
      return c;
    }],
    [/^\/inventory\/items$/, (q) => masters.listItems({ divisionId: inDivision(q.division_id), active: q.active == null ? null : truthy(q.active) })],
    [/^\/inventory\/journeys\/([^/]+)\/balance$/, async (q, [id]) => {
      await visibleJourney(id, 'inventory.read');
      return inventory.balance(id);
    }],
    [/^\/inventory\/journeys\/([^/]+)\/transactions$/, async (q, [id]) => {
      await visibleJourney(id, 'inventory.read');
      return page(await inventory.ledger(id), q);
    }],
  ];

  async function get(path, query) {
    const q = Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    for (const [re, fn] of ROUTES) {
      const m = path.match(re);
      if (!m) continue;
      try {
        return await fn(q, m.slice(1));
      } catch (e) {
        if (e instanceof LocalRuleError) throw new ApiError(e.code === 'journey_not_found' ? 404 : 422, e.code, e.message, e.details);
        throw e;
      }
    }
    throw new ApiError(404, 'not_available_offline', `This information is not stored on this device (${path}).`);
  }

  return { get, has: (path) => ROUTES.some(([re]) => re.test(path)) };
}
