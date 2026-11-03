"""Operational bootstrap. Usage:
    python -m app.cli create-division --code JBP --name "Jabalpur Division"
    python -m app.cli create-superadmin --division-code JBP --emp-id SA001 --name "..." --email a@b.c [--firebase-uid UID]
The Super Admin signs in with Firebase; the account links on first sign-in with a verified email, or immediately
when --firebase-uid is given."""

import argparse
import sys

from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import Division, RoleId, User, UserStatus
from app.services.common import audit


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("create-division")
    d.add_argument("--code", required=True)
    d.add_argument("--name", required=True)
    s = sub.add_parser("create-superadmin")
    s.add_argument("--division-code", required=True)
    s.add_argument("--emp-id", required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--email", required=True)
    s.add_argument("--firebase-uid")
    args = parser.parse_args(argv)

    with get_sessionmaker()() as db:
        if args.cmd == "create-division":
            division = Division(code=args.code.upper(), name=args.name)
            db.add(division)
            db.flush()
            audit(db, actor_id=None, action="division.create.cli", entity=division, division_id=division.id)
            db.commit()
            print(f"division {division.code} {division.id}")
            return 0
        division = db.scalar(select(Division).where(Division.code == args.division_code.upper()))
        if division is None:
            print("division not found", file=sys.stderr)
            return 1
        user = User(emp_id=args.emp_id, name=args.name, email=args.email.lower(), firebase_uid=args.firebase_uid,
                    role_id=RoleId.SUPER_ADMIN, division_id=division.id, status=UserStatus.ACTIVE)
        db.add(user)
        db.flush()
        audit(db, actor_id=None, action="user.create.cli", entity=user, division_id=division.id, changes={"role": "super_admin"})
        db.commit()
        print(f"super admin {user.id}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
