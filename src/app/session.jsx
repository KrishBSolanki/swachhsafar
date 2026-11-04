// Signed-in session for the operational app: Firebase Auth identity, the backend profile from
// GET /auth/me (role + per-division permissions), the API client and the offline operations queue.
//
// Data access is local-first (demo mode off): one localStore over the device SQLite database backs
// both the operations queue (captures are saved locally, then synced) and the local-first API (reads
// fall back to SQLite when the server is unreachable). Demo mode uses sample GET data only and never
// writes demo records into the operational database.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createApiClient } from '../services/apiClient.js';
import { createOperationsQueue } from '../services/operationsQueue.js';
import { createLocalStore } from '../services/localStore.js';
import { createLocalApi } from '../services/localApi.js';
import { createLocalFirstApi, responseCacheKey } from '../services/localFirstApi.js';
import { createOperations } from '../services/operations.js';
import { DEMO_ME, DEMO_MODE, createDemoApi } from '../services/demoApi.js';
import { createOutboxRepository } from '../database/outboxRepository.js';
import { isOnline, subscribeConnectivity, subscribeForeground } from '../services/connectivityService.js';

const SessionContext = createContext(null);
const LEGACY_ME_CACHE_KEY = 'session_me'; // Phase 1 cache; migrated into authorization_snapshots (v3)
const DEMO_CAPTURE_REASON = 'Demo mode: records are not saved. Turn off VITE_DEMO_MODE to capture real data.';

export const ROLE_NAMES = { 1: 'Super Admin', 2: 'Admin', 3: 'Manager', 4: 'Supervisor/EHK', 5: 'Janitor', 6: 'Contractor' };

let firebasePromise = null;
const loadFirebase = () =>
  (firebasePromise ??= Promise.all([import('firebase/auth'), import('../services/firebase.js')])
    .then(([authLib, { getFirebaseServices }]) => ({ authLib, auth: getFirebaseServices().auth }))
    .catch((e) => {
      firebasePromise = null;
      throw e;
    }));

export function SessionProvider({ db, files, children }) {
  // Demo mode: no Firebase sign-in or /auth/me; a fixed admin profile and sample GET data.
  const [fbUser, setFbUser] = useState(DEMO_MODE ? { email: DEMO_ME.user.email } : undefined); // undefined = still resolving
  const [me, setMe] = useState(DEMO_MODE ? DEMO_ME : null);
  const [meError, setMeError] = useState(null);
  const [configError, setConfigError] = useState(null);
  const outbox = useMemo(() => createOutboxRepository(db), [db]);
  const store = useMemo(() => createLocalStore({ db, files }), [db, files]);
  const meRef = useRef(me);
  meRef.current = me;
  const sessionIdRef = useRef(null);

  useEffect(() => {
    if (DEMO_MODE) return undefined;
    let off = () => {};
    loadFirebase()
      .then(({ authLib, auth }) => {
        off = authLib.onAuthStateChanged(auth, (u) => setFbUser(u ?? null));
      })
      .catch((e) => {
        setConfigError(e.message);
        setFbUser(null);
      });
    return () => off();
  }, []);

  const getToken = useCallback(async () => {
    const { auth } = await loadFirebase();
    return auth.currentUser ? auth.currentUser.getIdToken() : null;
  }, []);

  const remote = useMemo(() => (DEMO_MODE ? null : createApiClient({ getToken })), [getToken]);

  const api = useMemo(() => {
    if (DEMO_MODE) return createDemoApi();
    const getContext = () => {
      const current = meRef.current;
      return { userId: current?.user?.id ?? null, permissions: current?.divisions ?? {} };
    };
    return createLocalFirstApi({ remote, local: createLocalApi({ store, getContext }), store, isOnline, getContext });
  }, [remote, store]);
  const ops = useMemo(() => createOperations(api), [api]);

  const queue = useMemo(
    () => createOperationsQueue({
      db, store, isOnline,
      getApi: async () => (!DEMO_MODE && (await getToken()) ? remote : null),
      getActor: () => {
        const current = meRef.current;
        return current ? { actor: { id: current.user.id, permissions: current.divisions }, divisions: Object.keys(current.divisions) } : null;
      },
      captureDisabledReason: DEMO_MODE ? DEMO_CAPTURE_REASON : null,
    }),
    [db, store, remote, getToken],
  );

  const cachedAuthorization = useCallback(async (email) => {
    const snapshot = await store.identity.findSnapshotByEmail(email).catch(() => null);
    if (snapshot) return snapshot;
    const legacy = await outbox.getMeta(LEGACY_ME_CACHE_KEY).catch(() => null);
    const parsed = legacy ? JSON.parse(legacy) : null;
    return parsed?.user?.email?.toLowerCase() === email?.toLowerCase() ? parsed : null;
  }, [store, outbox]);

  const loadMe = useCallback(async () => {
    setMeError(null);
    try {
      const profile = await remote.get('/auth/me');
      setMe(profile);
      await store.identity.saveAuthorization(profile, { firebaseUid: fbUser?.uid ?? null, now: new Date().toISOString() })
        .catch((e) => console.warn('[session] could not cache authorization', e));
    } catch (e) {
      // Offline: sign in with the authorization cached at the last successful sign-in on this device.
      const cached = e.status === 0 ? await cachedAuthorization(fbUser?.email) : null;
      if (cached) setMe({ ...cached, offline: true });
      else setMeError(e);
    }
  }, [remote, store, fbUser, cachedAuthorization]);

  useEffect(() => {
    if (DEMO_MODE) return;
    if (fbUser) loadMe();
    else if (fbUser === null) setMe(null);
  }, [fbUser, loadMe]);

  // Local session metadata: one row per signed-in app session on this device.
  useEffect(() => {
    if (DEMO_MODE || !me?.user?.id) return undefined;
    let cancelled = false;
    const now = new Date().toISOString();
    store.identity.startSession({ userId: me.user.id, firebaseUid: fbUser?.uid, email: me.user.email, mode: me.offline ? 'offline' : 'online', now })
      .then((id) => {
        if (cancelled) store.identity.endSession(id, new Date().toISOString());
        else sessionIdRef.current = id;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (sessionIdRef.current) store.identity.endSession(sessionIdRef.current, new Date().toISOString()).catch(() => {});
      sessionIdRef.current = null;
    };
  }, [me?.user?.id, me?.offline, fbUser?.uid, me?.user?.email, store]);

  useEffect(() => {
    if (!me) return undefined;
    const sync = () => {
      queue.flush();
      queue.pull();
    };
    queue.refresh();
    sync();
    const offNet = subscribeConnectivity((online) => (online ? sync() : queue.refresh()));
    const offFg = subscribeForeground(() => {
      if (sessionIdRef.current) store.identity.touchSession(sessionIdRef.current, new Date().toISOString()).catch(() => {});
      sync();
    });
    return () => {
      offNet();
      offFg();
    };
  }, [me, queue, store]);

  const signIn = useCallback(async (email, password) => {
    const { authLib, auth } = await loadFirebase();
    await authLib.signInWithEmailAndPassword(auth, email, password);
  }, []);

  const signOut = useCallback(async () => {
    if (DEMO_MODE) return;
    const { authLib, auth } = await loadFirebase();
    await authLib.signOut(auth);
  }, []);

  const value = useMemo(() => {
    const divisions = me ? Object.keys(me.divisions) : [];
    const perms = new Set(divisions.flatMap((d) => me.divisions[d]));
    return {
      status: fbUser === undefined ? 'loading' : !fbUser ? 'signedOut' : me ? 'ready' : meError ? 'error' : 'loading',
      firebaseUser: fbUser,
      configError,
      me,
      meError,
      user: me?.user ?? null,
      divisions,
      // `can`: held in any division (navigation). `canIn`: held in that division (actions on a record).
      can: (perm) => perms.has(perm),
      canIn: (perm, divisionId) => !!me?.divisions?.[divisionId]?.includes(perm),
      api,
      ops,
      queue,
      store,
      db,
      outbox,
      signIn,
      signOut,
      reload: loadMe,
    };
  }, [fbUser, me, meError, configError, api, ops, queue, store, db, outbox, signIn, signOut, loadMe]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
const noopSubscribe = () => () => {};

export function useQueueState() {
  const { queue } = useSession();
  return useSyncExternalStore(queue.subscribe, queue.getState);
}

// Loads a GET endpoint. With the local-first API, data the server cannot provide right now comes from
// SQLite and is flagged `stale` ("Offline — showing data on this device"). Endpoints with no local
// table (reports, audit) fall back to the signed-in user's last response cached in sync_meta, with
// `cachedAt` saying when it was loaded. `path` null skips it.
// Refresh lifecycle: a resource is (re)read when its path/query changes, on reload(), and whenever the
// operations queue commits delivery outcomes or pulled changes (queue `revision`), so a screen never keeps
// showing a sync state the database has already left. Each read belongs to one effect run: a superseded
// read (older revision, other query) is discarded when it resolves, so an older response can never
// overwrite a newer one.
const selectRevision = (queue) => () => queue?.getState().revision ?? 0;

export function useResource(path, query) {
  const { api, outbox, user, queue } = useSession();
  const revision = useSyncExternalStore(queue?.subscribe ?? noopSubscribe, selectRevision(queue));
  const key = path ? `${path}?${new URLSearchParams(query ?? {}).toString()}` : null;
  const cacheKey = responseCacheKey(user?.id, path, query);
  const [state, setState] = useState({ data: null, loading: !!path, error: null, stale: false, cachedAt: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) {
      setState({ data: null, loading: false, error: null, stale: false, cachedAt: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const load = api.getWithSource ? api.getWithSource(path, query) : api.get(path, query).then((data) => ({ data, source: 'remote' }));
    load
      .then(async ({ data, source }) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null, stale: source === 'local', cachedAt: null, source });
        // Operational data already lives in SQLite tables; only cache what has no local table. Reports are
        // also kept: offline they are recalculated from device records, and the last server report remains
        // available for comparison (src/pages/ops/Reports.jsx).
        if (source === 'remote' && cacheKey && (!api.hasLocal?.(path) || path.startsWith('/reports/'))) {
          await outbox.setMeta(cacheKey, JSON.stringify(data), new Date().toISOString()).catch(() => {});
        }
      })
      .catch(async (error) => {
        const cached = error.status === 0 && cacheKey ? await outbox.getMetaEntry(cacheKey).catch(() => null) : null;
        if (cancelled) return;
        setState({ data: cached ? JSON.parse(cached.value) : null, loading: false, error, stale: !!cached, cachedAt: cached?.updated_at ?? null, source: cached ? 'snapshot' : null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cacheKey, tick, revision]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
