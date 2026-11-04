# Swachh Safar — Phase 2: Operational SQLite Foundation

The device-side SQLite database (sqlite-wasm, OPFS SAH-pool VFS, one dedicated worker) is now the primary
operational store. Records are written locally first, then pushed to FastAPI. The server is never needed to
save a record.

```
Screens ──► localFirstApi (GET) ──► FastAPI when reachable ──► ingest into SQLite + overlay pending records
   │                         └────► localApi (SQLite)       when offline / unreachable  (flagged "stale")
   └─────► operationsQueue.submit ─► localStore.capture: ONE transaction =
                                        media_files + record + sync_outbox + audit_events
                                     media bytes ─► OPFS  swachh-media/<uuid>   (worker, sync access handles)
           operationsQueue.flush  ─► POST /media, PUT /media/{id}/content, POST /sync/batch
           operationsQueue.pull   ─► GET /sync/changes?since=<checkpoint>  ─► master data + journeys
```

## Reused (unchanged in behaviour)

`sqlite.worker.js` (one connection, now also owns media files) · `oo1Adapter` · `migrations.js` (`PRAGMA user_version`)
· `sync_outbox` + `outboxRepository` (same status lifecycle, same one-open-op-per-entity index) · `operationsQueue`
(same `/sync/batch` + media protocol; `submit` now writes the record first) · `apiClient` · `syncService` /
`registrationService` / PBKDF2 (untouched) · `VITE_DEMO_MODE` (still sample GET data only).

## Migrations (`src/database/operationalMigrations.js`)

| v | Tables |
|---|---|
| 3 | `divisions`, `operating_policies`, `roles` (seeded 1–6), `permissions`, `user_profiles`, `user_division_assignments`, `user_division_permissions`, `authorization_snapshots`, `local_sessions`, `trains`, `train_coaches`, `question_banks`, `feedback_questions`, `inventory_items`, `complaint_departments`, `complaint_categories`. Copies the Phase 1 `sync_meta.session_me` cache into `authorization_snapshots`. |
| 4 | `media_files`, `sync_conflicts`, `sync_tombstones`, `sync_checkpoints`, `audit_events` (append-only triggers) |
| 5 | `journeys`, `journey_coaches`, `journey_staff`, `attendance_records`, `inspection_records` |
| 6 | `passenger_feedback` (+ratings), `railway_feedback` (+ratings), `complaints`, `complaint_history`, `complaint_attachments`, `inventory_transactions` |
| 7 | `sync_outbox.owner_user_id` (CP-02): queued operations are delivered only with their capturing user's session. See `docs/CHECKPOINTS.md`. |

Every operational record has a UUID `id`, `division_id`, `created_at`, `updated_at`, `sync_status`
(`pending | synced | rejected | conflict`), `origin` (`local | server`) and `schema_version`.
Rules enforced **in SQL** (so concurrent writes cannot bypass them):

- attendance: unique `(journey, employee, stage)` among live rows; stage *n* needs *n−1* (trigger); captured facts immutable.
- inspection: unique `(journey, coach, day, round, phase)`; round order and Before-before-After (triggers); coach must be on the journey (composite FK).
- complaint history and audit events: no UPDATE/DELETE.
- inventory: no UPDATE of facts, no DELETE; a return can't exceed the issued quantity (trigger).
- rejected/conflict rows release their slot, so the stage/slot can be captured again.

## Repositories (`src/database/`)

`masterDataRepository`, `identityRepository`, `journeyRepository`, `attendanceRepository`, `inspectionRepository`,
`feedbackRepository`, `complaintRepository`, `inventoryRepository`, `mediaStore`, `syncStateRepository`, composed by
`src/services/localStore.js`. Business dates use Asia/Kolkata (`src/utils/businessDate.js`).

## What works offline (tested with the network disconnected)

Covered by `npm run test:e2e:offline`: sign-in with cached authorization, journey lists/detail, attendance (5 stages),
coach inspection, passenger feedback details, railway feedback with ratings, complaint creation, and lists showing
unsynced records. All of these survive a reload and a full browser restart, and are delivered once on reconnect.

**Online only (need the server):** journey create/edit/cancel/supervisor/staff changes, complaint status changes,
PNR verification, OTP send/verify, passenger ratings, master-data administration, reports and audit. Offline these
fail with "This action needs a connection…"; nothing is faked. Confirmed server responses are stored locally.

## Commands

```bash
npm test                    # unit tests (real SQLite in-memory/file)
npm run test:e2e:offline    # Chromium, production build, fake Firebase project, no external requests
npm run build               # production build  -> dist/
npm run build:demo          # demo build        -> dist-demo/
```
