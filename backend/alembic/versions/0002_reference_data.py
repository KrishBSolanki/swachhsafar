"""reference data (roles, permission catalog, default grants) and append-only guards

Revision ID: 0002
Revises: 0001
"""
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

# Snapshot of app.security.catalog at the time of this migration. Later catalog changes need their own migration.
ROLES = [(1, "super_admin", "Super Admin", 1), (2, "admin", "Admin", 2), (3, "manager", "Manager", 3),
         (4, "supervisor", "Supervisor/EHK", 4), (5, "janitor", "Janitor", 5), (6, "contractor", "Contractor", 6)]


APPEND_ONLY = ("inventory_transactions", "audit_logs", "complaint_history")


def upgrade() -> None:
    from app.security.catalog import DEFAULT_GRANTS, PERMISSIONS

    roles = sa.table("roles", sa.column("id", sa.Integer), sa.column("code", sa.String), sa.column("name", sa.String),
                     sa.column("level", sa.Integer))
    perms = sa.table("permissions", sa.column("code", sa.String), sa.column("module", sa.String), sa.column("description", sa.String))
    grants = sa.table("role_permissions", sa.column("id", sa.Uuid), sa.column("role_id", sa.Integer),
                      sa.column("permission_code", sa.String), sa.column("division_id", sa.Uuid), sa.column("effect", sa.String))
    op.bulk_insert(roles, [dict(id=i, code=c, name=n, level=lv) for i, c, n, lv in ROLES])
    op.bulk_insert(perms, [dict(code=c, module=m, description=d) for c, (m, d) in PERMISSIONS.items()])
    op.bulk_insert(grants, [dict(id=uuid.uuid4(), role_id=int(role), permission_code=code, division_id=None, effect="allow")
                            for role, codes in DEFAULT_GRANTS.items() for code in sorted(codes)])

    if op.get_bind().dialect.name == "sqlite":
        # Same guarantee on the local SQLite deployment: any UPDATE or DELETE of these rows is aborted.
        for table in APPEND_ONLY:
            for event in ("UPDATE", "DELETE"):
                op.execute(f"CREATE TRIGGER {table}_append_only_{event.lower()} BEFORE {event} ON {table} "
                           f"BEGIN SELECT RAISE(ABORT, '{table} is append-only'); END")
        return
    op.execute("""
        CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
        END $$;
    """)
    for table in APPEND_ONLY:
        op.execute(f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON {table} "
                   f"FOR EACH ROW EXECUTE FUNCTION forbid_mutation()")


def downgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        for table in APPEND_ONLY:
            for event in ("update", "delete"):
                op.execute(f"DROP TRIGGER IF EXISTS {table}_append_only_{event}")
    else:
        for table in APPEND_ONLY:
            op.execute(f"DROP TRIGGER IF EXISTS {table}_append_only ON {table}")
        op.execute("DROP FUNCTION IF EXISTS forbid_mutation()")
    op.execute("DELETE FROM role_permissions")
    op.execute("DELETE FROM permissions")
    op.execute("DELETE FROM roles")
