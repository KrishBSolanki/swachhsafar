// CP-02 on a shared device, in Chromium against the production build (fake Firebase project and fake
// FastAPI inside the browser; nothing leaves it).
//
// Supervisor A captures attendance offline and signs out. Janitor B signs in online on the same device:
// A's record must NOT be delivered with B's credentials (it waits, shown as "waiting for another user").
// When A signs in again, it is delivered once, with A's token.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { createFakeNetwork, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const A = 'supervisor.shared@example.com';
const B = 'janitor.shared@example.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const net = createFakeNetwork({
  today: istDate(new Date()),
  users: {
    [A]: meFor({ id: IDS.supervisor, name: 'Ravi Kumar', email: A, roleId: 4, divisionId: IDS.division }),
    [B]: meFor({ id: IDS.janitor1, name: 'Sunita Devi', email: B, roleId: 5, divisionId: IDS.division }),
  },
});
const { server } = net;

let dir;
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swachh-shared-'));
});
test.afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch { /* Windows may keep the profile locked briefly */ }
});

async function signIn(page, email, firstName) {
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('E2e-Password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: `Welcome, ${firstName}` })).toBeVisible();
}

async function signOut(page) {
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test("one user's offline records are never synced with another user's session", async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, {
    ...pixel, baseURL: 'http://localhost:4175/', geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 }, permissions: ['geolocation'],
  });
  await net.install(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

  // A signs in online and the journeys are pulled into SQLite.
  await signIn(page, A, 'Ravi');
  // The open screen re-reads once the pull is committed (queue revision): no reload loop needed.
  await page.goto('/#/attendance');
  await expect(page.getByRole('button', { name: /12951/ })).toBeVisible({ timeout: 60_000 });

  // Offline: A records Sunita Devi's stage 1, then signs out.
  server.connected = false;
  await context.setOffline(true);
  await page.getByRole('button', { name: /12951/ }).click();
  await page.getByRole('button', { name: 'Sunita Devi stage 1 next' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Get GPS' }).click();
  await dialog.getByTestId('photo-input').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG });
  await dialog.getByRole('button', { name: 'Mark attendance' }).click();
  await expect(page.getByRole('button', { name: 'Sunita Devi stage 1 pending sync' })).toBeVisible();
  await expect(page.getByTestId('ops-queue')).toHaveText(/1 pending/);
  await signOut(page);

  // B signs in online on the same device. A's record stays on the device, unsent.
  server.connected = true;
  await context.setOffline(false);
  await signIn(page, B, 'Sunita');
  await expect(page.getByTestId('ops-queue-others')).toHaveText(/1 waiting for another user/);
  // B's own capture syncs, which proves B's queue ran; A's older entry (first in the queue) was not sent.
  await page.goto('/#/complaints');
  await page.getByRole('button', { name: 'New complaint' }).click();
  const form = page.getByRole('dialog');
  await form.getByRole('combobox', { name: 'Category', exact: true }).selectOption({ label: 'Cleanliness' });
  await form.getByLabel('Description').fill('Wash basin blocked in coach S1');
  await form.getByRole('button', { name: 'Raise complaint' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Complaint saved and synchronized' }).first()).toBeVisible();
  expect(server.batches.map((o) => [o.type, o.deliveredBy])).toEqual([['complaint.create', B]]);
  server.batches.length = 0;

  // A returns: delivered exactly once, with A's credentials.
  await signOut(page);
  await signIn(page, A, 'Ravi');
  await expect.poll(() => server.batches.length, { timeout: 60_000 }).toBe(1);
  await expect(page.getByText('All records synced')).toBeVisible();
  await expect(page.getByTestId('ops-queue-others')).toHaveCount(0);
  expect(server.batches.map((o) => [o.type, o.payload.employee_id, o.deliveredBy])).toEqual([['attendance.create', IDS.janitor1, A]]);
  await context.close();
});
