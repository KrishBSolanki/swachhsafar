// Boots the local SQLite database and the services that depend on it.
import { useEffect, useState } from 'react';
import { initDatabase } from '../database/sqlite.js';
import { createRegistrationService } from '../services/registrationService.js';
import { createSyncService } from '../services/syncService.js';
import { isOnline } from '../services/connectivityService.js';

// Firebase is loaded on first sync, so the offline app shell starts without parsing it.
let authService = null;
const getAuthService = () =>
  (authService ??= Promise.all([import('../services/authService.js'), import('../services/firebase.js')])
    .then(([{ createAuthService }, { getFirebaseServices }]) => createAuthService(getFirebaseServices()))
    .catch((e) => {
      authService = null;
      throw e;
    }));

export function useLocalDatabase() {
  const [state, setState] = useState({ status: 'initializing', info: null, error: null, services: null });

  useEffect(() => {
    let cancelled = false;
    initDatabase()
      .then(({ db, info }) => {
        if (cancelled) return;
        const services = {
          registration: createRegistrationService({ db }),
          sync: createSyncService({ db, getAuthService, isOnline }),
        };
        setState({ status: 'ready', info, error: null, services });
      })
      .catch((error) => !cancelled && setState({ status: 'error', info: null, error, services: null }));
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
