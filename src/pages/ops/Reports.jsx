// CP-11 Reports. Online, every figure comes from the FastAPI report endpoints. Offline (or when the
// server is unreachable) the same reports are calculated from the records stored on this device
// (src/services/localReports.js, same formulas) and labelled as such; the last server report loaded on
// this device can be shown instead, with its timestamp. Nothing here is estimated or invented.
import { useEffect, useState } from 'react';
import { useQueueState, useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { responseCacheKey } from '../../services/localFirstApi.js';
import {
  Badge, DataState, Field, PageHeader, Panel, STATE_TONE, Segmented, Stat, Table, Tabs, fmtDate, fmtDateTime, label,
} from '../../components/ui.jsx';
import { daysAgo, today } from '../../utils/capture.js';

const TABS = [
  { value: 'attendance', label: 'Attendance' },
  { value: 'journeys', label: 'Journeys' },
  { value: 'inspections', label: 'Inspections' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'psi', label: 'PSI' },
  { value: 'complaints', label: 'Complaints' },
  { value: 'inventory', label: 'Inventory' },
];

const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const num = (v) => (v == null ? '—' : Number.isInteger(v) ? v : Number(v).toFixed(2));

// CSV of the rows shown (client-side export; the server has no export endpoint).
function downloadCsv(name, columns, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [columns.map((c) => cell(c.label)).join(','), ...rows.map((r) => columns.map((c) => cell(c.value ? c.value(r) : r[c.key])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportTable({ name, rows, columns, rowKey }) {
  return (
    <>
      <div className="mb-2 flex justify-end">
        <button type="button" className="btn-link text-xs" onClick={() => downloadCsv(name, columns, rows)} disabled={!rows.length}>Export CSV</button>
      </div>
      <Table rowKey={rowKey} rows={rows} columns={columns.map((c) => ({ key: c.key, label: c.label, render: c.render ?? (c.value ? (r) => c.value(r) : undefined) }))} />
    </>
  );
}

// Where the figures came from, stated plainly.
function SourceNote({ res, lastPullAt }) {
  if (res.source === 'local') {
    return (
      <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200" data-testid="report-source">
        Offline — calculated on this device from the records stored here
        {lastPullAt ? ` (last synchronized ${fmtDateTime(lastPullAt)})` : ' (never synchronized)'}. Records captured on other devices
        are included only after they reach this device, so these figures may be incomplete.
      </p>
    );
  }
  if (res.source === 'snapshot') {
    return (
      <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200" data-testid="report-source">
        Offline — server report as last loaded on this device{res.cachedAt ? ` at ${fmtDateTime(res.cachedAt)}` : ''}. It does not include anything recorded since.
      </p>
    );
  }
  return null;
}

// The last server response for this report (sync_meta), offered offline next to the device calculation.
function useSnapshot(path, query, enabled) {
  const { outbox, user } = useSession();
  const key = enabled ? responseCacheKey(user?.id, path, query) : null;
  const [snap, setSnap] = useState(null);
  useEffect(() => {
    let off = false;
    setSnap(null);
    if (key) outbox.getMetaEntry(key).then((e) => !off && e && setSnap({ data: JSON.parse(e.value), cachedAt: e.updated_at }), () => {});
    return () => {
      off = true;
    };
  }, [key, outbox]);
  return snap;
}

const COLUMNS = {
  attendanceEmployee: [
    { key: 'label', label: 'Employee' }, { key: 'journeys', label: 'Journeys' }, { key: 'records', label: 'Records' },
    ...[1, 2, 3, 4, 5].map((s) => ({ key: `s${s}`, label: `S${s}`, value: (r) => r.stages?.[s] ?? 0 })),
    { key: 'verified', label: 'Verified' }, { key: 'rejected', label: 'Rejected' },
  ],
  inspections: (coachWise) => [
    { key: 'train_no', label: 'Train' }, { key: 'journey_date', label: 'Date', value: (r) => r.journey_date, render: (r) => fmtDate(r.journey_date) },
    ...(coachWise ? [{ key: 'coach_code', label: 'Coach' }] : []),
    { key: 'progress', label: 'Done', value: (r) => `${r.done}/${r.required}` }, { key: 'completion_pct', label: 'Completion', value: (r) => pct(r.completion_pct) },
    { key: 'verified', label: 'Verified' }, { key: 'rejected', label: 'Rejected' },
  ],
  journeys: [
    { key: 'train_no', label: 'Train', value: (j) => `${j.train_no} ${j.train_name ?? ''}`.trim() },
    { key: 'journey_date', label: 'Start', render: (j) => fmtDate(j.journey_date), value: (j) => j.journey_date },
    { key: 'end_date', label: 'End', render: (j) => fmtDate(j.end_date), value: (j) => j.end_date },
    { key: 'state', label: 'State', value: (j) => j.state, render: (j) => <Badge tone={STATE_TONE[j.state]}>{label(j.state)}</Badge> },
    { key: 'supervisor', label: 'Supervisor', value: (j) => j.supervisor_name ?? '—' },
    { key: 'staff', label: 'Staff', value: (j) => j.staff?.length ?? 0 }, { key: 'coaches', label: 'Coaches', value: (j) => j.coaches?.length ?? 0 },
  ],
  psi: [
    { key: 'train_no', label: 'Train' }, { key: 'journey_date', label: 'Date', render: (r) => fmtDate(r.journey_date), value: (r) => r.journey_date },
    { key: 'responses', label: 'Responses' }, { key: 'psi', label: 'PSI', value: (r) => pct(r.psi) },
  ],
  inventory: [
    { key: 'item_name', label: 'Item' }, { key: 'unit', label: 'Unit' }, { key: 'issued', label: 'Issued', value: (r) => num(r.issued) },
    { key: 'returned', label: 'Returned', value: (r) => num(r.returned) }, { key: 'consumed', label: 'Consumed', value: (r) => num(r.consumed) },
    { key: 'journeys', label: 'Journeys' },
  ],
};

function Body({ tab, data, opts, name }) {
  if (tab === 'attendance') {
    const cols = opts.groupBy === 'journey' ? [{ key: 'label', label: 'Journey' }, ...COLUMNS.attendanceEmployee.slice(1)] : COLUMNS.attendanceEmployee;
    return <ReportTable name={name} rowKey={(r) => r.key_id} rows={data} columns={cols} />;
  }
  if (tab === 'inspections') return <ReportTable name={name} rowKey={(r) => `${r.journey_id}${r.coach_code ?? ''}`} rows={data} columns={COLUMNS.inspections(opts.coachWise)} />;
  if (tab === 'journeys') {
    const by = data.items.reduce((m, j) => ({ ...m, [j.state]: (m[j.state] ?? 0) + 1 }), {});
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2"><Badge tone="teal">Total {data.total}</Badge>{Object.entries(by).map(([k, v]) => <Badge key={k} tone={STATE_TONE[k]}>{label(k)}: {v}</Badge>)}</div>
        {data.total > data.items.length && <p className="text-xs text-slate-500">Showing the first {data.items.length} of {data.total} journeys.</p>}
        <ReportTable name={name} rowKey={(j) => j.id} rows={data.items} columns={COLUMNS.journeys} />
      </div>
    );
  }
  if (tab === 'feedback') {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2"><Badge tone="teal">Total {data.total}</Badge>{Object.entries(data.by_status).map(([k, v]) => <Badge key={k}>{label(k)}: {v}</Badge>)}
          {Object.entries(data.by_coach_class ?? {}).map(([k, v]) => <Badge key={k} tone="slate">{k === 'AC' ? 'AC' : 'Non-AC'}: {v}</Badge>)}</div>
        <ReportTable name={name} rowKey={(r) => r.question_id} rows={data.questions} columns={[
          { key: 'position', label: '#' }, { key: 'text_en', label: 'Question' }, { key: 'responses', label: 'Responses' },
          { key: 'average', label: `Average (${data.scale_min ?? '—'}–${data.scale_max ?? '—'})`, value: (r) => r.average?.toFixed(2) ?? '—' },
        ]} />
      </div>
    );
  }
  if (tab === 'psi') return <ReportTable name={name} rowKey={(r) => r.journey_id} rows={data} columns={COLUMNS.psi} />;
  if (tab === 'complaints') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Total" value={data.total} /><Stat label="Overdue" value={data.overdue} tone="red" />
          <Stat label="Avg resolution" value={data.avg_resolution_hours != null ? `${data.avg_resolution_hours.toFixed(1)} h` : '—'} tone="slate" />
        </div>
        <div className="flex flex-wrap gap-2">{Object.entries(data.by_status).map(([k, v]) => <Badge key={k} tone={STATE_TONE[k]}>{label(k)}: {v}</Badge>)}</div>
        <ReportTable name={name} rowKey={(r) => r.category_id ?? r.category} rows={data.by_category} columns={[
          { key: 'category', label: 'Category' }, { key: 'total', label: 'Total' }, { key: 'open', label: 'Open' },
        ]} />
      </div>
    );
  }
  return <ReportTable name={name} rowKey={(r) => r.item_id} rows={data} columns={COLUMNS.inventory} />;
}

const EMPTY = {
  attendance: 'No attendance in this period.', journeys: 'No journeys in this period.', inspections: 'No inspections in this period.',
  feedback: 'No feedback in this period.', psi: 'No PSI data in this period.', complaints: 'No complaints in this period.', inventory: 'No inventory movement in this period.',
};

function Report({ tab, q }) {
  const { lastPullAt } = useQueueState();
  const [audience, setAudience] = useState('passenger');
  const [groupBy, setGroupBy] = useState('employee');
  const [coachWise, setCoachWise] = useState(false);
  const [view, setView] = useState('device');
  const path = {
    attendance: '/reports/attendance', journeys: '/journeys', inspections: '/reports/inspections', feedback: `/reports/feedback/${audience}`,
    psi: '/reports/psi', complaints: '/reports/complaints', inventory: '/reports/inventory',
  }[tab];
  const query = tab === 'attendance' ? { ...q, group_by: groupBy }
    : tab === 'inspections' ? { ...q, coach_wise: coachWise }
      : tab === 'journeys' ? { division_id: q.division_id, date_from: q.date_from, date_to: q.date_to, page_size: 200 } : q;
  const res = useResource(path, query);
  const snapshot = useSnapshot(path, query, res.source === 'local' && path.startsWith('/reports/'));
  const shown = view === 'server' && snapshot ? { ...res, data: snapshot.data, source: 'snapshot', cachedAt: snapshot.cachedAt } : res;
  const isEmpty = (d) => (Array.isArray(d) ? !d.length : d.items ? !d.items.length : !d.total);
  const name = `swachh-safar-${tab}${tab === 'feedback' ? `-${audience}` : ''}-${q.date_from}-to-${q.date_to}${shown.source === 'local' ? '-device-only' : ''}`;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {tab === 'attendance' && <Segmented label="Group by" value={groupBy} onChange={setGroupBy} options={[{ value: 'employee', label: 'Staff-wise' }, { value: 'journey', label: 'Journey-wise' }]} />}
        {tab === 'inspections' && <Segmented label="Detail" value={coachWise} onChange={setCoachWise} options={[{ value: false, label: 'Journey-wise' }, { value: true, label: 'Coach-wise' }]} />}
        {tab === 'feedback' && <Segmented label="Audience" value={audience} onChange={setAudience} options={[{ value: 'passenger', label: 'Passenger' }, { value: 'railway', label: 'Railway' }]} />}
        {snapshot && (
          <Segmented label="Figures" value={view} onChange={setView}
            options={[{ value: 'device', label: 'This device' }, { value: 'server', label: `Last server report (${fmtDateTime(snapshot.cachedAt)})` }]} />
        )}
      </div>
      <SourceNote res={shown} lastPullAt={lastPullAt} />
      {tab === 'feedback' && audience === 'railway' && shown.source === 'local' && (
        <p className="mb-3 text-xs text-slate-500">Verification states are those last received from the server. “Status unknown” records were synchronized but their status has not been received on this device; “Not synced” records are not on the server yet.</p>
      )}
      <DataState res={{ ...shown, stale: false }} isEmpty={isEmpty} empty={EMPTY[tab]}>
        {(data) => <Body tab={tab} data={data} opts={{ groupBy, coachWise }} name={name} />}
      </DataState>
    </>
  );
}

export default function Reports() {
  const { can } = useSession();
  const division = useDivision();
  const tabs = TABS.filter((t) => t.value !== 'journeys' || can('journeys.read') || can('journeys.read_all'));
  const [tab, setTab] = useState('attendance');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const q = { date_from: from, date_to: to, division_id: division.divisionId };
  return (
    <>
      <PageHeader title="Reports" subtitle={division.current?.name} actions={<DivisionPicker division={division} />} />
      <Panel className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </Panel>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <Panel><Report tab={tab} q={q} key={tab} /></Panel>
    </>
  );
}
