// CP-03 master-data administration in Chromium against the production build (fake Firebase project and
// fake FastAPI inside the browser; nothing leaves it). An administrator changes all five master areas
// online; with the network disconnected the same screens show the stored data and offer no changes;
// a read-only user sees the data without any management actions.
import { chromium, devices, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { FIELD_PERMS, createFakeNetwork, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const ADMIN = 'admin.masters@example.com';
const VIEWER = 'viewer.masters@example.com';
const MANAGE = ['trains.read', 'questions.manage', 'complaints.masters.manage', 'inventory.items.manage', 'policies.manage'];
const net = createFakeNetwork({
  today: istDate(new Date()),
  users: {
    [ADMIN]: meFor({ id: IDS.supervisor, name: 'Asha Admin', email: ADMIN, roleId: 2, divisionId: IDS.division, perms: [...FIELD_PERMS, ...MANAGE] }),
    [VIEWER]: meFor({ id: IDS.outsider, name: 'Vijay Viewer', email: VIEWER, roleId: 3, divisionId: IDS.division, perms: [...FIELD_PERMS, 'users.read', 'trains.read'] }),
  },
});
const { server } = net;

let dir;
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swachh-masters-'));
});
test.afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch { /* Windows may keep the profile locked briefly */ }
});

const toast = (page, text) => expect(page.getByTestId('toast').filter({ hasText: text }).first()).toBeVisible();

async function signIn(page, email, firstName) {
  await page.goto('/#/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('E2e-Password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: `Welcome, ${firstName}` })).toBeVisible();
}

async function openTab(page, name) {
  await page.goto('/#/masters');
  await page.getByRole('tab', { name }).click();
}

test('master data: online administration, offline reads, read-only users', async () => {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, { ...pixel, baseURL: 'http://localhost:4175/' });
  await net.install(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await signIn(page, ADMIN, 'Asha');

  // ---- inventory items: client validation, create ----
  await openTab(page, 'Inventory items');
  await expect(page.getByRole('row', { name: /Phenyl/ })).toBeVisible();
  await page.getByRole('button', { name: 'Add item' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Item name').fill('x');
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await expect(dialog.getByText('Name must be 2–100 characters.')).toBeVisible();
  await expect(dialog.getByText('Choose a unit.')).toBeVisible();
  expect(server.masterWrites).toEqual([]); // nothing sent while invalid
  await dialog.getByLabel('Item name').fill('Garbage bags');
  await dialog.getByRole('combobox', { name: /^Unit/ }).selectOption('nos');
  await dialog.getByLabel('Ideal quantity per journey').fill('50');
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await toast(page, 'Item created.');
  await expect(page.getByRole('row', { name: /Garbage bags/ })).toContainText('Numbers (nos)');
  // server-side duplicate rule surfaces as a readable error
  await page.getByRole('button', { name: 'Add item' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Item name').fill('Phenyl');
  await dialog.getByRole('combobox', { name: /^Unit/ }).selectOption('ltr');
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await expect(dialog.getByText('Item already exists in this division')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // search
  await page.getByRole('textbox', { name: 'Search' }).fill('garb');
  await expect(page.getByRole('row', { name: /Phenyl/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Garbage bags/ })).toBeVisible();

  // ---- complaint categories: deactivate with confirmation ----
  await openTab(page, 'Complaint categories');
  const cleanliness = page.getByRole('row', { name: /^Cleanliness/ });
  await cleanliness.getByRole('button', { name: 'Deactivate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
  await toast(page, 'Cleanliness deactivated.');
  await expect(cleanliness).toContainText('Inactive');

  // ---- complaint departments: create ----
  await openTab(page, 'Complaint departments');
  await page.getByRole('button', { name: 'Add department' }).click();
  await page.getByRole('dialog').getByLabel('Department name').fill('Electrical');
  await page.getByRole('dialog').getByRole('button', { name: 'Create department' }).click();
  await toast(page, 'Department created.');
  await expect(page.getByRole('row', { name: /Electrical/ })).toContainText('Active');

  // ---- division policy: edit with confirmation ----
  await openTab(page, 'Division policy');
  await page.getByRole('button', { name: 'Edit policy' }).click();
  await page.getByLabel('Default complaint SLA (hours)').fill('24');
  await page.getByRole('button', { name: 'Save 1 change(s)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save policy' }).click();
  await toast(page, 'Division policy saved.');
  await expect(page.getByTestId('policy-complaint_default_sla_hours')).toContainText('24');

  // ---- question banks: new version, then activate ----
  await openTab(page, 'Question banks');
  await page.getByRole('row', { name: /^passenger bank/ }).getByRole('button', { name: 'New version' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Bank name' })).toHaveValue('passenger bank (revised)');
  await expect(dialog.getByTestId('question-row')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Remove question 3' }).click();
  await dialog.getByRole('button', { name: 'Save new version' }).click();
  await toast(page, 'saved as an inactive version');
  const revised = page.getByRole('row', { name: /passenger bank \(revised\)/ });
  await expect(revised).toContainText('Inactive');
  await revised.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Activate' }).click();
  await toast(page, 'is now active');
  await expect(revised).toContainText('Active');
  await expect(page.getByRole('row', { name: /^passenger bank Passenger/ })).toContainText('Inactive');

  expect(server.masterWrites.map((w) => `${w.method} ${w.path.replace(/[0-9a-f-]{36}/g, ':id')}`)).toEqual([
    'POST /inventory/items', 'PATCH /complaints/categories/:id', 'POST /complaints/departments', 'PUT /divisions/:id/policy',
    'POST /feedback/question-banks', 'POST /feedback/question-banks/:id/activate',
  ]);
  expect(new Set(server.masterWrites.map((w) => w.by))).toEqual(new Set([ADMIN]));

  // ---- offline: stored data, no management actions, after a reload ----
  server.connected = false;
  await context.setOffline(true);
  await page.reload();
  await openTab(page, 'Inventory items');
  await expect(page.getByRole('row', { name: /Garbage bags/ })).toBeVisible();
  await expect(page.getByTestId('master-offline-note')).toBeVisible();
  await expect(page.getByText('Offline — showing data stored on this device.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
  await openTab(page, 'Complaint categories');
  await expect(page.getByRole('row', { name: /^Cleanliness/ })).toContainText('Inactive');
  await openTab(page, 'Complaint departments');
  await expect(page.getByRole('row', { name: /Electrical/ })).toBeVisible();
  await openTab(page, 'Division policy');
  await expect(page.getByTestId('policy-complaint_default_sla_hours')).toContainText('24');
  await expect(page.getByRole('button', { name: 'Edit policy' })).toHaveCount(0);
  await openTab(page, 'Question banks');
  await expect(page.getByRole('row', { name: /passenger bank \(revised\)/ })).toContainText('Active');
  await expect(page.getByRole('button', { name: 'New bank' })).toHaveCount(0);
  const writes = server.masterWrites.length;

  // ---- read-only user: sees the data, cannot change it ----
  server.connected = true;
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, VIEWER, 'Vijay');
  await openTab(page, 'Inventory items');
  await expect(page.getByRole('row', { name: /Garbage bags/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Deactivate|Activate/ })).toHaveCount(0);
  await openTab(page, 'Division policy');
  await expect(page.getByTestId('policy-complaint_default_sla_hours')).toContainText('24');
  await expect(page.getByRole('button', { name: 'Edit policy' })).toHaveCount(0);
  await openTab(page, 'Question banks');
  await expect(page.getByRole('button', { name: /New version|New bank/ })).toHaveCount(0);
  expect(server.masterWrites.length).toBe(writes);
  await context.close();
});
