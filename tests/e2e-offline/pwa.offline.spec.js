// Installable-PWA checks against the production build: a valid web app manifest with real 192/512 and
// maskable icons, a service worker that precaches every built asset, and an app shell that starts,
// deep-links and reloads with the network disconnected after one online visit. Browser emulation of a
// Pixel 7 (Chromium); this is not a physical Android device.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4175/';

// Width and height from a PNG's IHDR chunk.
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

let dir;
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swachh-pwa-'));
});
test.afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch { /* Windows may keep the profile locked briefly */ }
});

test('manifest is installable: standalone, scoped, with 192/512 and maskable PNG icons', async ({ request }) => {
  const html = await (await request.get(BASE)).text();
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(html).toContain('name="theme-color"');
  const res = await request.get(`${BASE}manifest.webmanifest`);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: 'Swachh Safar', short_name: 'Swachh Safar', start_url: '/', scope: '/', display: 'standalone', id: '/' });
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  const need = [['192x192', undefined], ['512x512', undefined], ['512x512', 'maskable']];
  for (const [sizes, purpose] of need) {
    const icon = m.icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(icon, `${sizes} ${purpose ?? 'any'} icon`).toBeTruthy();
    const img = await request.get(new URL(icon.src, BASE).href);
    expect(img.ok()).toBe(true);
    expect(img.headers()['content-type']).toContain('image/png');
    const [w, h] = sizes.split('x').map(Number);
    expect(pngSize(await img.body())).toEqual({ width: w, height: h });
  }
});

test('the app shell starts, deep-links and reloads offline after one online visit', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  let context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE });
  // No backend in this test: API and Google calls fail as unreachable.
  await context.route(/\/api\/v1\/|googleapis\.com|firebaseapp\.com/, (route) => route.abort('connectionrefused'));
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

  // Every file of the build is in the precache (hashed JS/CSS chunks of every screen, SQLite WASM, icons).
  const built = readdirSync('dist-e2e/assets');
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    return urls;
  });
  for (const f of built) expect(cached.some((u) => u.endsWith(`/assets/${f}`)), `precached ${f}`).toBe(true);
  for (const f of ['/index.html', '/manifest.webmanifest', '/pwa-192x192.png', '/pwa-512x512.png']) expect(cached).toContain(f);
  // No API response is ever cached by the service worker.
  expect(cached.some((u) => u.startsWith('/api/'))).toBe(false);

  // ---- offline: cold start, deep link, reload ----
  await context.close();
  context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE, offline: true });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/inventory');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.goto('/some/deep/path'); // non-hash navigation: answered with the cached index.html
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  // Lazily-loaded screens are available offline too (their chunks are precached).
  const failed = [];
  page.on('requestfailed', (r) => { if (!/\/api\/v1\/|google|firebase/.test(r.url())) failed.push(r.url()); });
  await page.goto('/#/reports');
  await expect(page.getByText(/Swachh Safar/).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(failed).toEqual([]);
  await context.close();
});
