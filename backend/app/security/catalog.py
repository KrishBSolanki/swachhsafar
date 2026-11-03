"""Permission catalog and default role grants. Seeded by migration 0001; divisions may override per role
through role_permissions rows with a division_id."""

from app.models.org import RoleId

ROLES = [
    (RoleId.SUPER_ADMIN, "super_admin", "Super Admin", 1),
    (RoleId.ADMIN, "admin", "Admin", 2),
    (RoleId.MANAGER, "manager", "Manager", 3),
    (RoleId.SUPERVISOR, "supervisor", "Supervisor/EHK", 4),
    (RoleId.JANITOR, "janitor", "Janitor", 5),
    (RoleId.CONTRACTOR, "contractor", "Contractor", 6),
]

PERMISSIONS: dict[str, tuple[str, str]] = {
    "divisions.manage": ("admin", "Create and modify divisions"),
    "policies.manage": ("admin", "Modify division operational policies"),
    "permissions.manage": ("admin", "Modify role permission grants"),
    "charge.manage": ("admin", "Manage temporary division charge"),
    "audit.read": ("admin", "Read audit logs"),
    "users.read": ("users", "List and view users"),
    "users.manage": ("users", "Create, update, deactivate users"),
    "users.kyc.read": ("users", "Read restricted employee KYC data"),
    "users.kyc.manage": ("users", "Modify restricted employee KYC data"),
    "trains.read": ("masters", "View trains and coaches"),
    "trains.manage": ("masters", "Manage trains, coaches and inspection configuration"),
    "questions.manage": ("masters", "Manage feedback question banks"),
    "inventory.items.manage": ("masters", "Manage inventory item master"),
    "complaints.masters.manage": ("masters", "Manage complaint categories and departments"),
    "journeys.read": ("journeys", "View journeys the user is involved in"),
    "journeys.read_all": ("journeys", "View all journeys in the division"),
    "journeys.manage": ("journeys", "Create, update, cancel journeys and assign supervisors"),
    "staff.manage": ("journeys", "Allocate and remove journey staff"),
    "attendance.submit": ("attendance", "Submit attendance for allocated staff"),
    "attendance.read": ("attendance", "View attendance"),
    "attendance.review": ("attendance", "Verify or reject attendance"),
    "inspections.submit": ("inspections", "Submit coach inspections"),
    "inspections.read": ("inspections", "View inspections"),
    "inspections.review": ("inspections", "Verify or reject inspections"),
    "feedback.collect": ("feedback", "Collect passenger feedback"),
    "feedback.railway.submit": ("feedback", "Record railway official feedback"),
    "feedback.read": ("feedback", "View feedback"),
    "feedback.review": ("feedback", "Verify railway feedback, void passenger feedback"),
    "complaints.create": ("complaints", "Raise complaints"),
    "complaints.read": ("complaints", "View complaints"),
    "complaints.manage": ("complaints", "Process, forward and close complaints"),
    "inventory.read": ("inventory", "View journey inventory"),
    "inventory.transact": ("inventory", "Record inventory issue/return"),
    "reports.read": ("reports", "Read reports"),
    "dashboard.read": ("reports", "Read dashboard metrics"),
    "media.upload": ("media", "Upload media evidence"),
}

_ALL = set(PERMISSIONS)
_FIELD = {
    "trains.read", "journeys.read", "attendance.submit", "attendance.read", "inspections.submit", "inspections.read",
    "feedback.collect", "feedback.railway.submit", "feedback.read", "complaints.create", "complaints.read",
    "inventory.read", "inventory.transact", "media.upload",
}

DEFAULT_GRANTS: dict[RoleId, set[str]] = {
    RoleId.SUPER_ADMIN: _ALL,
    RoleId.ADMIN: _ALL - {"divisions.manage"},
    RoleId.MANAGER: {
        "users.read", "users.manage", "trains.read", "trains.manage", "journeys.read", "journeys.read_all",
        "journeys.manage", "staff.manage", "attendance.read", "attendance.review", "inspections.read",
        "inspections.review", "feedback.read", "feedback.review", "complaints.create", "complaints.read",
        "complaints.manage", "inventory.read", "inventory.transact", "reports.read", "dashboard.read", "media.upload",
    },
    RoleId.SUPERVISOR: _FIELD,
    RoleId.JANITOR: {"journeys.read", "attendance.submit", "attendance.read", "media.upload"},
    RoleId.CONTRACTOR: {
        "trains.read", "journeys.read", "journeys.read_all", "attendance.read", "inspections.read", "feedback.read",
        "complaints.read", "inventory.read", "reports.read", "dashboard.read",
    },
}

# Who may create/modify/see whom (visibility hierarchy).
MANAGEABLE_ROLES: dict[RoleId, set[RoleId]] = {
    RoleId.SUPER_ADMIN: {RoleId.ADMIN, RoleId.MANAGER, RoleId.SUPERVISOR, RoleId.JANITOR, RoleId.CONTRACTOR},
    RoleId.ADMIN: {RoleId.MANAGER, RoleId.SUPERVISOR, RoleId.JANITOR, RoleId.CONTRACTOR},
    RoleId.MANAGER: {RoleId.SUPERVISOR, RoleId.JANITOR},
    RoleId.SUPERVISOR: set(),
    RoleId.JANITOR: set(),
    RoleId.CONTRACTOR: set(),
}

# Roles that may hold temporary charge of another division.
CHARGE_ELIGIBLE_ROLES = {RoleId.ADMIN, RoleId.MANAGER, RoleId.CONTRACTOR}
