import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { navigate } from '../../app/router.js';
import MediaPreview from '../../components/MediaPreview.jsx';
import { PhotoCapture, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, DataState, DetailList, Dialog, ErrorNote, Field, FilterBar, Loading, OfflineActionsNote, OnlineButton, PageHeader, Pager, Panel,
  STATE_TONE, Select, SubmitBar, SyncBadge, Table, Tabs, Timeline, fmtDateTime, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon, PlusIcon } from '../../components/Icons.jsx';
import { NEXT_STATUS } from '../../database/complaintRepository.js';
import { canAct } from '../../services/authorization.js';
import { ONLINE_ONLY } from '../../services/operations.js';
import { deviceTimestamp, getPosition } from '../../utils/capture.js';

const FILTERS = [{ value: '', label: 'All' }, { value: 'created', label: 'New' }, { value: 'in_process', label: 'In process' }, { value: 'forwarded', label: 'Forwarded' }, { value: 'completed', label: 'Completed' }];

function NewComplaint({ divisionId, onClose, onSaved }) {
  const { queue, can } = useSession();
  const notify = useNotify();
  const categories = useResource('/complaints/categories', { division_id: divisionId });
  const journeys = useResource('/journeys', { state: 'active', division_id: divisionId, mine: !can('journeys.read_all'), page_size: 100 });
  const [form, setForm] = useState({ category_id: '', subcategory_id: '', journey_id: '', coach_code: '', description: '' });
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const cats = (categories.data ?? []).filter((c) => c.is_active);
  const subs = cats.filter((c) => c.parent_id === form.category_id);
  const journey = journeys.data?.items.find((j) => j.id === form.journey_id);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const gps = await getPosition({ timeout: 8000 }).catch(() => null);
    const mediaId = photo ? crypto.randomUUID() : null;
    const outcome = await queue.submit({
      type: 'complaint.create',
      payload: {
        id: crypto.randomUUID(), division_id: divisionId, category_id: form.category_id, subcategory_id: form.subcategory_id || null,
        journey_id: form.journey_id || null, coach_code: form.coach_code || null, description: form.description,
        latitude: gps?.latitude ?? null, longitude: gps?.longitude ?? null, device_timestamp: deviceTimestamp(),
        attachment_ids: mediaId ? [mediaId] : [],
      },
      media: photo ? [{ id: mediaId, division_id: divisionId, kind: 'complaint_attachment', dataUrl: photo }] : [],
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Complaint');
    if (savedLocally(outcome)) onSaved();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote error={categories.error} />
      <Field label="Category">
        <Select value={form.category_id} required placeholder={categories.loading ? 'Loading…' : cats.length ? 'Select category' : 'No categories configured'}
          onChange={(v) => set({ category_id: v, subcategory_id: '' })} options={cats.filter((c) => !c.parent_id).map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      {subs.length > 0 && <Field label="Sub-category"><Select value={form.subcategory_id} placeholder="—" onChange={(v) => set({ subcategory_id: v })} options={subs.map((c) => ({ value: c.id, label: c.name }))} /></Field>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Journey (optional)">
          <Select value={form.journey_id} placeholder="None" onChange={(v) => set({ journey_id: v, coach_code: '' })} options={(journeys.data?.items ?? []).map((j) => ({ value: j.id, label: j.train_no }))} />
        </Field>
        <Field label="Coach">
          <Select value={form.coach_code} placeholder="—" onChange={(v) => set({ coach_code: v })} options={(journey?.coaches ?? []).map((c) => ({ value: c.code, label: c.code }))} disabled={!journey} />
        </Field>
      </div>
      <Field label="Description"><textarea className="input h-28 py-3" required minLength={5} maxLength={4000} value={form.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <PhotoCapture value={photo} onChange={setPhoto} />
      <SubmitBar busy={busy} label="Raise complaint" onCancel={onClose} />
    </form>
  );
}

function ComplaintDetail({ id }) {
  const { ops, canIn, me } = useSession();
  const notify = useNotify();
  const res = useResource(`/complaints/${id}`);
  const c = res.data;
  const canManage = !!c && canAct(me, 'complaint.transition', c);
  const categories = useResource(c ? '/complaints/categories' : null, { division_id: c?.division_id });
  const departments = useResource(c ? '/complaints/departments' : null, { division_id: c?.division_id });
  const users = useResource(c && canIn('users.read', c.division_id) ? '/users' : null, { division_id: c?.division_id, status: 'active', page_size: 200 });
  const [to, setTo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [dept, setDept] = useState('');
  const [forward, setForward] = useState('');
  const [busy, setBusy] = useState(false);

  if (res.loading && !c) return <Loading />;
  if (!c) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const nameOf = (list, x) => (x ? (list.data?.items ?? list.data ?? []).find((v) => v.id === x)?.name ?? null : null);
  const person = (x) => nameOf(users, x) ?? (x === me.user.id ? me.user.name : x ? 'Another user' : null);
  // backend _can_receive: the receiver's role must hold complaints.manage (by default Admin and Manager);
  // the server checks the actual grant.
  const managers = (users.data?.items ?? []).filter((u) => u.role_id === 2 || u.role_id === 3);

  async function transition(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await ops.complaints.transition(id, { to, remarks, departmentId: dept, forwardTo: forward });
      notify('success', `Complaint moved to ${label(to)}.`);
      setTo('');
      setRemarks('');
      res.reload();
    } catch (err) {
      notify('error', err.message);
    } finally {
      setBusy(false);
    }
  }

  const history = c.history.map((h) => ({
    id: h.id,
    title: h.from_status ? `${label(h.from_status)} → ${label(h.to_status)}` : label(h.to_status),
    at: h.created_at,
    body: [h.remarks, h.department_id && `Department: ${nameOf(departments, h.department_id) ?? 'updated'}`,
      h.forwarded_to_id && `Forwarded to ${person(h.forwarded_to_id)}`, h.actor_id && `By ${person(h.actor_id)}`].filter(Boolean).join(' · '),
  }));

  return (
    <>
      <PageHeader back={<a href="#/complaints" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Complaints</a>}
        title={c.complaint_no ? `Complaint ${c.complaint_no}` : 'Complaint (number pending)'}
        subtitle={`Raised ${fmtDateTime(c.server_timestamp)} · due ${fmtDateTime(c.due_at)}${c.due_at_provisional ? ' (provisional)' : ''}`} />
      {c.sync_status === 'pending' && (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          Saved on this device, waiting to sync. The complaint number and status changes are available once the server has it.
        </p>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={STATE_TONE[c.status]}>{label(c.status)}</Badge>
        {c.is_overdue && <Badge tone="red">Overdue</Badge>}
        {c.coach_code && <Badge>Coach {c.coach_code}</Badge>}
        <Badge>SLA {c.sla_hours} h</Badge>
        <SyncBadge status={c.sync_status} error={c.last_sync_error} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Details">
          <DetailList items={[
            ['Category', nameOf(categories, c.category_id)],
            c.subcategory_id && ['Sub-category', nameOf(categories, c.subcategory_id)],
            ['Department', nameOf(departments, c.department_id)],
            ['Assigned to', person(c.assigned_to_id)],
            ['Raised by', person(c.created_by_id)],
            ['Location', c.latitude != null ? `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}` : null],
            c.closed_at && ['Closed', fmtDateTime(c.closed_at)],
          ]} />
          <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">{c.description}</p>
          {c.resolution_remarks && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Resolution: {c.resolution_remarks}</p>}
        </Panel>
        <Panel title="Status history">
          <Timeline items={history} />
        </Panel>
        {c.attachment_ids.length > 0 && (
          <Panel title={`Attachments (${c.attachment_ids.length})`}>
            <div className="grid gap-3 sm:grid-cols-2">
              {c.attachment_ids.map((m, i) => <MediaPreview key={m} id={m} label={`Attachment ${i + 1}`} />)}
            </div>
          </Panel>
        )}
      </div>
      {canManage && c.sync_status !== 'pending' && NEXT_STATUS[c.status].length > 0 && (
        <Panel title="Update status" className="mt-4">
          <OfflineActionsNote reason={ONLINE_ONLY.complaint} />
          <form onSubmit={transition} className="grid gap-3 sm:grid-cols-2">
            <Field label="Move to"><Select value={to} onChange={setTo} required placeholder="Select" options={NEXT_STATUS[c.status].map((s) => ({ value: s, label: label(s) }))} /></Field>
            <Field label="Department"><Select value={dept} onChange={setDept} placeholder="Unchanged" options={(departments.data ?? []).filter((d) => d.is_active).map((d) => ({ value: d.id, label: d.name }))} /></Field>
            {to === 'forwarded' && (
              <Field label="Forward to" error={users.error?.message}><Select value={forward} onChange={setForward} required placeholder="Select manager" options={managers.map((u) => ({ value: u.id, label: u.name }))} /></Field>
            )}
            <div className="sm:col-span-2"><Field label={to === 'completed' ? 'Resolution remarks (required)' : 'Remarks'}><textarea className="input h-20 py-3" required={to === 'completed'} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>
            <div className="sm:col-span-2 flex justify-end"><OnlineButton type="submit" className="btn-primary" disabled={busy}>Update</OnlineButton></div>
          </form>
        </Panel>
      )}
    </>
  );
}

function ComplaintList() {
  const { canIn } = useSession();
  const division = useDivision();
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState('');
  const [mine, setMine] = useState(false);
  const [pageNo, setPageNo] = useState(1);
  const [creating, setCreating] = useState(false);
  const res = useResource('/complaints', {
    status, overdue, assigned_to_me: mine || undefined, division_id: division.divisionId, page: pageNo, page_size: 50,
  });
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };
  return (
    <>
      <PageHeader title="Complaints" subtitle="Raise and track complaints against SLA"
        actions={(
          <>
            <DivisionPicker division={division} />
            {canIn('complaints.create', division.divisionId) && <button type="button" className="btn-primary h-10 text-sm" onClick={() => setCreating(true)}><PlusIcon /> New complaint</button>}
          </>
        )} />
      <Tabs tabs={FILTERS} value={status} onChange={filter(setStatus)} />
      <Panel>
        <FilterBar>
          <Field label="SLA"><Select value={overdue} onChange={filter(setOverdue)} placeholder="Any" options={[{ value: 'true', label: 'Overdue' }, { value: 'false', label: 'Within SLA' }]} /></Field>
          <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => filter(setMine)(e.target.checked)} /> Assigned to me</label>
        </FilterBar>
        <DataState res={res} empty="No complaints found.">
          {(page) => (
            <>
              <Table rows={page.items} onRowClick={(c) => navigate(`/complaints/${c.id}`)} columns={[
                { key: 'complaint_no', label: 'No.', render: (c) => (c.complaint_no ? <span className="font-semibold">{c.complaint_no}</span> : <Badge tone="amber">Not synced</Badge>) },
                { key: 'description', label: 'Description', render: (c) => <span className="line-clamp-2 max-w-xs">{c.description}</span> },
                { key: 'coach_code', label: 'Coach', render: (c) => c.coach_code ?? '—' },
                { key: 'due', label: 'Due', render: (c) => <span className={c.is_overdue ? 'font-medium text-red-600' : ''}>{fmtDateTime(c.due_at)}</span> },
                { key: 'status', label: 'Status', render: (c) => <Badge tone={STATE_TONE[c.status]}>{label(c.status)}</Badge> },
              ]} />
              <Pager data={page} onPage={setPageNo} />
            </>
          )}
        </DataState>
      </Panel>
      <Dialog open={creating} title="New complaint" onClose={() => setCreating(false)} wide>
        <NewComplaint divisionId={division.divisionId} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); res.reload(); }} />
      </Dialog>
    </>
  );
}

export default function Complaints({ parts }) {
  return parts[0] ? <ComplaintDetail id={parts[0]} key={parts[0]} /> : <ComplaintList />;
}
