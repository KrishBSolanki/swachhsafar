// Browser end-to-end tests of the Phase 1 scenarios against the production build, real OPFS
// SQLite, the real service worker and the live swachh-safar Firebase project.
// Test accounts are deleted in afterAll.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin } from '../helpers/firebaseAdmin.js';

const BASE = 'http://localhost:4173/';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (tag) => `pwa-e2e-${RUN}-${tag}@example.com`;
const PASSWORD = 'Safar-E2E-2026';
const SAVED_OFFLINE = 'Registration saved locally. Waiting for internet synchronization.';
const SYNCED = 'Registration complete. Your Swachh Safar cloud account and profile have been created.';

const usedEmails = new Set();
const profileDirs = [];
let admin;

// A "phone": persistent Chromium profile (OPFS + service worker survive full restarts).
async function launchDevice(dir) {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  return chromium.launchPersistentContext(dir, { ...pixel, baseURL: BASE });
}

function newProfileDir() {
  const dir = mkdtempSync(join(tmpdir(), 'swachh-e2e-'));
  profileDirs.push(dir);
  return dir;
}

async function openApp(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/');
  await expect(page.getByTestId('db-status')).toHaveText('Ready · persistent');
  return page;
}

async function register(page, address, password = PASSWORD) {
  usedEmails.add(address);
  await page.getByLabel('Username / Email').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Register' }).click();
}

const row = (page, address) => page.locator(`[data-testid="registration-row"][data-email="${address}"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  admin = await createAdmin();
});

test.afterAll(async () => {
  for (const address of usedEmails) {
    for (const acct of await admin.accountsByEmail(address)) {
      for (const p of await admin.queryProfilesByAuthUid(acct.localId)) await admin.deleteDoc(p.name.split('/documents/')[1]);
      await admin.deleteAccount(acct.localId);
    }
  }
  for (const dir of profileDirs) rmSync(dir, { recursive: true, force: true });
});

test('TEST 1 + 5: online registration, then duplicate rejected locally and in the cloud', async () => {
  const context = await launchDevice(newProfileDir());
  const page = await openApp(context);
  await expect(page.getByTestId('network-status')).toHaveText('Online');

  const address = email('online');
  await register(page, address);
  await expect(page.getByTestId('registration-status')).toHaveText(SYNCED);
  await expect(row(page, address)).toHaveAttribute('data-status', 'synced');
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await expect(page.getByTestId('last-sync')).not.toHaveText('Never');

  const accounts = await admin.accountsByEmail(address);
  expect(accounts).toHaveLength(1);
  const profiles = await admin.queryProfilesByAuthUid(accounts[0].localId);
  expect(profiles).toHaveLength(1);
  expect(JSON.stringify(profiles[0].fields)).not.toMatch(/password|salt|hash/i);

  // Same device, same email (different case): rejected before touching SQLite or Firebase.
  await register(page, address.toUpperCase());
  await expect(page.locator('#email-error')).toHaveText('This email is already registered on this device.');

  // Another device, same email, different password: conflict, no second Firebase account.
  const other = await launchDevice(newProfileDir());
  const otherPage = await openApp(other);
  await register(otherPage, address, 'Another-Pass-77');
  await expect(otherPage.getByTestId('registration-status')).toContainText('different password');
  await expect(row(otherPage, address)).toHaveAttribute('data-status', 'conflict');
  expect(await admin.accountsByEmail(address)).toHaveLength(1);

  await other.close();
  await context.close();
});

test('TEST 2, 3, 4 + offline shell: register offline, survive restart, sync after reconnect', async () => {
  const dir = newProfileDir();
  let context = await launchDevice(dir);
  let page = await openApp(context);

  // First online visit installs the service worker and precaches the app shell.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cachedUrls = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
    return urls;
  });
  expect(cachedUrls.some((u) => u.endsWith('.wasm'))).toBe(true);
  expect(cachedUrls.every((u) => u.startsWith(BASE))).toBe(true); // nothing from Firebase/Google is cached

  // Go offline and reload: the app shell and SQLite must start from cache.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('db-status')).toHaveText('Ready · persistent');
  await expect(page.getByTestId('network-status')).toHaveText('Offline');

  const address = email('offline');
  await register(page, address);
  await expect(page.getByTestId('registration-status')).toHaveText(SAVED_OFFLINE);
  await expect(row(page, address)).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('pending-count')).toHaveText('1');
  expect(await admin.accountsByEmail(address)).toHaveLength(0);

  // Nothing secret in browser storage outside SQLite.
  const webStorage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(webStorage).not.toContain(PASSWORD);

  // TEST 3: fully close the "app" (browser process) and reopen it, still offline.
  await context.close();
  context = await launchDevice(dir);
  await context.setOffline(true);
  page = await openApp(context);
  await expect(row(page, address)).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('pending-count')).toHaveText('1');

  // TEST 4: connectivity returns -> password prompt -> Firebase account + profile.
  await context.setOffline(false);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill('Wrong-Pass-1');
  await dialog.getByRole('button', { name: 'Sync account' }).click();
  await expect(dialog).toContainText("doesn't match");
  expect(await admin.accountsByEmail(address)).toHaveLength(0);

  await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sync account' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, address)).toHaveAttribute('data-status', 'synced');
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  await expect(page.getByTestId('toast').first()).toContainText('Synchronization completed');
  expect(await admin.accountsByEmail(address)).toHaveLength(1);

  await context.close();
});

test('TEST 6: Firebase unreachable keeps the registration pending; Sync now completes it', async () => {
  const context = await launchDevice(newProfileDir());
  const page = await openApp(context);

  // Online per the browser, but Firebase Auth requests fail at the network layer.
  await context.route(/identitytoolkit\.googleapis\.com/, (route) => route.abort('internetdisconnected'));
  const address = email('fail');
  await register(page, address);
  await expect(page.getByTestId('registration-status')).toContainText('will be retried automatically');
  await expect(row(page, address)).toHaveAttribute('data-status', 'retrying');
  await expect(page.getByTestId('pending-count')).toHaveText('1');
  expect(await admin.accountsByEmail(address)).toHaveLength(0);

  await context.unroute(/identitytoolkit\.googleapis\.com/);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(row(page, address)).toHaveAttribute('data-status', 'synced');
  await expect(page.getByTestId('pending-count')).toHaveText('0');
  expect(await admin.accountsByEmail(address)).toHaveLength(1);

  await context.close();
});
