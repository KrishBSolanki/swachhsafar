// Pushes pending registrations from the SQLite outbox to Firebase.
//
// Firebase Auth needs the plaintext password to create an account, and we never persist it.
// So a pending registration can be synced when either:
//   - the user (re)enters their password this session (verified against the local PBKDF2 hash,
//     then held in memory only until the sync finishes), or
//   - Firebase already has a signed-in session for that email (account created earlier, profile
//     write still pending), in which case no password is needed.
//
// Guarantees: one run at a time (in-process flag + Web Locks across tabs), outbox rows are claimed
// atomically before work starts, the cloud profile write is an idempotent setDoc keyed by the local
// UUID, and failures never delete local data.
import { createUserRepository } from '../database/userRepository.js';
import { createOutboxRepository } from '../database/outboxRepository.js';
import { verifyPassword } from '../utils/passwordHash.js';

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const PERMANENT_CODES = new Set([
  'cloud_conflict', 'auth/invalid-email', 'auth/weak-password', 'auth/operation-not-allowed',
  'auth/user-disabled', 'auth/admin-restricted-operation', 'local_record_missing',
]);

const WRONG_PASSWORD_CODES = new Set(['auth/invalid-credential', 'auth/wrong-password', 'auth/invalid-login-credentials']);

const FRIENDLY_MESSAGES = {
  'auth/network-request-failed': 'Network error while contacting Firebase. Will retry.',
  'auth/too-many-requests': 'Firebase is rate-limiting requests. Will retry later.',
  'auth/invalid-email': 'Firebase rejected this email address.',
  'auth/weak-password': 'Firebase rejected the password as too weak.',
  'auth/operation-not-allowed': 'Email/password sign-up is disabled in Firebase.',
  'auth/user-disabled': 'This Firebase account has been disabled.',
  'permission-denied': 'Firebase denied the profile write (security rules). Will retry.',
  unavailable: 'Firebase is unreachable. Will retry.',
  'sync/timeout': 'Firebase did not respond in time. Will retry.',
};

export function classifyError(e) {
  const code = e?.code ?? 'unknown';
  return {
    code,
    permanent: PERMANENT_CODES.has(code),
    message: FRIENDLY_MESSAGES[code] ?? e?.message ?? 'Unknown sync error',
    registrationStatus: code === 'cloud_conflict' ? 'conflict' : null,
  };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SyncError('sync/timeout', 'Timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createSyncService({
  db,
  getAuthService,
  isOnline = () => true,
  now = () => new Date().toISOString(),
  timeoutMs = 20_000,
  backoffBaseMs = 15_000,
  backoffMaxMs = 10 * 60_000,
  locks = typeof navigator !== 'undefined' ? navigator.locks : undefined,
}) {
  const users = createUserRepository(db);
  const outbox = createOutboxRepository(db);
  const sessionPasswords = new Map(); // userId -> password, memory only
  const listeners = new Set();
  let state = {
    loaded: false,
    running: false,
    online: isOnline(),
    pendingCount: 0,
    lastSyncAt: null,
    lastError: null,
    needsPassword: [],
    users: [],
    outbox: {},
    nextRetryAt: null,
  };
  let inFlight = null;
  let rerun = false;
  let retryTimer = null;

  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state));
  };

  async function refresh() {
    const [pendingCount, lastSyncAt, userRows, open] = await Promise.all([
      outbox.countPending(), outbox.getMeta('last_sync_at'), users.list(), outbox.listOpen(),
    ]);
    const outboxByUser = Object.fromEntries(open.map((o) => [o.entity_id, o]));
    emit({
      loaded: true,
      online: isOnline(),
      pendingCount,
      lastSyncAt,
      users: userRows,
      outbox: outboxByUser,
      needsPassword: state.needsPassword.filter((id) => outboxByUser[id]?.sync_status === 'pending'),
    });
    return state;
  }

  async function createOrSignIn(auth, email, password) {
    try {
      return { ...(await withTimeout(auth.createAccount(email, password), timeoutMs)), existed: false };
    } catch (e) {
      if (e.code !== 'auth/email-already-in-use') throw e;
    }
    // The email already has a Firebase account (e.g. an earlier sync created it before the profile
    // write failed). Never create another: sign in, and treat a password mismatch as a conflict.
    try {
      return { ...(await withTimeout(auth.signIn(email, password), timeoutMs)), existed: true };
    } catch (e) {
      if (WRONG_PASSWORD_CODES.has(e.code)) {
        throw new SyncError(
          'cloud_conflict',
          'This email already has a Swachh Safar cloud account with a different password. No new account was created.',
        );
      }
      throw e;
    }
  }

  async function processRegistration(entry, auth) {
    const user = await users.findById(entry.entity_id);
    if (!user) {
      await outbox.markFailed(entry.id, { error: 'Local user record missing', now: now() });
      return { status: 'failed', code: 'local_record_missing', entryId: entry.id };
    }
    const base = { userId: user.id, email: user.email };
    if (user.sync_status === 'synced') {
      await outbox.markCompleted(entry.id, now());
      return { ...base, status: 'synced' };
    }

    const password = sessionPasswords.get(user.id);
    const current = await withTimeout(auth.currentAccount(), timeoutMs);
    const resumable = current?.email === user.email;
    if (!password && !resumable) return { ...base, status: 'needs_password' };

    if (!(await outbox.claim(entry.id, now()))) return { ...base, status: 'skipped' };

    try {
      const account = resumable ? current : await createOrSignIn(auth, user.email, password);
      const existingProfile = await withTimeout(auth.findProfileByAuthUid(account.uid), timeoutMs);
      let cloudProfileId = user.id;
      if (existingProfile && existingProfile.uuid !== user.id) {
        // Same cloud account already has a profile (registered on another device): link, don't duplicate.
        cloudProfileId = existingProfile.uuid;
      } else {
        await withTimeout(auth.upsertProfile({
          uuid: user.id, authUid: account.uid, username: user.username, email: user.email, registeredAt: user.created_at,
        }), timeoutMs);
      }
      const t = now();
      await users.markSynced(user.id, { firebaseUid: account.uid, cloudProfileId, now: t });
      await outbox.markCompleted(entry.id, t);
      sessionPasswords.delete(user.id);
      return { ...base, status: 'synced', firebaseUid: account.uid, linkedExisting: cloudProfileId !== user.id };
    } catch (e) {
      const failure = classifyError(e);
      const t = now();
      if (failure.permanent) {
        await outbox.markFailed(entry.id, { error: failure.message, now: t });
        await users.markSyncFailed(user.id, { error: failure.message, registrationStatus: failure.registrationStatus, now: t });
        sessionPasswords.delete(user.id);
        return { ...base, status: 'failed', code: failure.code, message: failure.message };
      }
      await outbox.markRetry(entry.id, { error: failure.message, now: t });
      await users.markSyncRetry(user.id, { error: failure.message, now: t });
      return { ...base, status: 'retry', code: failure.code, message: failure.message, retryCount: entry.retry_count + 1 };
    }
  }

  function scheduleRetry(results) {
    clearTimeout(retryTimer);
    retryTimer = null;
    const retries = results.filter((r) => r.status === 'retry');
    if (!retries.length) return emit({ nextRetryAt: null });
    const attempts = Math.min(...retries.map((r) => r.retryCount));
    const delay = Math.min(backoffBaseMs * 2 ** (attempts - 1), backoffMaxMs);
    retryTimer = setTimeout(() => sync({ trigger: 'retry' }), delay);
    emit({ nextRetryAt: new Date(Date.now() + delay).toISOString() });
  }

  async function runOnce(trigger) {
    if (!isOnline()) {
      await refresh();
      return { status: 'offline', trigger, results: [] };
    }
    const entries = await outbox.listPending('user');
    if (!entries.length) {
      await refresh();
      return { status: 'idle', trigger, results: [] };
    }

    emit({ running: true, lastError: null });
    const results = [];
    try {
      const auth = await getAuthService();
      for (const entry of entries) {
        if (entry.entity_type === 'user' && entry.operation === 'register') {
          results.push(await processRegistration(entry, auth));
        }
      }
    } catch (e) {
      // Failure before any entry could be claimed (e.g. Firebase not configured): nothing changes locally.
      emit({ lastError: classifyError(e).message });
    }

    if (results.some((r) => r.status === 'synced')) await outbox.setMeta('last_sync_at', now(), now());
    const failures = results.filter((r) => r.status === 'retry' || r.status === 'failed');
    emit({
      running: false,
      needsPassword: results.filter((r) => r.status === 'needs_password').map((r) => r.userId),
      lastError: failures.length ? failures[0].message : state.lastError,
    });
    scheduleRetry(results);
    await refresh();
    return { status: 'done', trigger, results };
  }

  function runExclusive(trigger) {
    const body = () => runOnce(trigger);
    if (!locks?.request) return body();
    return locks.request('swachh-safar-sync', { ifAvailable: true }, (lock) =>
      lock ? body() : { status: 'locked', trigger, results: [] },
    );
  }

  // Triggers coalesce: a call during a run schedules exactly one follow-up run.
  function sync({ trigger = 'manual' } = {}) {
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let result = await runExclusive(trigger);
        while (rerun) {
          rerun = false;
          result = await runExclusive('coalesced');
        }
        return result;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    sync,

    // Called once after the database is ready.
    async start() {
      await outbox.recoverInterrupted(now());
      return sync({ trigger: 'startup' });
    },

    // Re-entered password for a pending registration. Checked against the local verifier first so
    // a typo can never create a Firebase account with the wrong password.
    async provideCredential(userId, password) {
      const creds = await users.findCredentialsById(userId);
      if (!creds || !(await verifyPassword(password, creds.password_hash, creds.password_salt))) {
        return { ok: false, reason: 'invalid_password' };
      }
      sessionPasswords.set(userId, password);
      const run = await sync({ trigger: 'credential' });
      const own = run.results?.find((r) => r.userId === userId);
      const user = own ? null : await users.findById(userId);
      return { ok: true, result: own ?? { userId, status: user?.sync_status === 'synced' ? 'synced' : run.status } };
    },

    // Immediately after a local registration the password was just validated and hashed, so it can
    // be used directly instead of re-deriving the PBKDF2 hash.
    async syncNewRegistration(userId, password) {
      sessionPasswords.set(userId, password);
      const run = await sync({ trigger: 'registration' });
      const own = run.results?.find((r) => r.userId === userId);
      if (own) return own;
      // A coalesced run may have handled it in an earlier pass; report what the record says.
      const user = await users.findById(userId);
      return { userId, email: user?.email, status: user?.sync_status === 'synced' ? 'synced' : run.status };
    },

    // Puts a permanently failed registration back in the queue (after the user fixed the cause).
    async retry(userId) {
      const entry = await outbox.findOpenForEntity('user', userId);
      if (entry) await outbox.resetFailed(entry.id, now());
      await users.resetForRetry(userId, now());
      await refresh();
      return entry;
    },

    dispose() {
      clearTimeout(retryTimer);
      listeners.clear();
      sessionPasswords.clear();
    },
  };
}
