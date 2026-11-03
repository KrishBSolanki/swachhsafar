import { useState } from 'react';
import { useResource } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { Badge, DataState, Field, PageHeader, Panel, Stat, Table, Tabs, fmtDate, label } from '../../components/ui.jsx';
import { daysAgo, today } from '../../utils/capture.js';

const TABS = [
  { value: 'attendance', label: 'Attendance' },
  { value: 'inspections', label: 'Inspections' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'psi', label: 'PSI' },
  { value: 'complaints', label: 'Complaints' },
  { value: 'inventory', label: 'Inventory' },
];

const pct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);

function Report({ tab, q }) {
  const [audience, setAudience] = useState('passenger');
  const path = { attendance: '/reports/attendance', inspections: '/reports/inspections', feedback: `/reports/feedback/${audience}`, psi: '/reports/psi', complaints: '/reports/complaints', inventory: '/reports/inventory' }[tab];
  const res = useResource(path, tab === 'inspections' ? { ...q, coach_wise: false } : q);

  if (tab === 'attendance') return (
    <DataState res={res} empty="No attendance in this period.">
      {(rows) => <Table rowKey={(r) => r.key_id} rows={rows} columns={[
        { key: 'label', label: 'Employee' }, { key: 'journeys', label: 'Journeys' }, { key: 'records', label: 'Records' },
        ...[1, 2, 3, 4, 5].map((s) => ({ key: `s${s}`, label: `S${s}`, render: (r) => r.stages?.[s] ?? 0 })),
        { key: 'verified', label: 'Verified' }, { key: 'rejected', label: 'Rejected' },
      ]} />}
    </DataState>
  );
  if (tab === 'inspections') return (
    <DataState res={res} empty="No inspections in this period.">
      {(rows) => <Table rowKey={(r) => `${r.journey_id}${r.coach_code}`} rows={rows} columns={[
        { key: 'train_no', label: 'Train' }, { key: 'journey_date', label: 'Date', render: (r) => fmtDate(r.journey_date) },
        { key: 'progress', label: 'Done', render: (r) => `${r.done}/${r.required}` }, { key: 'completion_pct', label: 'Completion', render: (r) => pct(r.completion_pct) },
        { key: 'verified', label: 'Verified' }, { key: 'rejected', label: 'Rejected' },
      ]} />}
    </DataState>
  );
  if (tab === 'feedback') return (
    <>
      <Tabs tabs={[{ value: 'passenger', label: 'Passenger' }, { value: 'railway', label: 'Railway' }]} value={audience} onChange={setAudience} />
      <DataState res={res} isEmpty={(d) => !d.total} empty="No feedback in this period.">
        {(d) => (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2"><Badge tone="teal">Total {d.total}</Badge>{Object.entries(d.by_status).map(([k, v]) => <Badge key={k}>{label(k)}: {v}</Badge>)}</div>
            <Table rowKey={(r) => r.question_id} rows={d.questions} columns={[
              { key: 'position', label: '#' }, { key: 'text_en', label: 'Question' }, { key: 'responses', label: 'Responses' },
              { key: 'average', label: `Average (${d.scale_min}–${d.scale_max})`, render: (r) => r.average?.toFixed(2) ?? '—' },
            ]} />
          </div>
        )}
      </DataState>
    </>
  );
  if (tab === 'psi') return (
    <DataState res={res} empty="No PSI data in this period.">
      {(rows) => <Table rowKey={(r) => r.journey_id} rows={rows} columns={[
        { key: 'train_no', label: 'Train' }, { key: 'journey_date', label: 'Date', render: (r) => fmtDate(r.journey_date) },
        { key: 'responses', label: 'Responses' }, { key: 'psi', label: 'PSI', render: (r) => pct(r.psi) },
      ]} />}
    </DataState>
  );
  if (tab === 'complaints') return (
    <DataState res={res} isEmpty={(d) => !d.total} empty="No complaints in this period.">
      {(d) => (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total" value={d.total} /><Stat label="Overdue" value={d.overdue} tone="red" />
            <Stat label="Avg resolution" value={d.avg_resolution_hours != null ? `${d.avg_resolution_hours.toFixed(1)} h` : '—'} tone="slate" />
          </div>
          <div className="flex flex-wrap gap-2">{Object.entries(d.by_status).map(([k, v]) => <Badge key={k}>{label(k)}: {v}</Badge>)}</div>
          <Table rowKey={(r) => r.category_id ?? r.name} rows={d.by_category} columns={Object.keys(d.by_category[0] ?? {}).filter((k) => !k.endsWith('_id')).map((k) => ({ key: k, label: label(k) }))} />
        </div>
      )}
    </DataState>
  );
  return (
    <DataState res={res} empty="No inventory movement in this period.">
      {(rows) => <Table rowKey={(r) => r.item_id} rows={rows} columns={[
        { key: 'item_name', label: 'Item' }, { key: 'unit', label: 'Unit' }, { key: 'issued', label: 'Issued' },
        { key: 'returned', label: 'Returned' }, { key: 'consumed', label: 'Consumed' }, { key: 'journeys', label: 'Journeys' },
      ]} />}
    </DataState>
  );
}

export default function Reports() {
  const division = useDivision();
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
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <Panel><Report tab={tab} q={q} key={tab} /></Panel>
    </>
  );
}
