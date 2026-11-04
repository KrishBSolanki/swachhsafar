// Device-side authorization, mirroring the FastAPI rules (backend app/security/principal.py and the
// p.require / p.has checks in app/services/*). The server stays authoritative; these checks stop the
// device from saving offline what the server would refuse, and keep one user's local data away from
// another user of the same device.
//
// `permissions` is the cached /auth/me `divisions` map: { divisionId: [permission, ...] }.
import { LocalRuleError } from '../database/errors.js';

export const hasPermission = (permissions, perm, divisionId) => !!permissions?.[divisionId]?.includes(perm);

export const divisionsWith = (permissions, ...perms) =>
  Object.keys(permissions ?? {}).filter((d) => perms.some((p) => hasPermission(permissions, p, d)));

// Capture permission per operation, and the permission that lets a non-participant (not the
// journey's supervisor or allocated staff) capture anyway. Attendance has its own participant rule
// (employee / supervisor / attendance.review) in attendanceRepository.
export const CAPTURE_RULES = {
  'attendance.create': { permission: 'attendance.submit' },
  'inspection.create': { permission: 'inspections.submit', participantOverride: 'inspections.review' }, // services/inspections.py create
  'feedback.passenger.start': { permission: 'feedback.collect', participantOverride: 'feedback.review' }, // feedback.py _require_journey_staff
  'feedback.railway.create': { permission: 'feedback.railway.submit', participantOverride: 'feedback.review' },
  'complaint.create': { permission: 'complaints.create' },
  'inventory.record': { permission: 'inventory.transact', participantOverride: 'journeys.manage' }, // inventory.py record
};

export function isParticipant(journey, userId) {
  return journey.supervisor_id === userId || journey.staff.some((s) => s.user_id === userId && !s.removed_at);
}

// Throws LocalRuleError when `actor` may not capture `type` in `divisionId` (for `journey`, if any).
export function authorizeCapture(type, { actor, divisionId, journey }) {
  if (!actor?.id) throw new LocalRuleError('unauthenticated', 'Sign in to record operational data.');
  const rule = CAPTURE_RULES[type];
  if (!rule) throw new LocalRuleError('unsupported_operation', `Operation ${type} cannot be captured offline.`);
  if (!divisionId) return; // the record's own validation reports the missing journey/division
  if (!actor.permissions?.[divisionId]) throw new LocalRuleError('division_forbidden', 'Outside your authorized divisions.');
  if (!hasPermission(actor.permissions, rule.permission, divisionId)) {
    throw new LocalRuleError('permission_denied', `You do not have permission ${rule.permission} in this division.`);
  }
  if (journey && rule.participantOverride && !isParticipant(journey, actor.id)
    && !hasPermission(actor.permissions, rule.participantOverride, divisionId)) {
    throw new LocalRuleError('not_journey_staff', 'Only the journey supervisor or allocated staff may record this.');
  }
}

// Backend journeys.can_see: journeys.read_all sees the division's journeys; journeys.read sees only
// journeys the user supervises or is allocated to.
export function canSeeJourney(permissions, userId, journey) {
  if (!journey) return false;
  if (hasPermission(permissions, 'journeys.read_all', journey.division_id)) return true;
  return hasPermission(permissions, 'journeys.read', journey.division_id) && isParticipant(journey, userId);
}

// Record-level actions of the operational modules (CP-04 to CP-10). Each mirrors the backend check named
// beside it and is evaluated in the RECORD's division, never "any division". These only decide which
// actions a screen offers; every one of these actions is online only and the server re-checks it.
const OPEN_JOURNEY = new Set(['scheduled', 'active']);

export const ACTIONS = {
  // services/journeys.py update_journey / assign_supervisor / cancel_journey (+ require_open)
  'journey.manage': (perms, userId, j) => hasPermission(perms, 'journeys.manage', j.division_id) && OPEN_JOURNEY.has(j.state),
  // services/journeys.py add_staff / remove_staff
  'journey.staff': (perms, userId, j) => hasPermission(perms, 'staff.manage', j.division_id) && OPEN_JOURNEY.has(j.state),
  // services/attendance.py review, services/inspections.py review, services/feedback.py review_railway
  'attendance.review': (perms, userId, r) => hasPermission(perms, 'attendance.review', r.division_id),
  'inspection.review': (perms, userId, r) => hasPermission(perms, 'inspections.review', r.division_id),
  'feedback.railway.review': (perms, userId, r) => hasPermission(perms, 'feedback.review', r.division_id),
  // services/feedback.py void_passenger: the collector's own draft, otherwise feedback.review
  'feedback.passenger.void': (perms, userId, f) => f.status !== 'void' && (
    (f.collected_by_id === userId && f.status === 'draft') || hasPermission(perms, 'feedback.review', f.division_id)),
  // services/feedback.py _require_collector: PNR/OTP/complete steps are the collector's
  'feedback.passenger.collect': (perms, userId, f) => f.collected_by_id === userId,
  // services/complaints.py transition: complaints.manage in the division, or the assignee
  'complaint.transition': (perms, userId, c) => c.status !== 'completed'
    && (hasPermission(perms, 'complaints.manage', c.division_id) || (c.assigned_to_id != null && c.assigned_to_id === userId)),
  // services/inventory.py record: inventory.transact + journey staff, or journeys.manage
  'inventory.record': (perms, userId, j) => hasPermission(perms, 'inventory.transact', j.division_id) && OPEN_JOURNEY.has(j.state)
    && (isParticipant(j, userId) || hasPermission(perms, 'journeys.manage', j.division_id)),
};

// `me`: the cached /auth/me profile ({ user, divisions }). False for unknown actions.
export function canAct(me, action, record) {
  const rule = ACTIONS[action];
  if (!rule || !record || !me?.user?.id || !me.divisions?.[record.division_id]) return false;
  return rule(me.divisions, me.user.id, record);
}

// Master-data administration (CP-03): the backend permission per area. Writes are online only and the
// server re-checks them; these decide which actions the screens offer.
export const MASTER_PERMISSIONS = {
  questionBanks: 'questions.manage', // services/feedback.py create_bank / activate_bank
  complaintMasters: 'complaints.masters.manage', // services/complaints.py departments + categories
  inventoryItems: 'inventory.items.manage', // services/inventory.py create_item / update_item
  policies: 'policies.manage', // api/v1/org.py put_policy
};

const SUPER_ADMIN_ROLE = 1;

// `divisionId` null = the global default question banks, which only a Super Admin may manage.
export function canManageMaster(me, area, divisionId) {
  if (!me?.user) return false;
  if (divisionId == null) return area === 'questionBanks' && me.user.role_id === SUPER_ADMIN_ROLE;
  return hasPermission(me.divisions, MASTER_PERMISSIONS[area], divisionId);
}
