// Service worker: precaches the app shell (HTML, every JS/CSS chunk including lazily-loaded screens,
// SQLite WASM, icons, manifest) so the installed app starts and navigates without a network connection.
//
// There is deliberately NO runtime caching. Requests that are not precached, including every /api call
// (private, authenticated data) and all Firebase traffic, go straight to the network and are never stored
// by this worker. Operational data lives in SQLite (OPFS), which this worker never touches, so installing
// a new version cannot affect records waiting to sync.
//
// Lifecycle: the first install activates at once. A later version waits until the page asks for it
// (SKIP_WAITING, sent when the user taps "Update"), so a running page keeps the chunks it was built with;
// cleanupOutdatedCaches then removes only caches of older precache versions.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

// Single-page app: every same-origin navigation is served the cached index.html (API paths excluded).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }));
