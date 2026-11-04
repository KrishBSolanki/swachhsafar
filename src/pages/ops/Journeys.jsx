import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { navigate } from '../../app/router.js';
import { useNotify } from '../../app/Layout.jsx';
import {
  Badge, ConfirmDialog, DataState, Dialog, ErrorNote, Field, FilterBar, Loading, OfflineActionsNote, OnlineButton, PageHeader, Pager,
  Panel, STATE_TONE, Select, Stat, SubmitBar, Table, Tabs, Timeline, fmtDate, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon, PlusIcon } from '../../components/Icons.jsx';
import { canAct } from '../../services/authorization.js';
import { ONLINE_ONLY, isVersionConflict } from '../../services/operations.js';

const TABS = [
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'history', label: 'History' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Users of a division with the given role, for supervisor/staff pickers (needs users.read).
function useUsers(divisionId, roleId) {
  const { canIn } = useSession();
  return useResource(divisionId && canIn('users.read', divisionId) ? '/users' : null, { division_id: divisionId, role_id: roleId, status: 'active', page_size: 200 });
}

function JourneyForm({ journey, divisionId, onClose, onSaved, onConflict }) {
  const { ops } = useSession();
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
        ? await ops.journeys.update(journey, {
          journey_date: form.journey_date, ...times, linked_journey_date: opt(form.linked_journey_date), end_date: opt(form.end_date),
        })
        : await ops.journeys.create({
          division_id: divisionId, train_id: form.train_id, journey_date: form.journey_date, ...times,
          linked_journey_date: opt(form.linked_journey_date), end_date: opt(form.end_date),
          supervisor_id: form.supervisor_id, staff_ids: form.staff_ids,
        });
      onSaved(saved);
    } catch (err) {
      setError(err);
      if (isVersionConflict(err)) onConflict?.();
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
      <OfflineActionsNote reason={ONLINE_ONLY.journey} />
      <SubmitBar busy={busy} label={editing ? 'Save changes' : 'Create journey'} onCancel={onClose} />
    </form>
  );
}

function StaffPanel({ journey, onChanged }) {
  const { ops, me } = useSession();
  const notify = useNotify();
  const editable = canAct(me, 'journey.staff', journey);
  const candidates = useUsers(editable ? journey.division_id : null, 5);
  const [pick, setPick] = useState('');
  const [removing, setRemoving] = useState(null);
  const active = journey.staff.filter((s) => !s.removed_at);
  const available = (candidates.data?.items ?? []).filter((u) => !active.some((s) => s.user_id === u.id));

  async function run(fn, ok) {
    try {
      await fn();
      notify('success', ok);
      onChanged();
      return true;
    } catch (e) {
      notify('error', e.message);
      return false;
    }
  }

  return (
    <Panel title={`Staff allocation (${active.length})`}>
      {active.length === 0 ? <p className="text-sm text-slate-500">No staff allocated.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {active.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <span>{s.name} <span className="text-slate-500">· {s.emp_id}</span></span>
              {editable && <OnlineButton className="text-xs font-semibold text-red-600 disabled:opacity-40" onClick={() => setRemoving(s)}>Remove</OnlineButton>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="mt-3 flex gap-2">
          <Select value={pick} onChange={setPick} placeholder="Add staff member…" aria-label="Add staff member"
            options={available.map((u) => ({ value: u.id, label: `${u.name} (${u.emp_id})` }))} />
          <OnlineButton reason={ONLINE_ONLY.staff} className="btn-primary h-12 shrink-0" disabled={!pick}
            onClick={() => run(() => ops.journeys.addStaff(journey, [pick]), 'Staff allocated.').then((ok) => ok && setPick(''))}>Add</OnlineButton>
        </div>
      )}
      <ConfirmDialog open={!!removing} title="Remove staff member" confirmLabel="Remove" danger onClose={() => setRemoving(null)}
        onConfirm={() => run(() => ops.journeys.removeStaff(journey, removing.user_id), 'Staff removed.').then(() => setRemoving(null))}>
        <p>Remove {removing?.name} from this journey? Attendance already recorded for them is kept.</p>
      </ConfirmDialog>
    </Panel>
  );
}

const COACH_CODE = /^[A-Z0-9 ]{1,10}$/; // backend CoachCode

// Journey coach list (PATCH /journeys/{id} `coaches`, version-checked). The server refuses to remove a
// coach that already has inspections.
function CoachEditor({ journey, onClose, onSaved, onConflict }) {
  const { ops } = useSession();
  const [coaches, setCoaches] = useState(() => journey.coaches.map((c) => ({ code: c.code, classification: c.classification })));
  const [code, setCode] = useState('');
  const [cls, setCls] = useState('AC');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const clean = code.trim().toUpperCase();
  const invalid = clean && (!COACH_CODE.test(clean) ? 'Use 1–10 capital letters or digits.' : coaches.some((c) => c.code === clean) ? 'This coach is already listed.' : null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await ops.journeys.setCoaches(journey, coaches));
    } catch (e) {
      setError(e);
      if (isVersionConflict(e)) onConflict();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <ErrorNote error={error} />
      <ul className="divide-y divide-slate-100 rounded-2xl text-sm ring-1 ring-slate-200">
        {coaches.map((c, i) => (
          <li key={c.code} className="flex items-center justify-between px-3 py-2">
            <span><span className="font-semibold">{i + 1}. {c.code}</span> <span className="text-slate-500">· {c.classification === 'AC' ? 'AC' : 'Non-AC'}</span></span>
            <button type="button" className="text-xs font-semibold text-red-600" onClick={() => setCoaches((l) => l.filter((x) => x.code !== c.code))}>Remove</button>
          </li>
        ))}
        {!coaches.length && <li className="px-3 py-2 text-slate-500">No coaches.</li>}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Coach code" error={invalid || undefined}><input className="input w-32 uppercase" value={code} maxLength={10} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="Class"><Select value={cls} onChange={setCls} options={[{ value: 'AC', label: 'AC' }, { value: 'NON_AC', label: 'Non-AC' }]} /></Field>
        <button type="button" className="btn-secondary h-12" disabled={!clean || !!invalid}
          onClick={() => { setCoaches((l) => [...l, { code: clean, classification: cls }]); setCode(''); }}>Add coach</button>
      </div>
      <OfflineActionsNote reason={ONLINE_ONLY.journey} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary h-12" onClick={onClose}>Cancel</button>
        <OnlineButton className="btn-primary" disabled={busy || !coaches.length} onClick={save}>Save coaches</OnlineButton>
      </div>
    </div>
  );
}

// What the journey record itself shows happened, plus the audit trail for users with audit.read.
function JourneyTimeline({ journey }) {
  const { can } = useSession();
  const audit = useResource(can('audit.read') ? '/audit' : null, { entity_type: 'journey', entity_id: journey.id, page_size: 50 });
  const events = [
    ...journey.staff.flatMap((s) => [
      { id: `a${s.id}`, title: `${s.name} allocated`, at: s.allocated_at },
      s.removed_at && { id: `r${s.id}`, title: `${s.name} removed`, at: s.removed_at },
    ]),
    journey.cancelled_at && { id: 'cancel', title: 'Journey cancelled', at: journey.cancelled_at, body: journey.cancel_reason },
    ...(audit.data?.items ?? []).map((a) => ({ id: a.id, title: label(a.action), at: a.created_at })),
  ].filter((e) => e && e.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return (
    <Panel title="Timeline">
      <Timeline items={events} empty="No allocation or status changes recorded." />
      {!can('audit.read') && <p className="mt-3 text-xs text-slate-500">Edits and supervisor changes are listed here for users with audit access.</p>}
      {audit.stale && <p className="mt-3 text-xs text-amber-800">Audit entries are the copy last loaded online.</p>}
    </Panel>
  );
}

function JourneyDetail({ id }) {
  const { ops, canIn, me } = useSession();
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
  const manage = canAct(me, 'journey.manage', j);
  const refresh = () => {
    res.reload();
    summary.reload();
  };
  // Someone else changed the journey: load the current version; the user retries on it.
  const conflict = () => {
    notify('warning', 'This journey was changed by someone else. The latest version has been loaded — review it and try again.');
    setDialog(null);
    refresh();
  };

  async function act(fn, ok) {
    try {
      await fn();
      notify('success', ok);
      setDialog(null);
      refresh();
    } catch (e) {
      if (isVersionConflict(e)) conflict();
      else notify('error', e.message);
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
            <OnlineButton onClick={() => setDialog('edit')}>Edit</OnlineButton>
            <OnlineButton onClick={() => setDialog('coaches')}>Coaches</OnlineButton>
            <OnlineButton onClick={() => setDialog('supervisor')}>Change supervisor</OnlineButton>
            <OnlineButton className="btn-secondary text-red-700" onClick={() => setDialog('cancel')}>Cancel journey</OnlineButton>
          </>
        )}
      />
      {manage && <OfflineActionsNote reason={ONLINE_ONLY.journey} />}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={STATE_TONE[j.state]}>{label(j.state)}</Badge>
        <Badge>Supervisor: {j.supervisor_name}</Badge>
        <Badge>{j.coaches.length} coaches</Badge>
        <Badge>{j.inspection_rounds_per_day} round(s)/day</Badge>
        <Badge>Version {j.version}</Badge>
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
      {summary.stale && <p className="mb-4 text-xs text-amber-800">Counts are from records stored on this device.</p>}
      <div className="mb-4 flex flex-wrap gap-2">
        {canIn('attendance.submit', j.division_id) || canIn('attendance.read', j.division_id) ? <a className="btn-secondary" href={`#/attendance/${j.id}`}>Attendance</a> : null}
        {canIn('inspections.submit', j.division_id) || canIn('inspections.read', j.division_id) ? <a className="btn-secondary" href={`#/inspections/${j.id}`}>Coach inspection</a> : null}
        {canIn('inventory.read', j.division_id) || canIn('inventory.transact', j.division_id) ? <a className="btn-secondary" href={`#/inventory/${j.id}`}>Inventory</a> : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StaffPanel journey={j} onChanged={refresh} />
        <Panel title="Coaches">
          <div className="flex flex-wrap gap-2">
            {j.coaches.map((c) => <Badge key={c.code} tone={c.classification === 'AC' ? 'teal' : 'slate'}>{c.code} · {c.classification === 'AC' ? 'AC' : 'Non-AC'}</Badge>)}
          </div>
        </Panel>
        <JourneyTimeline journey={j} />
      </div>

      <Dialog open={dialog === 'edit'} title="Edit journey" onClose={() => setDialog(null)} wide>
        <JourneyForm journey={j} divisionId={j.division_id} onClose={() => setDialog(null)} onConflict={conflict}
          onSaved={() => { notify('success', 'Journey updated.'); setDialog(null); refresh(); }} />
      </Dialog>
      <Dialog open={dialog === 'coaches'} title="Journey coaches" onClose={() => setDialog(null)} wide>
        <CoachEditor journey={j} onClose={() => setDialog(null)} onConflict={conflict}
          onSaved={() => { notify('success', 'Coaches updated.'); setDialog(null); refresh(); }} />
      </Dialog>
      <Dialog open={dialog === 'cancel'} title="Cancel journey" onClose={() => setDialog(null)}>
        <form onSubmit={(e) => { e.preventDefault(); act(() => ops.journeys.cancel(j, reason), 'Journey cancelled.'); }}>
          <p className="mb-3 text-sm text-slate-600">A cancelled journey cannot be reopened. Records already captured are kept.</p>
          <Field label="Reason"><textarea className="input h-24 py-3" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <OfflineActionsNote reason={ONLINE_ONLY.journey} />
          <SubmitBar label="Cancel journey" onCancel={() => setDialog(null)} />
        </form>
      </Dialog>
      <Dialog open={dialog === 'supervisor'} title="Change supervisor" onClose={() => setDialog(null)}>
        <form onSubmit={(e) => { e.preventDefault(); act(() => ops.journeys.assignSupervisor(j, supervisor), 'Supervisor assigned.'); }}>
          <Field label="Supervisor" error={supervisors.error?.message}>
            <Select value={supervisor} onChange={setSupervisor} required placeholder="Select supervisor"
              options={(supervisors.data?.items ?? []).filter((u) => u.id !== j.supervisor_id).map((u) => ({ value: u.id, label: `${u.name} (${u.emp_id})` }))} />
          </Field>
          <OfflineActionsNote reason={ONLINE_ONLY.journey} />
          <SubmitBar label="Assign" onCancel={() => setDialog(null)} />
        </form>
      </Dialog>
    </>
  );
}

function JourneyList() {
  const { canIn } = useSession();
  const notify = useNotify();
  const division = useDivision();
  const [tab, setTab] = useState('active');
  const [pageNo, setPageNo] = useState(1);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const res = useResource('/journeys', { state: tab, division_id: division.divisionId, page: pageNo, page_size: 50 });
  const term = search.trim().toLowerCase();
  const matches = (j) => !term || `${j.train_no} ${j.train_name} ${j.supervisor_name}`.toLowerCase().includes(term);
  return (
    <>
      <PageHeader title="Journeys" subtitle="Train journeys, supervisors and staff allocation"
        actions={(
          <>
            <DivisionPicker division={division} />
            {canIn('journeys.manage', division.divisionId) && (
              <OnlineButton reason={ONLINE_ONLY.journey} className="btn-primary h-10 text-sm" onClick={() => setCreating(true)}><PlusIcon /> New journey</OnlineButton>
            )}
          </>
        )} />
      <Tabs tabs={TABS} value={tab} onChange={(t) => { setTab(t); setPageNo(1); }} />
      <Panel>
        <FilterBar>
          <Field label="Search this page"><input className="input h-10" type="search" placeholder="Train, name or supervisor" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        </FilterBar>
        <DataState res={res} empty={`No ${tab} journeys.`}>
          {(page) => (
            <>
              <Table rows={page.items.filter(matches)} onRowClick={(j) => navigate(`/journeys/${j.id}`)} columns={[
                { key: 'train', label: 'Train', render: (j) => <><span className="font-semibold">{j.train_no}</span><span className="block text-xs text-slate-500">{j.train_name}</span></> },
                { key: 'dates', label: 'Dates', render: (j) => `${fmtDate(j.journey_date)} → ${fmtDate(j.end_date)}` },
                { key: 'supervisor_name', label: 'Supervisor' },
                { key: 'coaches', label: 'Coaches', render: (j) => j.coaches.length },
                { key: 'state', label: 'State', render: (j) => <Badge tone={STATE_TONE[j.state]}>{label(j.state)}</Badge> },
              ]} />
              {term && !page.items.some(matches) && <p className="py-4 text-center text-sm text-slate-500">No journeys on this page match &quot;{search}&quot;.</p>}
              <Pager data={page} onPage={setPageNo} />
            </>
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
