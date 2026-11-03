// Ordered schema migrations, tracked with SQLite's PRAGMA user_version.
// Never edit a released migration; append a new one instead.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial users and sync_outbox',
    statements: [
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        registration_status TEXT DEFAULT 'pending',
        sync_status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE sync_outbox (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'sync tracking columns and sync_meta',
    statements: [
      'ALTER TABLE users ADD COLUMN firebase_uid TEXT',
      'ALTER TABLE users ADD COLUMN cloud_profile_id TEXT',
      'ALTER TABLE users ADD COLUMN last_sync_error TEXT',
      'ALTER TABLE users ADD COLUMN synced_at TEXT',
      'ALTER TABLE sync_outbox ADD COLUMN last_error TEXT',
      'ALTER TABLE sync_outbox ADD COLUMN updated_at TEXT',
      'ALTER TABLE sync_outbox ADD COLUMN completed_at TEXT',
      'CREATE INDEX idx_sync_outbox_status ON sync_outbox (sync_status, created_at)',
      // At most one open (not completed) operation per entity: duplicate prevention.
      `CREATE UNIQUE INDEX idx_sync_outbox_open_entity
        ON sync_outbox (entity_type, entity_id, operation)
        WHERE sync_status != 'completed'`,
      `CREATE TABLE sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export async function getSchemaVersion(db) {
  const [row] = await db.query('PRAGMA user_version');
  return row.user_version;
}

// Applies each pending migration in its own transaction together with the version bump,
// so a failed migration leaves the database at the previous consistent version.
export async function runMigrations(db) {
  const current = await getSchemaVersion(db);
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await db.transaction([
      ...migration.statements.map((sql) => ({ sql })),
      { sql: `PRAGMA user_version = ${migration.version}` },
    ]);
    applied.push(migration.version);
  }
  return { from: current, to: await getSchemaVersion(db), applied };
}
