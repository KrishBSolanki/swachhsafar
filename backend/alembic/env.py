from logging.config import fileConfig

from alembic import context

from app.config import get_settings
from app.db import make_engine, write_intent
from app.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    return config.attributes.get("database_url") or get_settings().database_url


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # Same engine setup as the app (SQLite: foreign keys, WAL, busy timeout, BEGIN IMMEDIATE). The migration
    # transaction holds the write lock, so two concurrent `alembic upgrade` runs cannot both apply a revision.
    engine = make_engine(_url())
    with write_intent(), engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True,
                          render_as_batch=connection.dialect.name == "sqlite",
                          # SQLite DDL is transactional: the whole upgrade commits or rolls back as one unit.
                          transactional_ddl=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
