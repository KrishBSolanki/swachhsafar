// Firebase initialisation for the swachh-safar project.
// Config comes from VITE_FIREBASE_* variables (.env.local); these are public client identifiers.
import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';

export function firebaseConfigFromEnv(env = import.meta.env) {
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

let services = null;

export function getFirebaseServices(config = firebaseConfigFromEnv()) {
  if (services) return services;
  if (!config.apiKey || !config.projectId || !config.appId) {
    throw new Error('Firebase is not configured. Set VITE_FIREBASE_* in .env.local.');
  }
  const app = getApps()[0] ?? initializeApp(config);
  // getAuth persists the session in IndexedDB in browsers. Firestore uses its default
  // in-memory cache: SQLite, not Firestore, is this app's offline store.
  services = { app, auth: getAuth(app), firestore: getFirestore(app) };
  return services;
}

const PROBE_TIMEOUT_MS = 10_000;

const withTimeout = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), PROBE_TIMEOUT_MS)),
  ]);

// Firebase Authentication: the Identity Toolkit project-config endpoint answers only when the
// API key is valid for this origin, and lists the domains authorized for this project.
async function probeAuth({ app, auth }) {
  await auth.authStateReady();
  const res = await withTimeout(
    fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(app.options.apiKey)}`),
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message || `HTTP ${res.status}`);
  }
  const { authorizedDomains = [] } = await res.json();
  return { authorizedDomains };
}

// Firestore: a server read the security rules deny. permission-denied proves the backend
// answered; only network errors and timeouts mean Firestore is unreachable.
async function probeFirestore({ firestore }) {
  try {
    await withTimeout(getDocFromServer(doc(firestore, 'app_users', 'connectivity-check')));
  } catch (e) {
    if (e.code !== 'permission-denied') throw e;
  }
}

// Independent health of Firebase Authentication and Firestore (not the same as navigator.onLine).
export async function checkFirebaseHealth() {
  const services = getFirebaseServices();
  const [auth, firestore] = await Promise.allSettled([probeAuth(services), probeFirestore(services)]);
  const result = (r) => (r.status === 'fulfilled' ? { ok: true, ...r.value } : { ok: false, error: r.reason?.message });
  return { auth: result(auth), firestore: result(firestore) };
}
