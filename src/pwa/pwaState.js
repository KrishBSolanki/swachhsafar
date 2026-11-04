// Installed-app state of the PWA, shared by the install prompt, the update banner and the offline
// readiness panel: the deferred `beforeinstallprompt` event (Chrome / Android), whether a new service
// worker version is waiting, and the persistence of browser storage (OPFS holds the SQLite database).
import { useSyncExternalStore } from 'react';

const DISMISS_KEY = 'pwa_install_dismissed_at';
const listeners = new Set();
let state = {
  installEvent: null, // BeforeInstallPromptEvent, when Chrome offers installation
  installed: false, // 'appinstalled' fired in this session
  updateReady: false, // a new version is installed and waiting
  offlineReady: false, // the service worker has precached the app shell
  controlled: typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller,
};
let applyUpdate = null;

const emit = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const pwa = {
  subscribe(l) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
  setUpdater(fn) {
    applyUpdate = fn;
  },
  needRefresh: () => emit({ updateReady: true }),
  offlineReady: () => emit({ offlineReady: true }),
  // Activates the waiting version and reloads. Pending records live in SQLite/OPFS, not in the page or
  // the service worker, so they survive the reload; only an unsaved form on screen would be lost.
  update: () => applyUpdate?.(true),
};

export const usePwa = () => useSyncExternalStore(pwa.subscribe, pwa.get);

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

// Must run before React renders: Chrome fires beforeinstallprompt early and only once per page load.
export function captureInstallEvents() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own prompt instead of the mini-infobar
    emit({ installEvent: e });
  });
  window.addEventListener('appinstalled', () => emit({ installEvent: null, installed: true }));
  navigator.serviceWorker?.addEventListener?.('controllerchange', () => emit({ controlled: true }));
}

export async function promptInstall() {
  const e = state.installEvent;
  if (!e) return 'unavailable';
  e.prompt();
  const { outcome } = await e.userChoice;
  emit({ installEvent: null, installed: outcome === 'accepted' });
  if (outcome !== 'accepted') dismissInstall();
  return outcome;
}

// The install banner is not shown again for 30 days after it is dismissed.
export function installDismissed(now = Date.now()) {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return at > 0 && now - at < 30 * 86_400_000;
  } catch {
    return false;
  }
}
export function dismissInstall() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* storage blocked: the banner simply shows again next time */
  }
}

// Browser storage persistence. Persistent storage is not evicted under storage pressure, but it is still
// removed when the user clears site data or uninstalls the app.
export async function storageStatus() {
  const s = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!s) return { supported: false, persisted: false, usage: null, quota: null };
  const [persisted, estimate] = await Promise.all([
    s.persisted ? s.persisted().catch(() => false) : false,
    s.estimate ? s.estimate().catch(() => ({})) : {},
  ]);
  return { supported: true, persisted, usage: estimate.usage ?? null, quota: estimate.quota ?? null };
}

export async function requestPersistence() {
  const s = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!s?.persist) return false;
  if (await s.persisted?.().catch(() => false)) return true;
  return s.persist().catch(() => false);
}
