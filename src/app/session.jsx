// Signed-in session for the operational app: Firebase Auth identity, the backend profile from
// GET /auth/me (role + per-division permissions), the API client and the offline operations queue.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createApiClient } from '../services/apiClient.js';
import { createOperationsQueue } from '../services/operationsQueue.js';
import { DEMO_ME, DEMO_MODE, createDemoApi } from '../services/demoApi.js';
import { createOutboxRepository } from '../database/outboxRepository.js';
import { isOnline, subscribeConnectivity, subscribeForeground } from '../services/connectivityService.js';

const SessionContext = createContext(null);
const ME_CACHE_KEY = 'session_me';

export const ROLE_NAMES = { 1: 'Super Admin', 2: 'Admin', 3: 'Manager', 4: 'Supervisor/EHK', 5: 'Janitor', 6: 'Contractor' };

let firebasePromise = null;
const loadFirebase = () =>
  (firebasePromise ??= Promise.all([import('firebase/auth'), import('../services/firebase.js')])
    .then(([authLib, { getFirebaseServices }]) => ({ authLib, auth: getFirebaseServices().auth }))
    .catch((e) => {
      firebasePromise = null;
      throw e;
    }));

export function SessionProvider({ db, children }) {
  // Demo mode: no Firebase sign-in or /auth/me; a fixed admin profile and sample GET data.
  const [fbUser, setFbUser] = useState(DEMO_MODE ? { email: DEMO_ME.user.email } : undefined); // undefined = still resolving
  const [me, setMe] = useState(DEMO_MODE ? DEMO_ME : null);
  const [meError, setMeError] = useState(null);
  const [configError, setConfigError] = useState(null);
  const outbox = useMemo(() => createOutboxRepository(db), [db]);

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

  const api = useMemo(() => (DEMO_MODE ? createDemoApi() : createApiClient({ getToken })), [getToken]);

  const queue = useMemo(
    () => createOperationsQueue({ db, isOnline, getApi: async () => (!DEMO_MODE && (await getToken()) ? api : null) }),
    [db, api, getToken],
  );

  const loadMe = useCallback(async () => {
    setMeError(null);
    try {
      const profile = await api.get('/auth/me');
      setMe(profile);
      await outbox.setMeta(ME_CACHE_KEY, JSON.stringify(profile), new Date().toISOString());
    } catch (e) {
      // Offline: fall back to the profile cached at the last successful sign-in on this device.
      const cached = e.status === 0 ? await outbox.getMeta(ME_CACHE_KEY) : null;
      const parsed = cached ? JSON.parse(cached) : null;
      if (parsed && parsed.user?.email?.toLowerCase() === fbUser?.email?.toLowerCase()) setMe({ ...parsed, offline: true });
      else setMeError(e);
    }
  }, [api, outbox, fbUser]);

  useEffect(() => {
    if (DEMO_MODE) return;
    if (fbUser) loadMe();
    else if (fbUser === null) setMe(null);
  }, [fbUser, loadMe]);

  useEffect(() => {
    if (!me) return undefined;
    queue.flush();
    const offNet = subscribeConnectivity((online) => (online ? queue.flush() : queue.refresh()));
    const offFg = subscribeForeground(() => queue.flush());
    return () => {
      offNet();
      offFg();
    };
  }, [me, queue]);

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
      can: (perm) => perms.has(perm),
      api,
      queue,
      db,
      outbox,
      signIn,
      signOut,
      reload: loadMe,
    };
  }, [fbUser, me, meError, configError, api, queue, db, outbox, signIn, signOut, loadMe]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

export function useQueueState() {
  const { queue } = useSession();
  return useSyncExternalStore(queue.subscribe, queue.getState);
}

// Loads a GET endpoint. Successful responses are cached in SQLite so the screen still shows the last
// known data offline (flagged `stale`). `path` null skips the request.
export function useResource(path, query) {
  const { api, outbox } = useSession();
  const key = path ? `cache:${path}?${new URLSearchParams(query ?? {}).toString()}` : null;
  const [state, setState] = useState({ data: null, loading: !!path, error: null, stale: false });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) {
      setState({ data: null, loading: false, error: null, stale: false });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(path, query)
      .then(async (data) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null, stale: false });
        await outbox.setMeta(key, JSON.stringify(data), new Date().toISOString()).catch(() => {});
      })
      .catch(async (error) => {
        const cached = error.status === 0 ? await outbox.getMeta(key).catch(() => null) : null;
        if (cancelled) return;
        setState({ data: cached ? JSON.parse(cached) : null, loading: false, error, stale: !!cached });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
