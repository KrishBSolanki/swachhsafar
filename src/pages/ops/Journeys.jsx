import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { navigate } from '../../app/router.js';
import { useNotify } from '../../app/Layout.jsx';
import {
  Badge, DataState, Dialog, ErrorNote, Field, Loading, PageHeader, Panel, STATE_TONE, Select, Stat, SubmitBar, Table, Tabs,
  fmtDate, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon, PlusIcon } from '../../components/Icons.jsx';

const TABS = [
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'history', label: 'History' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Users of a division with the given role, for supervisor/staff pickers (needs users.read).
function useUsers(divisionId, roleId) {
  const { can } = useSession();
  return useResource(can('users.read') && divisionId ? '/users' : null, { division_id: divisionId, role_id: roleId, status: 'active', page_size: 200 });
}

function JourneyForm({ journey, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const editing = !!journey;
  const trains = useResource(editing ? null : '/trains', { division_id: divisionId, active: true, page_size: 200 });
  const supervisors = useUsers(divisionId, 4);
  const staff = useUsers(divisionId, 5);
  const [form, setForm] = useState(() => ({
    train_id: journey?.train_id ?? '',
    journey_date: journey?.journey_date ?? '',
    start_time: journey?.start_time?.slice(0, 5) ?? '',
    end_time: journey?.end_time?.slice(0, 5) ?? '',
    linked_journey_date: journey?.linked_journey_date ?? '',
    end_date: journey?.end_date ?? '',
    supervisor_id: journey?.supervisor_id ?? '',
    staff_ids: [],
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const opt = (v) => v || undefined;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const times = { start_time: opt(form.start_time), end_time: opt(form.end_time) };
      const saved = editing
        ? await api.patch(`/journeys/${journey.id}`, {
          version: journey.version, journey_date: form.journey_date, ...times,
          linked_journey_date: opt(form.linked_journey_date), end_date: opt(form.end_date),
        })
        : await api.post('/journeys', {
          division_id: divisionId, train_id: form.train_id, journey_date: form.journey_date, ...times,
          linked_journey_date: opt(form.linked_journey_date), end_date: opt(form.end_date),
          supervisor_id: form.supervisor_id, staff_ids: form.staff_ids,
        });
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const userOpts = (res) => (res.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.emp_id})` }));

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote error={error} />
      {!editing && (
        <Field label="Train" error={trains.error?.message}>
          <Select value={form.train_id} onChange={set('train_id')} required placeholder={trains.loading ? 'Loading…' : 'Select train'}
            options={(trains.data?.items ?? []).map((t) => ({ value: t.id, label: `${t.train_no} · ${t.name}` }))} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Journey date"><input type="date" className="input" required value={form.journey_date} onChange={(e) => set('journey_date')(e.target.value)} /></Field>
        <Field label="Return date" hint="Default: from train duration"><input type="date" className="input" value={form.linked_journey_date} onChange={(e) => set('linked_journey_date')(e.target.value)} /></Field>
        <Field label="Start time"><input type="time" className="input" value={form.start_time} onChange={(e) => set('start_time')(e.target.value)} /></Field>
        <Field label="End time"><input type="time" className="input" value={form.end_time} onChange={(e) => set('end_time')(e.target.value)} /></Field>
        <Field label="End date" hint="Default: from train duration"><input type="date" className="input" value={form.end_date} onChange={(e) => set('end_date')(e.target.value)} /></Field>
      </div>
      {!editing && (
        <>
          <Field label="Supervisor" error={supervisors.error?.message}>
            <Select value={form.supervisor_id} onChange={set('supervisor_id')} required placeholder="Select supervisor" options={userOpts(supervisors)} />
          </Field>
          <Field label="Staff" hint="Janitors allocated to this journey (can be changed later)">
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-2xl p-2 ring-1 ring-slate-200">
              {userOpts(staff).length === 0 && <p className="p-2 text-sm text-slate-500">{staff.loading ? 'Loading…' : 'No active janitors in this division.'}</p>}
              {userOpts(staff).map((o) => (
                <label key={o.value} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={form.staff_ids.includes(o.value)}
                    onChange={(e) => set('staff_ids')(e.target.checked ? [...form.staff_ids, o.value] : form.staff_ids.filter((x) => x !== o.value))} />
                  {o.label}
                </label>
              ))}
            </div>
          </Field>
        </>
      )}
      <SubmitBar busy={busy} label={editing ? 'Save changes' : 'Create journey'} onCancel={onClose} />
    </form>
  );
}

function StaffPanel({ journey, onChanged }) {
  const { api, can } = useSession();
  const notify = useNotify();
  const candidates = useUsers(can('staff.manage') ? journey.division_id : null, 5);
  const [pick, setPick] = useState('');
  const active = journey.staff.filter((s) => !s.removed_at);
  const available = (candidates.data?.items ?? []).filter((u) => !active.some((s) => s.user_id === u.id));
  const editable = can('staff.manage') && ['scheduled', 'active'].includes(journey.state);

  async function run(fn, ok) {
    try {
      await fn();
      notify('success', ok);
      onChanged();
    } catch (e) {
      notify('error', e.message);
    }
  }

  return (
    <Panel title={`Staff allocation (${active.length})`}>
      {active.length === 0 ? <p className="text-sm text-slate-500">No staff allocated.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {active.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <span>{s.name} <span className="text-slate-500">· {s.emp_id}</span></span>
              {editable && <button type="button" className="text-xs font-semibold text-red-600" onClick={() => run(() => api.del(`/staff-allocation/${journey.id}/${s.user_id}`), 'Staff removed.')}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="mt-3 flex gap-2">
          <Select value={pick} onChange={setPick} placeholder="Add staff member…" options={available.map((u) => ({ value: u.id, label: `${u.name} (${u.emp_id})` }))} />
          <button type="button" className="btn-primary h-12 shrink-0" disabled={!pick}
            onClick={() => run(() => api.post(`/staff-allocation/${journey.id}`, { user_ids: [pick] }), 'Staff allocated.').then(() => setPick(''))}>Add</button>
        </div>
      )}
    </Panel>
  );
}

function JourneyDetail({ id }) {
  const { api, can } = useSession();
  const notify = useNotify();
  const res = useResource(`/journeys/${id}`);
  const summary = useResource(`/journeys/${id}/summary`);
  const [dialog, setDialog] = useState(null);
  const [reason, setReason] = useState('');
  const [supervisor, setSupervisor] = useState('');
  const supervisors = useUsers(dialog === 'supervisor' ? res.data?.division_id : null, 4);

  if (res.loading && !res.data) return <Loading />;
  if (!res.data) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const j = res.data;
  const s = summary.data;
  const manage = can('journeys.manage') && j.state !== 'cancelled' && j.state !== 'history';
  const refresh = () => {
    res.reload();
    summary.reload();
  };

  async function act(fn, ok) {
    try {
      await fn();
      notify('success', ok);
      setDialog(null);
      refresh();
    } catch (e) {
      notify('error', e.message);
    }
  }

  return (
    <>
      <PageHeader
        back={<a href="#/journeys" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Journeys</a>}
        title={`${j.train_no} · ${j.train_name}`}
        subtitle={`${fmtDate(j.journey_date)} → ${fmtDate(j.end_date)} · Return ${j.linked_train_no ?? ''} ${fmtDate(j.linked_journey_date)}`}
        actions={manage && (
          <>
            <button type="button" className="btn-secondary" onClick={() => setDialog('edit')}>Edit</button>
            <button type="button" className="btn-secondary" onClick={() => setDialog('supervisor')}>Change supervisor</button>
            <button type="button" className="btn-secondary text-red-700" onClick={() => setDialog('cancel')}>Cancel journey</button>
          </>
        )}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={STATE_TONE[j.state]}>{label(j.state)}</Badge>
        <Badge>Supervisor: {j.supervisor_name}</Badge>
        <Badge>{j.coaches.length} coaches</Badge>
        <Badge>{j.inspection_rounds_per_day} round(s)/day</Badge>
        {j.cancel_reason && <Badge tone="red">Cancelled: {j.cancel_reason}</Badge>}
      </div>
      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Staff fully attended" value={`${s.staff_fully_attended}/${s.staff_allocated}`} />
          <Stat label="Inspections" value={`${s.inspections_done}/${s.inspections_required}`} hint={s.inspection_completion_pct != null ? `${s.inspection_completion_pct.toFixed(0)}% complete` : undefined} />
          <Stat label="Passenger feedback" value={s.passenger_feedback_completed} hint={`${s.passenger_feedback_pending} pending`} tone="slate" />
          <Stat label="Complaints open" value={s.complaints_open} hint={`${s.complaints_overdue} overdue`} tone={s.complaints_overdue ? 'red' : 'teal'} />
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {can('attendance.submit') || can('attendance.read') ? <a className="btn-secondary" href={`#/attendance/${j.id}`}>Attendance</a> : null}
        {can('inspections.submit') || can('inspections.read') ? <a className="btn-secondary" href={`#/inspections/${j.id}`}>Coach inspection</a> : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StaffPanel journey={j} onChanged={refresh} />
        <Panel title="Coaches">
          <div className="flex flex-wrap gap-2">
            {j.coaches.map((c) => <Badge key={c.code} tone={c.classification === 'AC' ? 'teal' : 'slate'}>{c.code} · {c.classification === 'AC' ? 'AC' : 'Non-AC'}</Badge>)}
          </div>
        </Panel>
      </div>

      <Dialog open={dialog === 'edit'} title="Edit journey" onClose={() => setDialog(null)} wide>
        <JourneyForm journey={j} divisionId={j.division_id} onClose={() => setDialog(null)} onSaved={() => { notify('success', 'Journey updated.'); setDialog(null); refresh(); }} />
      </Dialog>
      <Dialog open={dialog === 'cancel'} title="Cancel journey" onClose={() => setDialog(null)}>
        <form onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/journeys/${j.id}/cancel`, { version: j.version, reason }), 'Journey cancelled.'); }}>
          <Field label="Reason"><textarea className="input h-24 py-3" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <SubmitBar label="Cancel journey" onCancel={() => setDialog(null)} />
        </form>
      </Dialog>
      <Dialog open={dialog === 'supervisor'} title="Change supervisor" onClose={() => setDialog(null)}>
        <form onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/journeys/${j.id}/supervisor`, { version: j.version, supervisor_id: supervisor }), 'Supervisor assigned.'); }}>
          <Field label="Supervisor" error={supervisors.error?.message}>
            <Select value={supervisor} onChange={setSupervisor} required placeholder="Select supervisor"
              options={(supervisors.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.emp_id})` }))} />
          </Field>
          <SubmitBar label="Assign" onCancel={() => setDialog(null)} />
        </form>
      </Dialog>
    </>
  );
}

function JourneyList() {
  const { can } = useSession();
  const notify = useNotify();
  const division = useDivision();
  const [tab, setTab] = useState('active');
  const [creating, setCreating] = useState(false);
  const res = useResource('/journeys', { state: tab, division_id: division.divisionId, page_size: 100 });
  return (
    <>
      <PageHeader title="Journeys" subtitle="Train journeys, supervisors and staff allocation"
        actions={(
          <>
            <DivisionPicker division={division} />
            {can('journeys.manage') && <button type="button" className="btn-primary h-10 text-sm" onClick={() => setCreating(true)}><PlusIcon /> New journey</button>}
          </>
        )} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <Panel>
        <DataState res={res} empty={`No ${tab} journeys.`}>
          {(page) => (
            <Table rows={page.items} onRowClick={(j) => navigate(`/journeys/${j.id}`)} columns={[
              { key: 'train', label: 'Train', render: (j) => <><span className="font-semibold">{j.train_no}</span><span className="block text-xs text-slate-500">{j.train_name}</span></> },
              { key: 'dates', label: 'Dates', render: (j) => `${fmtDate(j.journey_date)} → ${fmtDate(j.end_date)}` },
              { key: 'supervisor_name', label: 'Supervisor' },
              { key: 'coaches', label: 'Coaches', render: (j) => j.coaches.length },
              { key: 'state', label: 'State', render: (j) => <Badge tone={STATE_TONE[j.state]}>{label(j.state)}</Badge> },
            ]} />
          )}
        </DataState>
      </Panel>
      <Dialog open={creating} title="New journey" onClose={() => setCreating(false)} wide>
        <JourneyForm divisionId={division.divisionId} onClose={() => setCreating(false)}
          onSaved={(j) => { notify('success', 'Journey created.'); setCreating(false); navigate(`/journeys/${j.id}`); }} />
      </Dialog>
    </>
  );
}

export default function Journeys({ parts }) {
  return parts[0] ? <JourneyDetail id={parts[0]} key={parts[0]} /> : <JourneyList />;
}
