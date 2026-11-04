// Report formula parity: the device's offline reports (src/services/localReports.js) against the server's
// (backend/app/services/reports.py) for the same data.
//
// tests/fixtures/report-parity.json is produced by backend/tests/test_report_parity.py against a real
// PostgreSQL database through the real API: the API responses a device downloads, plus the server's report
// responses for 30 report queries. Here those downloads go through the device's own ingestion
// (ingestChanges / ingestResponse) into SQLite, and every report is recalculated locally. The only
// normalisation is JSON serialisation (key order, number formatting); numbers are compared exactly.
//
// Regenerate after a backend report change: PARITY_EXPORT=../tests/fixtures/report-parity.json pytest tests/test_report_parity.py
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMemoryDb } from '../helpers/memoryDb.js';
import { createMemoryFiles } from '../helpers/memoryFiles.js';
import { createLocalStore } from '../../src/services/localStore.js';
import { createLocalApi } from '../../src/services/localApi.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/report-parity.json', import.meta.url), 'utf8'));
const json = (v) => JSON.parse(JSON.stringify(v));

async function deviceWithServerData() {
  const db = await createMemoryDb();
  const store = createLocalStore({ db, files: createMemoryFiles(), now: () => new Date(fixture.generated_at), logger: null });
  const [, , changes] = fixture.downloads[0];
  expect((await store.ingestChanges(changes)).ok).toBe(true);
  for (const [method, path, data] of fixture.downloads.slice(1)) await store.ingestResponse(method, path, data);
  const ctx = { userId: fixture.me.user.id, permissions: fixture.me.divisions };
  return { db, store, api: createLocalApi({ store, getContext: () => ctx }) };
}

describe('report parity with the backend (same data)', () => {
  it('the fixture covers every report and a non-trivial dataset', () => {
    const paths = new Set(fixture.reports.map((r) => r.path));
    expect([...paths].sort()).toEqual(['/reports/attendance', '/reports/complaints', '/reports/feedback/passenger', '/reports/feedback/railway',
      '/reports/inspections', '/reports/inventory', '/reports/psi']);
    expect(fixture.reports.length).toBe(30);
  });

  for (const r of fixture.reports) {
    it(`${r.path} ${new URLSearchParams(r.query)}`, async () => {
      const { api } = await deviceWithServerData();
      expect(json(await api.get(r.path, r.query))).toEqual(json(r.response));
    });
  }
});
