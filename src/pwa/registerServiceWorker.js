// Registers the service worker built from src/pwa/serviceWorker.js (production builds only).
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  registerSW({ immediate: true });
}
