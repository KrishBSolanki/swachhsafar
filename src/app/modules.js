// The operational modules of the app: one registry for routing, navigation and checkpoint ownership.
// `any`: the module shows when the user holds at least one of these permissions in any division (the
// screens then check the record's own division before offering an action; the server re-checks).
export const MODULES = [
  { key: 'dashboard', path: '/', label: 'Dashboard', any: [] },
  { key: 'journeys', cp: 'CP-04', path: '/journeys', label: 'Journeys', any: ['journeys.read', 'journeys.read_all'] },
  { key: 'attendance', cp: 'CP-05', path: '/attendance', label: 'Attendance', any: ['attendance.submit', 'attendance.read'] },
  { key: 'inspections', cp: 'CP-06', path: '/inspections', label: 'Coach inspection', any: ['inspections.submit', 'inspections.read'] },
  { key: 'feedback', cp: 'CP-07/CP-08', path: '/feedback', label: 'Feedback', any: ['feedback.collect', 'feedback.railway.submit', 'feedback.read'] },
  { key: 'complaints', cp: 'CP-09', path: '/complaints', label: 'Complaints', any: ['complaints.create', 'complaints.read'] },
  { key: 'inventory', cp: 'CP-10', path: '/inventory', label: 'Inventory', any: ['inventory.read', 'inventory.transact'] },
  {
    key: 'masters', cp: 'CP-03', path: '/masters', label: 'Master data',
    any: ['trains.manage', 'users.read', 'divisions.manage', 'questions.manage', 'complaints.masters.manage', 'inventory.items.manage', 'policies.manage'],
  },
  { key: 'reports', cp: 'CP-11', path: '/reports', label: 'Reports', any: ['reports.read'] },
];

export const visibleModules = (can) => MODULES.filter((m) => !m.any.length || m.any.some(can));

// `parts`: the hash path split on '/'. Returns the module for the first segment, whether the user may
// open it, and the remaining segments for the module's own sub-routes.
export function resolveRoute(parts, can) {
  const section = parts[0] ?? '';
  const module = MODULES.find((m) => m.path === `/${section}`) ?? null;
  return { module, allowed: !!module && visibleModules(can).includes(module), rest: parts.slice(1) };
}
