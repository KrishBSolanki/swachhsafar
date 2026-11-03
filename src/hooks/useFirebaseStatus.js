// Checks Firebase Authentication and Firestore reachability separately from the
// device's network state. Re-checks on reconnect and after each completed sync.
import { useEffect, useState } from 'react';

const OFFLINE = { auth: { ok: false, error: 'Offline' }, firestore: { ok: false, error: 'Offline' } };

export function useFirebaseStatus(online, lastSyncAt) {
  const [state, setState] = useState({ checking: true, auth: null, firestore: null });

  useEffect(() => {
    if (!online) {
      setState({ checking: false, ...OFFLINE });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, checking: true }));
    // Loaded lazily so the offline app shell starts without parsing Firebase.
    import('../services/firebase.js')
      .then(({ checkFirebaseHealth }) => checkFirebaseHealth())
      .catch((e) => ({ auth: { ok: false, error: e.message }, firestore: { ok: false, error: e.message } }))
      .then((health) => !cancelled && setState({ checking: false, ...health }));
    return () => {
      cancelled = true;
    };
  }, [online, lastSyncAt]);

  return state;
}
