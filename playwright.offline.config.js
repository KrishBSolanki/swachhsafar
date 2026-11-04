import { defineConfig } from '@playwright/test';

// Offline end-to-end tests of the operational screens against a production build (real OPFS SQLite,
// real service worker). The build uses a FAKE Firebase project and every Google API and /api/v1 request
// is answered inside the browser by the test, so nothing reaches production Firebase or a backend.
const FAKE_FIREBASE = [
  'VITE_FIREBASE_API_KEY=e2e-fake-api-key',
  'VITE_FIREBASE_AUTH_DOMAIN=swachh-safar-e2e-fake.firebaseapp.com',
  'VITE_FIREBASE_PROJECT_ID=swachh-safar-e2e-fake',
  'VITE_FIREBASE_STORAGE_BUCKET=swachh-safar-e2e-fake.appspot.com',
  'VITE_FIREBASE_MESSAGING_SENDER_ID=0',
  'VITE_FIREBASE_APP_ID=1:0:web:e2efake',
  'VITE_DEMO_MODE=false',
].join(' ');

export default defineConfig({
  testDir: 'tests/e2e-offline',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  webServer: {
    command: `npx cross-env ${FAKE_FIREBASE} vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port 4175 --strictPort`,
    url: 'http://localhost:4175',
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
