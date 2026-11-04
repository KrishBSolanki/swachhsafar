// Errors raised by local business rules and constraint checks. `code` matches the backend error
// codes where one exists (duplicate_attendance, stage_order, ...), so screens can treat both alike.

export class LocalRuleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LocalRuleError';
    this.code = code;
    this.details = details;
  }
}

const UNIQUE_CODES = {
  attendance_records: 'duplicate_attendance',
  inspection_records: 'duplicate_inspection',
  sync_outbox: 'duplicate_operation',
  media_files: 'duplicate_media',
};

// Turns a SQLite constraint failure into a LocalRuleError with a stable code. Trigger messages are
// written as "<code>: <message>". Anything unrecognised is returned unchanged.
// Device storage exhausted (OPFS quota or SQLite "database or disk is full").
export const isStorageFull = (e) => e?.name === 'QuotaExceededError' || e?.code === 13 || e?.code === 'SQLITE_FULL'
  || /quota|disk is full|SQLITE_FULL/i.test(String(e?.message ?? ''));
export const storageFullError = () => new LocalRuleError(
  'storage_full', 'Device storage is full. Nothing was saved. Free up space on the phone (or sync and remove old media), then try again.',
);

export function mapSqliteError(e) {
  if (e instanceof LocalRuleError) return e;
  if (isStorageFull(e)) return storageFullError();
  const msg = String(e?.message ?? '');
  const trigger = msg.match(/\b(stage_order|round_order|phase_order|return_exceeds_issue|immutable): ([^\n]+)/);
  if (trigger) return new LocalRuleError(trigger[1], trigger[2].trim());
  const unique = msg.match(/UNIQUE constraint failed: (\w+)\./);
  if (unique) {
    const code = UNIQUE_CODES[unique[1]] ?? 'duplicate';
    return new LocalRuleError(code, code === 'duplicate_attendance'
      ? 'Attendance is already recorded for this stage.'
      : code === 'duplicate_inspection'
        ? 'This coach, day, round and phase is already inspected.'
        : 'This record already exists on the device.');
  }
  if (/FOREIGN KEY constraint failed/.test(msg)) {
    return new LocalRuleError('reference_missing', 'A referenced record is not available on this device.');
  }
  if (/CHECK constraint failed/.test(msg)) {
    return new LocalRuleError('invalid_value', `A value is outside the allowed range (${msg.replace(/^.*CHECK constraint failed:\s*/, '')}).`);
  }
  return e;
}
