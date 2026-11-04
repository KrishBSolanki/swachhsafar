// Phase 2 operational schema (migrations v3–v6). The device-side SQLite database is the primary
// operational store: records are written here first and pushed to FastAPI from sync_outbox.
//
// Conventions for every operational table:
//   id              TEXT UUID. Device-generated for local captures, server UUID for pulled rows.
//   sync_status     'pending' (in the outbox, not acknowledged) | 'synced' | 'rejected' | 'conflict'.
//                   Reference data pulled from the server is 'synced'.
//   origin          'local' (captured on this device) | 'server' (pulled/ingested).
//   schema_version  Record-format version, so later phases can migrate rows lazily.
//   created_at / updated_at  ISO-8601 UTC.
// Business dates (journey_date, captured_on, feedback_date) are Asia/Kolkata calendar dates (YYYY-MM-DD).
//
// Released migrations are frozen: never edit one, append a new one. The column snippets below are
// therefore local to each migration rather than shared.

const ROLES = [
  [1, 'Super Admin'], [2, 'Admin'], [3, 'Manager'], [4, 'Supervisor/EHK'], [5, 'Janitor'], [6, 'Contractor'],
];

const v3Common = `sync_status TEXT NOT NULL DEFAULT 'synced',
        schema_version INTEGER NOT NULL DEFAULT 1,
        server_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL`;

const V3 = {
  version: 3,
  name: 'reference data, identity and authorization',
  statements: [
    `CREATE TABLE divisions (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_placeholder INTEGER NOT NULL DEFAULT 0,
        ${v3Common}
      )`,
    `CREATE TABLE operating_policies (
        division_id TEXT PRIMARY KEY REFERENCES divisions(id) ON DELETE CASCADE,
        settings TEXT NOT NULL CHECK (json_valid(settings)),
        ${v3Common}
      )`,
    `CREATE TABLE roles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ...ROLES.map(([id, name]) => `INSERT INTO roles (id, name, created_at, updated_at)
        VALUES (${id}, '${name}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    `CREATE TABLE permissions (
        code TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )`,
    // People known to this device: the signed-in employee and colleagues from journey allocations.
    // division_id is a plain reference: a colleague's home division can be outside this device's scope.
    `CREATE TABLE user_profiles (
        id TEXT PRIMARY KEY,
        emp_id TEXT,
        name TEXT NOT NULL,
        name_hindi TEXT,
        email TEXT,
        mobile TEXT,
        gender TEXT,
        designation TEXT,
        lang TEXT,
        role_id INTEGER REFERENCES roles(id),
        division_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        firebase_linked INTEGER,
        local_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        ${v3Common}
      )`,
    'CREATE INDEX idx_user_profiles_email ON user_profiles (email)',
    'CREATE INDEX idx_user_profiles_division_role ON user_profiles (division_id, role_id)',
    `CREATE TABLE user_division_assignments (
        user_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
        division_id TEXT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, division_id)
      )`,
    `CREATE TABLE user_division_permissions (
        user_id TEXT NOT NULL,
        division_id TEXT NOT NULL,
        permission_code TEXT NOT NULL REFERENCES permissions(code),
        PRIMARY KEY (user_id, division_id, permission_code),
        FOREIGN KEY (user_id, division_id) REFERENCES user_division_assignments(user_id, division_id) ON DELETE CASCADE
      )`,
    // Last /auth/me response for the user, used to sign in offline with cached permissions.
    `CREATE TABLE authorization_snapshots (
        user_id TEXT PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
        email TEXT,
        firebase_uid TEXT,
        snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
        fetched_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    'CREATE INDEX idx_authorization_snapshots_email ON authorization_snapshots (email)',
    `CREATE TABLE local_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
        firebase_uid TEXT,
        email TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('online', 'offline')),
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      )`,
    'CREATE INDEX idx_local_sessions_user ON local_sessions (user_id, started_at)',
    // Carry the Phase 1 cached profile (sync_meta 'session_me') into the new tables so a device that
    // upgrades while offline can still sign in with its cached permissions.
    `INSERT OR IGNORE INTO user_profiles (id, emp_id, name, email, role_id, division_id, status, created_at, updated_at)
      SELECT json_extract(value, '$.user.id'), json_extract(value, '$.user.emp_id'),
             COALESCE(json_extract(value, '$.user.name'), ''), lower(json_extract(value, '$.user.email')),
             CASE WHEN json_extract(value, '$.user.role_id') IN (SELECT id FROM roles) THEN json_extract(value, '$.user.role_id') END,
             json_extract(value, '$.user.division_id'), COALESCE(json_extract(value, '$.user.status'), 'active'),
             updated_at, updated_at
      FROM sync_meta
      WHERE key = 'session_me' AND json_valid(value) AND json_extract(value, '$.user.id') IS NOT NULL`,
    `INSERT OR IGNORE INTO authorization_snapshots (user_id, email, snapshot, fetched_at, created_at, updated_at)
      SELECT json_extract(value, '$.user.id'), lower(json_extract(value, '$.user.email')), value, updated_at, updated_at, updated_at
      FROM sync_meta
      WHERE key = 'session_me' AND json_valid(value) AND json_extract(value, '$.user.id') IS NOT NULL`,

    // ---- master data ----
    `CREATE TABLE trains (
        id TEXT PRIMARY KEY,
        division_id TEXT NOT NULL REFERENCES divisions(id),
        train_no TEXT NOT NULL,
        name TEXT NOT NULL,
        linked_train_id TEXT REFERENCES trains(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
        duration_days INTEGER NOT NULL DEFAULT 1,
        operational_days INTEGER NOT NULL DEFAULT 1,
        start_time TEXT,
        end_time TEXT,
        return_start_time TEXT,
        return_end_time TEXT,
        daywise INTEGER NOT NULL DEFAULT 0,
        inspection_rounds_per_day INTEGER NOT NULL DEFAULT 1,
        before_inspection_enabled INTEGER NOT NULL DEFAULT 1,
        after_inspection_enabled INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_placeholder INTEGER NOT NULL DEFAULT 0,
        ${v3Common}
      )`,
    'CREATE INDEX idx_trains_division ON trains (division_id, is_active, train_no)',
    `CREATE TABLE train_coaches (
        train_id TEXT NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('AC', 'NON_AC')),
        position INTEGER NOT NULL,
        PRIMARY KEY (train_id, code)
      )`,
    // division_id NULL = the global default bank, used when a division has no active bank of its own.
    `CREATE TABLE question_banks (
        id TEXT PRIMARY KEY,
        division_id TEXT REFERENCES divisions(id) ON DELETE CASCADE,
        audience TEXT NOT NULL CHECK (audience IN ('passenger', 'railway')),
        name TEXT NOT NULL,
        scale_min INTEGER NOT NULL,
        scale_max INTEGER NOT NULL CHECK (scale_max > scale_min),
        is_active INTEGER NOT NULL DEFAULT 1,
        ${v3Common}
      )`,
    'CREATE INDEX idx_question_banks_scope ON question_banks (audience, division_id, is_active)',
    `CREATE TABLE feedback_questions (
        id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        text_en TEXT NOT NULL,
        text_hi TEXT,
        applies_ac INTEGER NOT NULL DEFAULT 1,
        applies_non_ac INTEGER NOT NULL DEFAULT 1,
        required INTEGER NOT NULL DEFAULT 1,
        psi_weight REAL,
        is_active INTEGER NOT NULL DEFAULT 1
      )`,
    'CREATE INDEX idx_feedback_questions_bank ON feedback_questions (bank_id, position)',
    `CREATE TABLE inventory_items (
        id TEXT PRIMARY KEY,
        division_id TEXT NOT NULL REFERENCES divisions(id),
        name TEXT NOT NULL,
        unit TEXT NOT NULL,
        ideal_qty REAL NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${v3Common}
      )`,
    'CREATE INDEX idx_inventory_items_division ON inventory_items (division_id, is_active, name)',
    `CREATE TABLE complaint_departments (
        id TEXT PRIMARY KEY,
        division_id TEXT NOT NULL REFERENCES divisions(id),
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${v3Common}
      )`,
    `CREATE TABLE complaint_categories (
        id TEXT PRIMARY KEY,
        division_id TEXT NOT NULL REFERENCES divisions(id),
        parent_id TEXT REFERENCES complaint_categories(id) DEFERRABLE INITIALLY DEFERRED,
        name TEXT NOT NULL,
        default_department_id TEXT REFERENCES complaint_departments(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
        sla_hours INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        ${v3Common}
      )`,
    'CREATE INDEX idx_complaint_categories_division ON complaint_categories (division_id, is_active, sort_order)',
  ],
};

const V4 = {
  version: 4,
  name: 'media metadata, sync conflicts, tombstones, checkpoints and audit events',
  statements: [
    // The bytes live in OPFS (see mediaStore.js); this row is the metadata and upload state.
    `CREATE TABLE media_files (
        id TEXT PRIMARY KEY,
        owner_table TEXT,
        owner_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('attendance_photo', 'inspection_photo', 'inspection_video', 'feedback_voice', 'complaint_attachment')),
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        storage_path TEXT NOT NULL UNIQUE,
        division_id TEXT,
        upload_status TEXT NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending', 'uploaded', 'failed')),
        uploaded_at TEXT,
        last_error TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    'CREATE INDEX idx_media_files_owner ON media_files (owner_table, owner_id)',
    'CREATE INDEX idx_media_files_upload ON media_files (upload_status, created_at)',
    `CREATE TABLE sync_conflicts (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        outbox_id TEXT,
        operation TEXT,
        outcome TEXT NOT NULL,
        code TEXT,
        message TEXT,
        server_detail TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'discarded')),
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      )`,
    'CREATE INDEX idx_sync_conflicts_status ON sync_conflicts (status, detected_at)',
    'CREATE INDEX idx_sync_conflicts_entity ON sync_conflicts (entity_type, entity_id)',
    `CREATE TABLE sync_tombstones (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('local', 'server')),
        reason TEXT,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      )`,
    `CREATE TABLE sync_checkpoints (
        scope TEXT PRIMARY KEY,
        cursor TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      )`,
    `CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor_id TEXT,
        division_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details TEXT CHECK (details IS NULL OR json_valid(details)),
        schema_version INTEGER NOT NULL DEFAULT 1
      )`,
    'CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id, occurred_at)',
    'CREATE INDEX idx_audit_events_time ON audit_events (occurred_at)',
    `CREATE TRIGGER trg_audit_events_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'immutable: audit events are append-only'); END`,
    `CREATE TRIGGER trg_audit_events_no_delete BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'immutable: audit events are append-only'); END`,
  ],
};

const v5Sync = `origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'server')),
        server_timestamp TEXT,
        synced_at TEXT,
        last_sync_error TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'rejected', 'conflict')),
        schema_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL`;
const v5Gps = `latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
        longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
        gps_accuracy_m REAL`;
// Rejected and conflicting records stay for the user to see, but no longer occupy their slot.
const LIVE = `sync_status NOT IN ('rejected', 'conflict')`;

const V5 = {
  version: 5,
  name: 'journeys, staff allocation, attendance and coach inspections',
  statements: [
    `CREATE TABLE journeys (
        id TEXT PRIMARY KEY,
        division_id TEXT NOT NULL REFERENCES divisions(id),
        train_id TEXT NOT NULL REFERENCES trains(id),
        linked_train_id TEXT REFERENCES trains(id),
        train_no TEXT NOT NULL,
        train_name TEXT NOT NULL,
        linked_train_no TEXT,
        journey_date TEXT NOT NULL,
        outbound_end_date TEXT,
        linked_journey_date TEXT,
        end_date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        return_start_time TEXT,
        return_end_time TEXT,
        duration_days INTEGER NOT NULL DEFAULT 1,
        operational_days INTEGER NOT NULL DEFAULT 1,
        daywise INTEGER NOT NULL DEFAULT 0,
        inspection_rounds_per_day INTEGER NOT NULL DEFAULT 1,
        before_inspection_enabled INTEGER NOT NULL DEFAULT 1,
        after_inspection_enabled INTEGER NOT NULL DEFAULT 1,
        supervisor_id TEXT NOT NULL REFERENCES user_profiles(id),
        created_by_id TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'cancelled')),
        cancel_reason TEXT,
        cancelled_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        server_updated_at TEXT,
        ${v5Sync},
        CHECK (end_date >= journey_date)
      )`,
    'CREATE INDEX idx_journeys_division_dates ON journeys (division_id, status, journey_date, end_date)',
    'CREATE INDEX idx_journeys_supervisor ON journeys (supervisor_id, journey_date)',
    // A journey's own coach list (it can differ from the train's). Removed coaches are deactivated,
    // not deleted, because inspections and feedback keep referencing them.
    `CREATE TABLE journey_coaches (
        journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('AC', 'NON_AC')),
        position INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (journey_id, code)
      )`,
    `CREATE TABLE journey_staff (
        id TEXT PRIMARY KEY,
        journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user_profiles(id),
        role_id INTEGER,
        allocated_at TEXT NOT NULL,
        removed_at TEXT,
        ${v5Sync}
      )`,
    'CREATE UNIQUE INDEX idx_journey_staff_active ON journey_staff (journey_id, user_id) WHERE removed_at IS NULL',
    'CREATE INDEX idx_journey_staff_user ON journey_staff (user_id, journey_id)',

    `CREATE TABLE attendance_records (
        id TEXT PRIMARY KEY,
        journey_id TEXT NOT NULL REFERENCES journeys(id),
        division_id TEXT NOT NULL REFERENCES divisions(id),
        employee_id TEXT NOT NULL REFERENCES user_profiles(id),
        stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 5),
        ${v5Gps},
        device_timestamp TEXT,
        captured_on TEXT,
        photo_media_id TEXT REFERENCES media_files(id),
        recorded_by_id TEXT,
        verification_status TEXT,
        ${v5Sync}
      )`,
    `CREATE UNIQUE INDEX idx_attendance_slot ON attendance_records (journey_id, employee_id, stage) WHERE ${LIVE}`,
    'CREATE INDEX idx_attendance_journey ON attendance_records (journey_id, employee_id, stage)',
    'CREATE INDEX idx_attendance_captured ON attendance_records (division_id, captured_on)',
    `CREATE TRIGGER trg_attendance_stage_order BEFORE INSERT ON attendance_records
      WHEN NEW.origin = 'local' AND NEW.stage > 1 AND NOT EXISTS (
        SELECT 1 FROM attendance_records a WHERE a.journey_id = NEW.journey_id AND a.employee_id = NEW.employee_id
          AND a.stage = NEW.stage - 1 AND a.${LIVE})
      BEGIN SELECT RAISE(ABORT, 'stage_order: the previous attendance stage must be recorded first'); END`,
    `CREATE TRIGGER trg_attendance_immutable BEFORE UPDATE OF journey_id, employee_id, stage, device_timestamp, photo_media_id
      ON attendance_records
      BEGIN SELECT RAISE(ABORT, 'immutable: captured attendance cannot be changed'); END`,

    `CREATE TABLE inspection_records (
        id TEXT PRIMARY KEY,
        journey_id TEXT NOT NULL REFERENCES journeys(id),
        division_id TEXT NOT NULL REFERENCES divisions(id),
        coach_code TEXT NOT NULL,
        coach_class TEXT CHECK (coach_class IN ('AC', 'NON_AC')),
        day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 30),
        round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 20),
        phase TEXT NOT NULL CHECK (phase IN ('B', 'A')),
        ${v5Gps},
        device_timestamp TEXT,
        captured_on TEXT,
        photo_media_id TEXT REFERENCES media_files(id),
        video_media_id TEXT REFERENCES media_files(id),
        comments TEXT CHECK (comments IS NULL OR length(comments) <= 2000),
        completion_status TEXT NOT NULL DEFAULT 'completed' CHECK (completion_status IN ('completed', 'draft')),
        inspector_id TEXT,
        verification_status TEXT,
        ${v5Sync},
        FOREIGN KEY (journey_id, coach_code) REFERENCES journey_coaches(journey_id, code)
      )`,
    `CREATE UNIQUE INDEX idx_inspection_slot ON inspection_records (journey_id, coach_code, day, round, phase) WHERE ${LIVE}`,
    'CREATE INDEX idx_inspection_journey ON inspection_records (journey_id, day, coach_code)',
    'CREATE INDEX idx_inspection_captured ON inspection_records (division_id, captured_on)',
    `CREATE TRIGGER trg_inspection_round_order BEFORE INSERT ON inspection_records
      WHEN NEW.origin = 'local' AND NEW.round > 1 AND NOT EXISTS (
        SELECT 1 FROM inspection_records i WHERE i.journey_id = NEW.journey_id AND i.coach_code = NEW.coach_code
          AND i.day = NEW.day AND i.round = NEW.round - 1 AND i.phase = NEW.phase AND i.${LIVE})
      BEGIN SELECT RAISE(ABORT, 'round_order: the previous round of this phase must be recorded first'); END`,
    `CREATE TRIGGER trg_inspection_phase_order BEFORE INSERT ON inspection_records
      WHEN NEW.origin = 'local' AND NEW.phase = 'A'
        AND (SELECT before_inspection_enabled FROM journeys WHERE id = NEW.journey_id) = 1
        AND NOT EXISTS (
          SELECT 1 FROM inspection_records i WHERE i.journey_id = NEW.journey_id AND i.coach_code = NEW.coach_code
            AND i.day = NEW.day AND i.round = NEW.round AND i.phase = 'B' AND i.${LIVE})
      BEGIN SELECT RAISE(ABORT, 'phase_order: the Before inspection of this round must be recorded first'); END`,
    `CREATE TRIGGER trg_inspection_immutable BEFORE UPDATE OF journey_id, coach_code, day, round, phase, device_timestamp,
        photo_media_id, video_media_id ON inspection_records
      BEGIN SELECT RAISE(ABORT, 'immutable: captured inspections cannot be changed'); END`,
  ],
};

const v6Sync = v5Sync;
const v6Gps = v5Gps;
const MOBILE_GLOB = "'[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'";
const PNR_GLOB = "'[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'";

const V6 = {
  version: 6,
  name: 'feedback, complaints and inventory',
  statements: [
    // PNR and OTP are verified by the server only. pnr_status/otp_status hold the pending
    // integration state captured offline until the online verification step runs.
    `CREATE TABLE passenger_feedback (
        id TEXT PRIMARY KEY,
        journey_id TEXT NOT NULL REFERENCES journeys(id),
        division_id TEXT NOT NULL REFERENCES divisions(id),
        bank_id TEXT REFERENCES question_banks(id),
        coach_code TEXT NOT NULL,
        coach_class TEXT CHECK (coach_class IN ('AC', 'NON_AC')),
        journey_day INTEGER NOT NULL CHECK (journey_day BETWEEN 1 AND 30),
        feedback_date TEXT,
        passenger_name TEXT NOT NULL CHECK (length(passenger_name) BETWEEN 2 AND 100),
        mobile TEXT CHECK (mobile IS NULL OR mobile GLOB ${MOBILE_GLOB}),
        mobile_masked TEXT,
        pnr TEXT CHECK (pnr IS NULL OR pnr GLOB ${PNR_GLOB}),
        seat_no TEXT CHECK (seat_no IS NULL OR length(seat_no) <= 10),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'completed', 'void')),
        pnr_status TEXT NOT NULL CHECK (pnr_status IN ('pending', 'valid', 'invalid', 'not_required')),
        otp_status TEXT NOT NULL CHECK (otp_status IN ('not_sent', 'sent', 'verified', 'locked', 'not_required')),
        void_reason TEXT,
        comments TEXT CHECK (comments IS NULL OR length(comments) <= 2000),
        voice_media_id TEXT REFERENCES media_files(id),
        ${v6Gps},
        device_timestamp TEXT,
        collected_by_id TEXT,
        verified_at TEXT,
        completed_at TEXT,
        ${v6Sync},
        FOREIGN KEY (journey_id, coach_code) REFERENCES journey_coaches(journey_id, code)
      )`,
    'CREATE INDEX idx_passenger_feedback_journey ON passenger_feedback (journey_id, coach_code, journey_day)',
    'CREATE INDEX idx_passenger_feedback_division ON passenger_feedback (division_id, feedback_date)',
    `CREATE TABLE passenger_feedback_ratings (
        feedback_id TEXT NOT NULL REFERENCES passenger_feedback(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES feedback_questions(id),
        value INTEGER NOT NULL,
        PRIMARY KEY (feedback_id, question_id)
      )`,
    `CREATE TABLE railway_feedback (
        id TEXT PRIMARY KEY,
        journey_id TEXT NOT NULL REFERENCES journeys(id),
        division_id TEXT NOT NULL REFERENCES divisions(id),
        bank_id TEXT REFERENCES question_banks(id),
        coach_code TEXT,
        journey_day INTEGER NOT NULL CHECK (journey_day BETWEEN 1 AND 30),
        feedback_date TEXT,
        railway_employee_id TEXT NOT NULL CHECK (length(railway_employee_id) BETWEEN 2 AND 32),
        official_name TEXT NOT NULL CHECK (length(official_name) BETWEEN 2 AND 100),
        designation TEXT CHECK (designation IS NULL OR length(designation) <= 100),
        comments TEXT CHECK (comments IS NULL OR length(comments) <= 2000),
        ${v6Gps},
        device_timestamp TEXT,
        submitted_by_id TEXT,
        ${v6Sync},
        FOREIGN KEY (journey_id, coach_code) REFERENCES journey_coaches(journey_id, code)
      )`,
    'CREATE INDEX idx_railway_feedback_journey ON railway_feedback (journey_id, journey_day)',
    `CREATE TABLE railway_feedback_ratings (
        feedback_id TEXT NOT NULL REFERENCES railway_feedback(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES feedback_questions(id),
        value INTEGER NOT NULL,
        PRIMARY KEY (feedback_id, question_id)
      )`,

    // complaint_no is assigned by the server; due_at is provisional until the server confirms it.
    `CREATE TABLE complaints (
        id TEXT PRIMARY KEY,
        complaint_no TEXT UNIQUE,
        division_id TEXT NOT NULL REFERENCES divisions(id),
        journey_id TEXT REFERENCES journeys(id),
        train_id TEXT REFERENCES trains(id),
        coach_code TEXT,
        coach_class TEXT CHECK (coach_class IN ('AC', 'NON_AC')),
        category_id TEXT NOT NULL REFERENCES complaint_categories(id),
        subcategory_id TEXT REFERENCES complaint_categories(id),
        description TEXT NOT NULL CHECK (length(description) BETWEEN 5 AND 4000),
        latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
        longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
        department_id TEXT REFERENCES complaint_departments(id),
        assigned_to_id TEXT,
        status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'in_process', 'forwarded', 'completed')),
        sla_hours INTEGER NOT NULL CHECK (sla_hours > 0),
        due_at TEXT NOT NULL,
        due_at_provisional INTEGER NOT NULL DEFAULT 0,
        resolution_remarks TEXT,
        closed_at TEXT,
        closed_by_id TEXT,
        created_by_id TEXT,
        device_timestamp TEXT,
        ${v6Sync}
      )`,
    'CREATE INDEX idx_complaints_division_status ON complaints (division_id, status, created_at)',
    'CREATE INDEX idx_complaints_journey ON complaints (journey_id)',
    `CREATE TABLE complaint_history (
        id TEXT PRIMARY KEY,
        complaint_id TEXT NOT NULL REFERENCES complaints(id),
        from_status TEXT CHECK (from_status IS NULL OR from_status IN ('created', 'in_process', 'forwarded', 'completed')),
        to_status TEXT NOT NULL CHECK (to_status IN ('created', 'in_process', 'forwarded', 'completed')),
        actor_id TEXT,
        forwarded_to_id TEXT,
        department_id TEXT,
        remarks TEXT,
        origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'server')),
        created_at TEXT NOT NULL
      )`,
    'CREATE INDEX idx_complaint_history_complaint ON complaint_history (complaint_id, created_at)',
    `CREATE TRIGGER trg_complaint_history_no_update BEFORE UPDATE ON complaint_history
      BEGIN SELECT RAISE(ABORT, 'immutable: complaint history is append-only'); END`,
    `CREATE TRIGGER trg_complaint_history_no_delete BEFORE DELETE ON complaint_history
      BEGIN SELECT RAISE(ABORT, 'immutable: complaint history is append-only'); END`,
    `CREATE TABLE complaint_attachments (
        complaint_id TEXT NOT NULL REFERENCES complaints(id),
        media_id TEXT NOT NULL REFERENCES media_files(id),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (complaint_id, media_id)
      )`,

    `CREATE TABLE inventory_transactions (
        id TEXT PRIMARY KEY,
        journey_id TEXT NOT NULL REFERENCES journeys(id),
        division_id TEXT NOT NULL REFERENCES divisions(id),
        item_id TEXT NOT NULL REFERENCES inventory_items(id),
        coach_code TEXT,
        txn_type TEXT NOT NULL CHECK (txn_type IN ('issue', 'return')),
        quantity REAL NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
        unit TEXT NOT NULL,
        remarks TEXT CHECK (remarks IS NULL OR length(remarks) <= 300),
        recorded_by_id TEXT,
        device_timestamp TEXT,
        ${v6Sync},
        FOREIGN KEY (journey_id, coach_code) REFERENCES journey_coaches(journey_id, code)
      )`,
    'CREATE INDEX idx_inventory_txn_balance ON inventory_transactions (journey_id, item_id, coach_code)',
    `CREATE TRIGGER trg_inventory_return_limit BEFORE INSERT ON inventory_transactions
      WHEN NEW.txn_type = 'return' AND NEW.quantity > COALESCE((
        SELECT SUM(CASE t.txn_type WHEN 'issue' THEN t.quantity ELSE -t.quantity END) FROM inventory_transactions t
        WHERE t.journey_id = NEW.journey_id AND t.item_id = NEW.item_id AND t.coach_code IS NEW.coach_code
          AND t.${LIVE}), 0) + 1e-9
      BEGIN SELECT RAISE(ABORT, 'return_exceeds_issue: the return is larger than the quantity issued'); END`,
    `CREATE TRIGGER trg_inventory_immutable BEFORE UPDATE OF journey_id, division_id, item_id, coach_code, txn_type, quantity,
        unit, remarks, recorded_by_id, device_timestamp, created_at ON inventory_transactions
      BEGIN SELECT RAISE(ABORT, 'immutable: inventory transactions cannot be changed'); END`,
    `CREATE TRIGGER trg_inventory_no_delete BEFORE DELETE ON inventory_transactions
      BEGIN SELECT RAISE(ABORT, 'immutable: inventory transactions cannot be deleted'); END`,
  ],
};


// v7: every queued operation belongs to the user who captured it, so a shared device never delivers
// one user's records with another user's credentials. Existing operational entries are attributed
// from their record's actor column; entries queued before Phase 2 (no local record) stay NULL.
const V7 = {
  version: 7,
  name: 'sync_outbox owner',
  statements: [
    'ALTER TABLE sync_outbox ADD COLUMN owner_user_id TEXT',
    `UPDATE sync_outbox SET owner_user_id = CASE operation
        WHEN 'attendance.create' THEN (SELECT recorded_by_id FROM attendance_records WHERE id = sync_outbox.entity_id)
        WHEN 'inspection.create' THEN (SELECT inspector_id FROM inspection_records WHERE id = sync_outbox.entity_id)
        WHEN 'feedback.passenger.start' THEN (SELECT collected_by_id FROM passenger_feedback WHERE id = sync_outbox.entity_id)
        WHEN 'feedback.railway.create' THEN (SELECT submitted_by_id FROM railway_feedback WHERE id = sync_outbox.entity_id)
        WHEN 'complaint.create' THEN (SELECT created_by_id FROM complaints WHERE id = sync_outbox.entity_id)
        WHEN 'inventory.record' THEN (SELECT recorded_by_id FROM inventory_transactions WHERE id = sync_outbox.entity_id)
      END
      WHERE entity_type = 'operation'`,
    'CREATE INDEX idx_sync_outbox_owner ON sync_outbox (entity_type, owner_user_id, sync_status, created_at)',
  ],
};

// v8: the server's verification state of railway feedback (backend RailwayFeedbackOut). NULL means no
// authoritative status has been received on this device yet; it is never assumed. verified_at orders
// status updates, so an older response cannot overwrite a newer review. Additive only: existing rows and
// queued operations are untouched.
const V8 = {
  version: 8,
  name: 'railway feedback verification status',
  statements: [
    "ALTER TABLE railway_feedback ADD COLUMN verification_status TEXT CHECK (verification_status IS NULL OR verification_status IN ('submitted', 'verified', 'rejected'))",
    'ALTER TABLE railway_feedback ADD COLUMN verified_at TEXT',
    'ALTER TABLE railway_feedback ADD COLUMN verified_by_id TEXT',
    'ALTER TABLE railway_feedback ADD COLUMN status_observed_at TEXT',
  ],
};

export const OPERATIONAL_MIGRATIONS = [V3, V4, V5, V6, V7, V8];
