// Service worker: precaches the app shell (HTML, JS, CSS, SQLite WASM, icons) so the
// registration screen and local database start without a network connection.
//
// There is deliberately NO runtime caching. Requests that are not precached, including all
// Firebase Authentication and Firestore traffic (cross-origin), go straight to the network
// and are never stored by this worker.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

// Single-page app: every same-origin navigation is served the cached index.html.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));
