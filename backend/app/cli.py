"""Operational bootstrap. Usage:
    python -m app.cli create-division --code JBP --name "Jabalpur Division"
    python -m app.cli create-superadmin --division-code JBP --emp-id SA001 --name "..." --email a@b.c [--firebase-uid UID]
The Super Admin signs in with Firebase; the account links on first sign-in with a verified email, or immediately
when --firebase-uid is given.

Both commands are idempotent: re-running with the same values reports the existing record and changes nothing.
A value that conflicts with an existing record (same division code with another name, same e-mail or employee ID
belonging to someone else, a different Firebase UID) is refused, never overwritten. Nothing here contacts
Firebase: accounts are only mapped to Firebase identities that already exist."""

import argparse
import sys

from sqlalchemy import func, or_, select

from app.db import get_sessionmaker, write_intent
from app.models import Division, RoleId, User, UserStatus
from app.services.common import audit


def _division(db, code: str, name: str) -> int:
    existing = db.scalar(select(Division).where(Division.code == code))
    if existing is not None:
        if existing.name != name:
            print(f"division {code} already exists with name {existing.name!r}; not changed", file=sys.stderr)
            return 2
        print(f"division {existing.code} {existing.id} (already exists)")
        return 0
    division = Division(code=code, name=name)
    db.add(division)
    db.flush()
    audit(db, actor_id=None, action="division.create.cli", entity=division, division_id=division.id)
    db.commit()
    print(f"division {division.code} {division.id}")
    return 0


def _superadmin(db, args) -> int:
    division = db.scalar(select(Division).where(Division.code == args.division_code.upper()))
    if division is None:
        print("division not found", file=sys.stderr)
        return 1
    email = args.email.lower()
    matches = db.scalars(select(User).where(User.status != UserStatus.DELETED,
                                            or_(func.lower(User.email) == email, User.emp_id == args.emp_id))).all()
    if matches:
        user = matches[0]
        same = (len(matches) == 1 and (user.email or "").lower() == email and user.emp_id == args.emp_id
                and user.role_id == RoleId.SUPER_ADMIN and user.division_id == division.id)
        if not same:
            print("a different user already has this e-mail or employee ID; nothing changed", file=sys.stderr)
            return 2
        if args.firebase_uid and user.firebase_uid not in (None, args.firebase_uid):
            print("this user is already linked to a different Firebase account; nothing changed", file=sys.stderr)
            return 2
        if args.firebase_uid and user.firebase_uid is None:
            user.firebase_uid = args.firebase_uid
            audit(db, actor_id=None, action="user.link.cli", entity=user, division_id=division.id)
            db.commit()
            print(f"super admin {user.id} (already exists; linked to the given Firebase UID)")
            return 0
        print(f"super admin {user.id} (already exists)")
        return 0
    user = User(emp_id=args.emp_id, name=args.name, email=email, firebase_uid=args.firebase_uid,
                role_id=RoleId.SUPER_ADMIN, division_id=division.id, status=UserStatus.ACTIVE)
    db.add(user)
    db.flush()
    audit(db, actor_id=None, action="user.create.cli", entity=user, division_id=division.id, changes={"role": "super_admin"})
    db.commit()
    print(f"super admin {user.id}")
    return 0


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

    # The whole check-then-create runs under the database write lock (SQLite), so two concurrent runs
    # cannot both create the record.
    with write_intent(), get_sessionmaker()() as db:
        if args.cmd == "create-division":
            return _division(db, args.code.upper(), args.name)
        return _superadmin(db, args)


if __name__ == "__main__":
    raise SystemExit(main())
