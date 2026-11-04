// Offline operation of the real screens, in Chromium, against the production build.
//
// Network: the browser context is put offline (context.setOffline) and, as a second guard, every
// /api/v1 and Google API request is aborted while "disconnected". While connected, the test itself
// plays FastAPI (/auth/me, /sync/changes, /sync/batch, /media) and Firebase Auth (fake project,
// fake token). No request leaves the browser: nothing touches production Firebase or a real backend.
//
// Scenario: sign in and pull master data/journeys online -> disconnect -> capture attendance,
// inspection, passenger feedback, railway feedback, a complaint and an inventory issue + return through the
// UI -> read the reports calculated on the device -> reload offline ->
// restart the whole browser offline -> reconnect -> everything is delivered exactly once.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { FIELD_PERMS, createFakeNetwork, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const BASE = 'http://localhost:4175/';
const EMAIL = 'supervisor.e2e@example.com';
const TODAY = istDate(new Date());
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ME = meFor({ id: IDS.supervisor, name: 'Ravi Kumar', email: EMAIL, roleId: 4, divisionId: IDS.division, perms: [...FIELD_PERMS, 'inventory.read', 'inventory.transact', 'reports.read'] });
const net = createFakeNetwork({ users: { [EMAIL]: ME }, today: TODAY });
const { server } = net;
const installNetwork = (context) => net.install(context);

async function launch(dir, { offline = false } = {}) {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, {
    ...pixel, baseURL: BASE, offline, geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 }, permissions: ['geolocation'],
  });
  await installNetwork(context);
  return context;
}

async function disconnect(context, page) {
  server.connected = false;
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
}

const toast = (page, text) => expect(page.getByTestId('toast').filter({ hasText: text }).first()).toBeVisible();
const queueBadge = (page) => page.getByTestId('ops-queue');

async function captureEvidence(dialog) {
  await dialog.getByRole('button', { name: 'Get GPS' }).click();
  await expect(dialog.getByText('28.61390, 77.20900')).toBeVisible();
  await dialog.getByTestId('photo-input').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG });
  await expect(dialog.getByAltText('Captured evidence')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

let profileDir;
test.beforeAll(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'swachh-offline-'));
});
test.afterAll(() => {
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch { /* Windows can keep the profile locked briefly; it is in the OS temp directory */ }
});

test('operational screens capture and keep records with the network disconnected', async () => {
  // ---- online: sign in, cache authorization, pull master data and journeys ----
  let context = await launch(profileDir);
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('E2e-Password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: 'Welcome, Ravi' })).toBeVisible();
  // /journeys itself is unreachable in this test: the list appears once /sync/changes is committed to
  // SQLite, and the open screen re-reads it then (queue revision) without a reload.
  await page.goto('/#/journeys');
  await expect(page.getByText('Mumbai Rajdhani').first()).toBeVisible({ timeout: 60_000 });

  // ---- disconnect ----
  await disconnect(context, page);
  await page.reload(); // served by the service worker
  await expect(page.getByText('Signed in offline with your cached profile')).toBeVisible();

  // Attendance: Sunita Devi, stage 1 (Source)
  await page.goto('/#/attendance');
  await page.getByRole('button', { name: /12951/ }).click();
  await expect(page.getByText('Offline — showing data stored on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Sunita Devi stage 1 next' }).click();
  let dialog = page.getByRole('dialog');
  await captureEvidence(dialog);
  await dialog.getByRole('button', { name: 'Mark attendance' }).click();
  await toast(page, 'Attendance saved on this device');
  await expect(page.getByRole('button', { name: 'Sunita Devi stage 1 pending sync' })).toBeVisible();

  // Coach inspection: B1, day 1, round 1, Before
  await page.goto('/#/inspections');
  await page.getByRole('button', { name: /12951/ }).click();
  await page.getByRole('button', { name: 'Coach B1 open' }).click();
  dialog = page.getByRole('dialog');
  await captureEvidence(dialog);
  await dialog.getByLabel('Comments').fill('Floor mopped, dustbin emptied');
  await dialog.getByRole('button', { name: 'Submit inspection' }).click();
  await toast(page, 'Inspection saved on this device');
  await expect(page.getByRole('button', { name: 'Coach B1 pending' })).toBeVisible();

  // Passenger feedback (details; PNR/OTP verification stays pending until online)
  await page.goto('/#/feedback');
  await page.getByRole('combobox', { name: 'Journey', exact: true }).selectOption({ label: '12951 · Mumbai Rajdhani' });
  await page.getByRole('combobox', { name: 'Coach', exact: true }).selectOption({ label: 'B1 (AC)' });
  await page.getByLabel('Passenger name').fill('Amit Patel');
  await page.getByLabel('Mobile').fill('9876543210');
  await page.getByLabel('PNR').fill('2451870001');
  await page.getByLabel('Seat').fill('23');
  await page.getByRole('button', { name: 'Get GPS' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await toast(page, 'Passenger details saved on this device');

  // Railway official feedback with ratings from the (local) question bank
  await page.getByRole('tab', { name: 'Railway official' }).click();
  await page.getByRole('combobox', { name: 'Journey', exact: true }).selectOption({ label: '12951 · Mumbai Rajdhani' });
  await page.getByLabel('Railway employee ID').fill('RLY42');
  await page.getByLabel('Official name').fill('A. Inspector');
  await expect(page.getByText('1. Question 1')).toBeVisible();
  await page.getByText('1. Question 1').locator('..').getByRole('button', { name: '4', exact: true }).click();
  await page.getByRole('button', { name: 'Get GPS' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await toast(page, 'Railway feedback saved on this device');

  await page.getByRole('tab', { name: 'Records' }).click();
  await expect(page.getByRole('row', { name: /Amit Patel/ })).toContainText('Not synced');

  // Complaint
  await page.goto('/#/complaints');
  await page.getByRole('button', { name: 'New complaint' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Category', exact: true }).selectOption({ label: 'Cleanliness' });
  await dialog.getByLabel('Description').fill('Toilet in coach B1 not cleaned since departure');
  await dialog.getByRole('button', { name: 'Raise complaint' }).click();
  await toast(page, 'Complaint saved on this device');
  await expect(page.getByRole('row', { name: /Toilet in coach B1/ })).toContainText('Not synced');
  await expect(queueBadge(page)).toHaveText(/5 pending/);

  // Inventory: issue 10 litres of Phenyl to coach B1, then return 4 (immutable transactions, confirmed first)
  await page.goto('/#/inventory');
  await page.getByRole('button', { name: /12951/ }).click();
  for (const [action, quantity] of [['Issue', '10'], ['Return', '4']]) {
    await page.getByRole('button', { name: action, exact: true }).click();
    dialog = page.getByRole('dialog', { name: `${action} inventory` });
    await dialog.getByRole('combobox', { name: /^Item/ }).selectOption({ label: 'Phenyl (litre)' });
    await dialog.getByRole('combobox', { name: /^Coach/ }).selectOption({ label: 'B1' });
    await dialog.getByRole('spinbutton').fill(quantity);
    await dialog.getByRole('button', { name: `Review ${action.toLowerCase()}` }).click();
    await page.getByRole('dialog', { name: `Confirm ${action.toLowerCase()}` }).getByRole('button', { name: `Record ${action.toLowerCase()}` }).click();
    await toast(page, `${action} saved on this device`);
  }
  await expect(page.getByRole('row', { name: /Phenyl.*B1/ }).first()).toContainText('6'); // consumed = 10 − 4
  // A return larger than what is outstanding is refused before anything is saved.
  await page.getByRole('button', { name: 'Return', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Return inventory' });
  await dialog.getByRole('combobox', { name: /^Item/ }).selectOption({ label: 'Phenyl (litre)' });
  await dialog.getByRole('combobox', { name: /^Coach/ }).selectOption({ label: 'B1' });
  await dialog.getByRole('spinbutton').fill('7');
  await expect(dialog.getByText('A return cannot exceed the quantity issued.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Review return' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(queueBadge(page)).toHaveText(/7 pending/);

  // Reports, calculated on the device and labelled as such
  await page.goto('/#/reports');
  await expect(page.getByTestId('report-source')).toContainText('calculated on this device');
  await expect(page.getByRole('row', { name: /Sunita Devi/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Inventory' }).click();
  await expect(page.getByRole('row', { name: /Phenyl/ })).toContainText(/10.*4.*6/);

  // ---- reload while offline ----
  await page.reload();
  await page.goto('/#/complaints');
  await expect(page.getByRole('row', { name: /Toilet in coach B1/ })).toContainText('Not synced');
  await expect(queueBadge(page)).toHaveText(/7 pending/);

  // ---- restart the whole browser, still offline ----
  await context.close();
  context = await launch(profileDir, { offline: true });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`/#/attendance/${IDS.journey}`);
  await expect(page.getByText('Signed in offline with your cached profile')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sunita Devi stage 1 pending sync' })).toBeVisible();
  await page.goto(`/#/inspections/${IDS.journey}`);
  await expect(page.getByRole('button', { name: 'Coach B1 pending' })).toBeVisible();
  await expect(queueBadge(page)).toHaveText(/7 pending/);
  await page.goto(`/#/inventory/${IDS.journey}`);
  await expect(page.getByRole('row', { name: /Phenyl.*B1/ }).first()).toContainText('6');
  expect(server.batches).toEqual([]); // nothing was delivered while disconnected
  expect(server.offlineHits.filter((u) => u.includes('/sync/batch'))).toEqual([]); // ...and not even attempted

  // ---- reconnect while the inspection screen stays open: the queue delivers everything, once ----
  await page.goto(`/#/inspections/${IDS.journey}`);
  await expect(page.getByRole('button', { name: 'Coach B1 pending' })).toBeVisible();
  server.connected = true;
  await context.setOffline(false);
  await expect(page.getByText('All records synced')).toBeVisible({ timeout: 60_000 });
  // No reload: the open screen re-reads once the outcome is committed (queue revision), and the record
  // state was committed together with the outbox entry, so "All records synced" implies "taken".
  await expect(page.getByRole('button', { name: 'Coach B1 taken' })).toBeVisible();
  expect(server.batches.map((o) => o.type).sort()).toEqual([
    'attendance.create', 'complaint.create', 'feedback.passenger.start', 'feedback.railway.create', 'inspection.create',
    'inventory.record', 'inventory.record',
  ]);
  expect(new Set(server.batches.map((o) => o.op_id)).size).toBe(server.batches.length); // each operation exactly once
  // The issue reaches the server before the return that depends on it.
  expect(server.batches.filter((o) => o.type === 'inventory.record').map((o) => [o.payload.txn_type, o.payload.quantity])).toEqual([['issue', 10], ['return', 4]]);
  const att = server.batches.find((o) => o.type === 'attendance.create').payload;
  expect(att).toMatchObject({ journey_id: IDS.journey, employee_id: IDS.janitor1, stage: 1, latitude: 28.6139, longitude: 77.209 });
  const passenger = server.batches.find((o) => o.type === 'feedback.passenger.start').payload;
  expect(passenger).toMatchObject({ pnr: '2451870001', coach_code: 'B1', seat_no: '23', mobile: '9876543210' });
  // Photos were stored on the device and uploaded (JPEG re-encoded by the capture step) before their records.
  for (const id of [att.photo_media_id, server.batches.find((o) => o.type === 'inspection.create').payload.photo_media_id]) {
    const init = server.mediaInit.find((m) => m.id === id);
    expect(init).toMatchObject({ content_type: 'image/jpeg', size_bytes: server.uploads.get(id).length });
    expect(init.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  await page.reload();
  await expect(page.getByRole('button', { name: 'Coach B1 taken' })).toBeVisible();
  await page.goto(`/#/inventory/${IDS.journey}`);
  await expect(page.getByRole('row', { name: /Return Phenyl/ })).toContainText('On server');
  await expect(page.getByText('Not synced')).toHaveCount(0); // acknowledged, never claimed earlier
  await context.close();
});
