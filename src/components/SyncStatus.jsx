import { AlertIcon, CheckIcon, ClockIcon, CloudIcon, DatabaseIcon, RefreshIcon, Spinner } from './Icons.jsx';

const formatTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';

// Per-record status shown in the local registrations list.
export function recordStatus(user, outboxEntry, needsPassword) {
  if (user.sync_status === 'synced') return { key: 'synced', label: 'Synced', tone: 'green' };
  if (user.registration_status === 'conflict') return { key: 'conflict', label: 'Email in use', tone: 'red' };
  if (user.sync_status === 'failed') return { key: 'failed', label: 'Sync failed', tone: 'red' };
  if (outboxEntry?.sync_status === 'processing') return { key: 'syncing', label: 'Syncing…', tone: 'blue' };
  if (needsPassword) return { key: 'needs_password', label: 'Password needed', tone: 'amber' };
  if (user.last_sync_error) return { key: 'retrying', label: 'Retrying', tone: 'amber' };
  return { key: 'pending', label: 'Pending sync', tone: 'amber' };
}

const TONES = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
};

const Badge = ({ tone, children, ...props }) => (
  <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${TONES[tone]}`} {...props}>
    {children}
  </span>
);

function Stat({ icon, label, children, testId }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-slate-50 p-3">
      <span className="mt-0.5 text-teal-700">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <div className="mt-0.5 text-sm font-semibold text-slate-800" data-testid={testId}>{children}</div>
      </div>
    </div>
  );
}

function serviceLabel(check, checking, okLabel, failLabel) {
  if (checking && !check) return { text: 'Checking…', bad: false };
  return check?.ok ? { text: okLabel, bad: false } : { text: failLabel, bad: true };
}

export default function SyncStatus({ db, sync, firebase, online, onSyncNow, onEnterPassword, onRetry }) {
  const dbLabel =
    db.status === 'ready' ? 'Ready · persistent' : db.status === 'error' ? 'Unavailable' : 'Starting…';
  const authLabel = serviceLabel(firebase.auth, firebase.checking, 'Connected', 'Disconnected');
  const firestoreLabel = serviceLabel(firebase.firestore, firebase.checking, 'Connected', 'Error');
  const firebaseErrors = online
    ? [['Firebase Authentication', firebase.auth], ['Firestore', firebase.firestore]].filter(([, c]) => c && !c.ok)
    : [];

  return (
    <section className="card space-y-4" aria-label="Synchronization status">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Sync status</h2>
        <button
          type="button"
          onClick={onSyncNow}
          disabled={!online || sync.running || db.status !== 'ready'}
          className="btn-secondary"
        >
          {sync.running ? <Spinner /> : <RefreshIcon />}
          {sync.running ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat icon={<DatabaseIcon />} label="Local SQLite" testId="db-status">
          <span className={db.status === 'error' ? 'text-red-600' : ''}>{dbLabel}</span>
        </Stat>
        <Stat icon={online ? <CheckIcon /> : <AlertIcon />} label="Internet" testId="internet-status">
          {online ? 'Online' : 'Offline'}
        </Stat>
        <Stat icon={<CloudIcon />} label="Firebase Auth" testId="auth-status">
          <span className={authLabel.bad ? 'text-red-600' : ''}>{authLabel.text}</span>
        </Stat>
        <Stat icon={<CloudIcon />} label="Firestore" testId="firestore-status">
          <span className={firestoreLabel.bad ? 'text-red-600' : ''}>{firestoreLabel.text}</span>
        </Stat>
        <Stat icon={<ClockIcon />} label="Pending sync" testId="pending-count">
          {sync.pendingCount}
        </Stat>
        <Stat icon={<ClockIcon />} label="Last successful sync" testId="last-sync">
          {formatTime(sync.lastSyncAt)}
        </Stat>
      </div>

      {db.status === 'error' && (
        <p className="rounded-2xl bg-red-50 p-3 text-sm text-red-700">{db.error?.message}</p>
      )}
      {firebaseErrors.map(([name, check]) => (
        <p key={name} className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-800">{name}: {check.error}</p>
      ))}
      {sync.lastError && (
        <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-800" data-testid="sync-error">{sync.lastError}</p>
      )}

      {sync.users.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Registrations on this device</h3>
          <ul className="divide-y divide-slate-100 rounded-2xl ring-1 ring-slate-100" data-testid="registrations">
            {sync.users.map((user) => {
              const entry = sync.outbox[user.id];
              const status = recordStatus(user, entry, sync.needsPassword.includes(user.id));
              return (
                <li key={user.id} className="p-3" data-testid="registration-row" data-email={user.email} data-status={status.key}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{user.email}</p>
                      <p className="text-xs text-slate-500">
                        Saved {formatTime(user.created_at)}
                        {entry?.retry_count > 0 && ` · ${entry.retry_count} attempt${entry.retry_count > 1 ? 's' : ''}`}
                      </p>
                    </div>
                    <Badge tone={status.tone} data-testid="record-status">{status.label}</Badge>
                  </div>
                  {user.last_sync_error && user.sync_status !== 'synced' && (
                    <p className="mt-1.5 text-xs text-slate-600">{user.last_sync_error}</p>
                  )}
                  {online && (status.key === 'needs_password' || status.key === 'pending' || status.key === 'retrying') && (
                    <button type="button" className="btn-link mt-1.5" onClick={() => onEnterPassword(user)}>
                      Enter password to finish cloud registration
                    </button>
                  )}
                  {(status.key === 'failed' || status.key === 'conflict') && (
                    <button type="button" className="btn-link mt-1.5" onClick={() => onRetry(user)}>
                      Try again
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
