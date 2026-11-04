// Media evidence in the real browser (Chromium, Pixel 7 emulation, production build, OPFS): inspection
// photo + video captured offline, unsupported and oversized videos refused before saving, bytes kept
// across reload and a full browser restart, then uploaded once with matching SHA-256 on reconnect.
// Test files are injected through the file input (no physical camera); real device capture is NOT
// covered here.
import { chromium, devices, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDS } from '../helpers/operationalFixtures.js';
import { FIELD_PERMS, createFakeNetwork, meFor } from './fakeNetwork.js';
import { istDate } from '../../src/utils/businessDate.js';

const BASE = 'http://localhost:4175/';
const EMAIL = 'media.e2e@example.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
// A minimal MP4 header ('ftyp') followed by deterministic filler: enough for type handling and checksums.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4096, 7)]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const net = createFakeNetwork({ users: { [EMAIL]: meFor({ id: IDS.supervisor, name: 'Ravi Kumar', email: EMAIL, roleId: 4, divisionId: IDS.division, perms: FIELD_PERMS }) }, today: istDate(new Date()) });

async function launch(dir, offline = false) {
  const { defaultBrowserType, ...pixel } = devices['Pixel 7'];
  const context = await chromium.launchPersistentContext(dir, {
    ...pixel, baseURL: BASE, offline, geolocation: { latitude: 28.6139, longitude: 77.209, accuracy: 15 }, permissions: ['geolocation'],
  });
  await net.install(context);
  return context;
}

let dir;
test.beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'swachh-media-')); });
test.afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows lock */ } });

test('inspection video and photo: validated, persisted offline across restart, uploaded once with matching checksums', async () => {
  const { server } = net;
  let context = await launch(dir);
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/#/login');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('E2e-Password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/#/journeys');
  await expect(page.getByText('Mumbai Rajdhani').first()).toBeVisible({ timeout: 60_000 });

  server.connected = false;
  await context.setOffline(true);
  await page.goto(`/#/inspections/${IDS.journey}`);
  await page.getByRole('button', { name: 'Coach B1 open' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Get GPS' }).click();
  await dialog.getByTestId('photo-input').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG });
  // Unsupported format and oversized files are refused with a reason, and nothing is attached.
  await dialog.getByTestId('video-input').setInputFiles({ name: 'clip.avi', mimeType: 'video/x-msvideo', buffer: MP4 });
  await expect(dialog.getByRole('alert')).toContainText('not supported');
  await dialog.getByTestId('video-input').setInputFiles({ name: 'big.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(26 * 1024 * 1024 + 1) });
  await expect(dialog.getByRole('alert')).toContainText('MB');
  await expect(dialog.getByTestId('video-preview')).toHaveCount(0);
  // Android camera apps may report no type: the extension decides.
  await dialog.getByTestId('video-input').setInputFiles({ name: 'VID_0001.mp4', mimeType: '', buffer: MP4 });
  await expect(dialog.getByTestId('video-preview')).toBeVisible();
  await dialog.getByRole('button', { name: 'Submit inspection' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Inspection saved on this device' }).first()).toBeVisible();

  // ---- reload and full restart, offline: the video is read back from device storage ----
  await page.reload();
  await context.close();
  context = await launch(dir, true);
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`/#/inspections/${IDS.journey}`);
  await page.getByRole('tab', { name: 'Records' }).click();
  await page.getByRole('row', { name: /B1/ }).last().click();
  const detail = page.getByRole('dialog');
  await expect(detail.locator('video')).toHaveAttribute('src', /^blob:/);
  await expect(detail.getByText('Not synced')).toBeVisible();
  expect(server.mediaInit).toEqual([]);

  // ---- reconnect: both files uploaded exactly once, byte-identical, before the record ----
  server.connected = true;
  await context.setOffline(false);
  await expect(page.getByText('All records synced')).toBeVisible({ timeout: 60_000 });
  const [op] = server.batches.filter((o) => o.type === 'inspection.create');
  expect(op.payload.video_media_id).toBeTruthy();
  const video = server.mediaInit.filter((m) => m.id === op.payload.video_media_id);
  expect(video).toHaveLength(1);
  expect(video[0]).toMatchObject({ kind: 'inspection_video', content_type: 'video/mp4', size_bytes: MP4.length, sha256: sha(MP4), division_id: IDS.division });
  expect(Buffer.compare(server.uploads.get(op.payload.video_media_id), MP4)).toBe(0);
  expect(server.mediaInit.filter((m) => m.id === op.payload.photo_media_id)).toHaveLength(1);
  expect(sha(server.uploads.get(op.payload.photo_media_id))).toBe(server.mediaInit.find((m) => m.id === op.payload.photo_media_id).sha256);
  await context.close();
});

// What this Chromium reports for the capabilities the app checks at runtime. Microphone capture is not
// available in Playwright's headless Chromium shell (getUserMedia -> NotSupportedError, which the app shows
// as "No microphone is available"), so microphone permission flows are covered by unit tests with fakes
// (tests/unit/mediaReliability.test.js) and remain NOT VERIFIED on a real browser/device.
test('runtime capability probe: OPFS, persistent storage, MediaRecorder voice format', async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ baseURL: BASE })).newPage();
  await page.goto('/');
  const caps = await page.evaluate(() => ({
    opfs: typeof navigator.storage?.getDirectory === 'function',
    persist: typeof navigator.storage?.persist === 'function',
    webm: MediaRecorder.isTypeSupported('audio/webm;codecs=opus'),
  }));
  expect(caps).toEqual({ opfs: true, persist: true, webm: true });
  await browser.close();
});
