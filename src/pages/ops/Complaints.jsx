import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { navigate } from '../../app/router.js';
import { PhotoCapture, outcomeToast } from '../../components/Capture.jsx';
import {
  Badge, DataState, Dialog, ErrorNote, Field, Loading, PageHeader, Panel, STATE_TONE, Select, SubmitBar, Table, Tabs,
  fmtDateTime, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon, PlusIcon } from '../../components/Icons.jsx';
import { deviceTimestamp, getPosition } from '../../utils/capture.js';

const NEXT = { created: ['in_process', 'forwarded', 'completed'], in_process: ['forwarded', 'completed'], forwarded: ['in_process', 'forwarded', 'completed'], completed: [] };
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
    if (outcome.status !== 'failed') onSaved();
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
  const { api, can } = useSession();
  const notify = useNotify();
  const res = useResource(`/complaints/${id}`);
  const c = res.data;
  const departments = useResource(c && can('complaints.manage') ? '/complaints/departments' : null, { division_id: c?.division_id });
  const managers = useResource(c && can('users.read') ? '/users' : null, { division_id: c?.division_id, role_id: 3, status: 'active', page_size: 200 });
  const [to, setTo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [dept, setDept] = useState('');
  const [forward, setForward] = useState('');
  const [busy, setBusy] = useState(false);

  if (res.loading && !c) return <Loading />;
  if (!c) return <ErrorNote error={res.error} onRetry={res.reload} />;

  async function transition(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/complaints/${id}/transition`, { to_status: to, remarks: remarks || null, department_id: dept || null, forward_to_user_id: forward || null });
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

  return (
    <>
      <PageHeader back={<a href="#/complaints" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Complaints</a>}
        title={`Complaint ${c.complaint_no}`} subtitle={`Raised ${fmtDateTime(c.server_timestamp)} · due ${fmtDateTime(c.due_at)}`} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={STATE_TONE[c.status]}>{label(c.status)}</Badge>
        {c.is_overdue && <Badge tone="red">Overdue</Badge>}
        {c.coach_code && <Badge>Coach {c.coach_code}</Badge>}
        <Badge>SLA {c.sla_hours} h</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Details">
          <p className="whitespace-pre-wrap text-sm text-slate-700">{c.description}</p>
          {c.resolution_remarks && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Resolution: {c.resolution_remarks}</p>}
        </Panel>
        <Panel title="Status history">
          <ol className="space-y-3 border-l-2 border-teal-100 pl-4">
            {c.history.map((h) => (
              <li key={h.id} className="text-sm">
                <p className="font-medium">{label(h.to_status)} <span className="text-xs font-normal text-slate-500">· {fmtDateTime(h.created_at)}</span></p>
                {h.remarks && <p className="text-slate-600">{h.remarks}</p>}
              </li>
            ))}
          </ol>
        </Panel>
      </div>
      {can('complaints.manage') && NEXT[c.status].length > 0 && (
        <Panel title="Update status" className="mt-4">
          <form onSubmit={transition} className="grid gap-3 sm:grid-cols-2">
            <Field label="Move to"><Select value={to} onChange={setTo} required placeholder="Select" options={NEXT[c.status].map((s) => ({ value: s, label: label(s) }))} /></Field>
            <Field label="Department"><Select value={dept} onChange={setDept} placeholder="Unchanged" options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))} /></Field>
            {to === 'forwarded' && (
              <Field label="Forward to" error={managers.error?.message}><Select value={forward} onChange={setForward} required placeholder="Select user" options={(managers.data?.items ?? []).map((u) => ({ value: u.id, label: u.name }))} /></Field>
            )}
            <div className="sm:col-span-2"><Field label={to === 'completed' ? 'Resolution remarks (required)' : 'Remarks'}><textarea className="input h-20 py-3" required={to === 'completed'} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>
            <div className="sm:col-span-2"><SubmitBar busy={busy} label="Update" /></div>
          </form>
        </Panel>
      )}
    </>
  );
}

function ComplaintList() {
  const { can } = useSession();
  const division = useDivision();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const res = useResource('/complaints', { status, division_id: division.divisionId, page_size: 100 });
  return (
    <>
      <PageHeader title="Complaints" subtitle="Raise and track complaints against SLA"
        actions={(
          <>
            <DivisionPicker division={division} />
            {can('complaints.create') && <button type="button" className="btn-primary h-10 text-sm" onClick={() => setCreating(true)}><PlusIcon /> New complaint</button>}
          </>
        )} />
      <Tabs tabs={FILTERS} value={status} onChange={setStatus} />
      <Panel>
        <DataState res={res} empty="No complaints found.">
          {(page) => (
            <Table rows={page.items} onRowClick={(c) => navigate(`/complaints/${c.id}`)} columns={[
              { key: 'complaint_no', label: 'No.', render: (c) => <span className="font-semibold">{c.complaint_no}</span> },
              { key: 'description', label: 'Description', render: (c) => <span className="line-clamp-2 max-w-xs">{c.description}</span> },
              { key: 'coach_code', label: 'Coach', render: (c) => c.coach_code ?? '—' },
              { key: 'due', label: 'Due', render: (c) => <span className={c.is_overdue ? 'font-medium text-red-600' : ''}>{fmtDateTime(c.due_at)}</span> },
              { key: 'status', label: 'Status', render: (c) => <Badge tone={STATE_TONE[c.status]}>{label(c.status)}</Badge> },
            ]} />
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
