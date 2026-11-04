// Registers the service worker built from src/pwa/serviceWorker.js (production builds only).
//
// Updates are prompted, not forced: a new version waits until the user taps "Update" (pwa.update), so a
// running page never has its lazily-loaded screens removed from the cache underneath it.
import { registerSW } from 'virtual:pwa-register';
import { pwa } from './pwaState.js';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => pwa.needRefresh(),
    onOfflineReady: () => pwa.offlineReady(),
    // Installed PWAs can stay open for days: look for a new version hourly while online.
    onRegisteredSW(url, registration) {
      if (!registration) return;
      setInterval(() => {
        if (navigator.onLine && !registration.installing) registration.update().catch(() => {});
      }, 60 * 60 * 1000);
    },
  });
  pwa.setUpdater(update);
}
