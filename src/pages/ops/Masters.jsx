import { useState } from 'react';
import { useResource, useSession, ROLE_NAMES } from '../../app/session.jsx';
import { DivisionPicker, useDivision } from '../../app/division.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { Badge, DataState, Dialog, ErrorNote, Field, PageHeader, Panel, Select, SubmitBar, Table, Tabs, label } from '../../components/ui.jsx';
import { PlusIcon } from '../../components/Icons.jsx';

// "B1 AC, S1, S2" -> [{code:'B1', classification:'AC'}, ...]; coaches default to Non-AC.
export function parseCoaches(text) {
  return text.split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => {
    const [code, cls] = s.split(/\s+/);
    return { code, classification: cls === 'AC' ? 'AC' : 'NON_AC' };
  });
}
const coachText = (coaches) => coaches.map((c) => `${c.code}${c.classification === 'AC' ? ' AC' : ''}`).join(', ');

function useSave(onDone) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn, ok) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      notify('success', ok);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function TrainForm({ train, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const save = useSave(onSaved);
  const [f, setF] = useState({
    train_no: train?.train_no ?? '', name: train?.name ?? '', duration_days: train?.duration_days ?? 1, operational_days: train?.operational_days ?? 2,
    inspection_rounds_per_day: train?.inspection_rounds_per_day ?? 1, before_inspection_enabled: train?.before_inspection_enabled ?? false,
    after_inspection_enabled: train?.after_inspection_enabled ?? true, daywise: train?.daywise ?? false, coaches: train ? coachText(train.coaches) : '',
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));

  function submit(e) {
    e.preventDefault();
    const { train_no, coaches, ...fields } = f;
    save.run(async () => {
      if (train) {
        await api.patch(`/trains/${train.id}`, fields);
        if (coaches !== coachText(train.coaches)) await api.put(`/trains/${train.id}/coaches`, { coaches: parseCoaches(coaches) });
      } else {
        await api.post('/trains', { ...fields, division_id: divisionId, train_no: train_no.toUpperCase(), coaches: parseCoaches(coaches) });
      }
    }, train ? 'Train updated.' : 'Train created.');
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorNote error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Train no." hint="e.g. 12951 or 12951 / 12952"><input className="input" required disabled={!!train} value={f.train_no} onChange={set('train_no')} /></Field>
        <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Duration (days)"><input type="number" min={0} max={15} className="input" value={f.duration_days} onChange={set('duration_days')} /></Field>
        <Field label="Operational days"><input type="number" min={1} max={30} className="input" value={f.operational_days} onChange={set('operational_days')} /></Field>
        <Field label="Inspection rounds / day"><input type="number" min={1} max={20} className="input" value={f.inspection_rounds_per_day} onChange={set('inspection_rounds_per_day')} /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.before_inspection_enabled} onChange={set('before_inspection_enabled')} /> Before inspection</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.after_inspection_enabled} onChange={set('after_inspection_enabled')} /> After inspection</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.daywise} onChange={set('daywise')} /> Day-wise</label>
      </div>
      <Field label="Coaches" hint="Comma separated; add AC after air-conditioned coaches, e.g. B1 AC, B2 AC, S1, S2">
        <textarea className="input h-20 py-3" required value={f.coaches} onChange={set('coaches')} />
      </Field>
      <SubmitBar busy={save.busy} label={train ? 'Save' : 'Create train'} onCancel={onClose} />
    </form>
  );
}

function Trains({ divisionId }) {
  const { can } = useSession();
  const res = useResource('/trains', { division_id: divisionId, page_size: 200 });
  const [edit, setEdit] = useState(null);
  const done = () => { setEdit(null); res.reload(); };
  return (
    <Panel title="Trains & coaches" actions={can('trains.manage') && <button type="button" className="btn-secondary" onClick={() => setEdit('new')}><PlusIcon /> Add train</button>}>
      <DataState res={res} empty="No trains configured for this division.">
        {(page) => (
          <Table rows={page.items} onRowClick={can('trains.manage') ? setEdit : undefined} columns={[
            { key: 'train_no', label: 'Train', render: (t) => <><span className="font-semibold">{t.train_no}</span><span className="block text-xs text-slate-500">{t.name}</span></> },
            { key: 'coaches', label: 'Coaches', render: (t) => <span className="text-xs">{coachText(t.coaches)}</span> },
            { key: 'rounds', label: 'Rounds/day', render: (t) => t.inspection_rounds_per_day },
            { key: 'is_active', label: 'Status', render: (t) => <Badge tone={t.is_active ? 'green' : 'slate'}>{t.is_active ? 'Active' : 'Inactive'}</Badge> },
          ]} />
        )}
      </DataState>
      <Dialog open={!!edit} title={edit === 'new' ? 'Add train' : 'Edit train'} onClose={() => setEdit(null)} wide>
        {edit && <TrainForm train={edit === 'new' ? null : edit} divisionId={divisionId} onClose={() => setEdit(null)} onSaved={done} />}
      </Dialog>
    </Panel>
  );
}

function UserForm({ divisionId, onClose, onSaved }) {
  const { api, user } = useSession();
  const save = useSave(onSaved);
  const [f, setF] = useState({ emp_id: '', name: '', email: '', mobile: '', designation: '', role_id: '5' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target?.value ?? e }));
  const roles = Object.entries(ROLE_NAMES).filter(([id]) => Number(id) > user.role_id);
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.post('/users', { ...f, role_id: Number(f.role_id), division_id: divisionId, email: f.email || null, mobile: f.mobile || null, designation: f.designation || null }), 'User created.'); }} className="space-y-3">
      <ErrorNote error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Employee ID"><input className="input" required value={f.emp_id} onChange={set('emp_id')} /></Field>
        <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Email" hint="Must match the Firebase sign-in email"><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile"><input className="input" pattern="[6-9][0-9]{9}" value={f.mobile} onChange={set('mobile')} /></Field>
        <Field label="Designation"><input className="input" value={f.designation} onChange={set('designation')} /></Field>
        <Field label="Role"><Select value={f.role_id} onChange={set('role_id')} options={roles.map(([value, l]) => ({ value, label: l }))} /></Field>
      </div>
      <SubmitBar busy={save.busy} label="Create user" onCancel={onClose} />
    </form>
  );
}

function Users({ divisionId }) {
  const { can, api } = useSession();
  const notify = useNotify();
  const [q, setQ] = useState('');
  const res = useResource('/users', { division_id: divisionId, q, page_size: 200 });
  const [creating, setCreating] = useState(false);
  async function toggle(u) {
    try {
      await api.post(`/users/${u.id}/status`, { status: u.status === 'active' ? 'inactive' : 'active' });
      res.reload();
    } catch (e) {
      notify('error', e.message);
    }
  }
  return (
    <Panel title="Users" actions={can('users.manage') && <button type="button" className="btn-secondary" onClick={() => setCreating(true)}><PlusIcon /> Add user</button>}>
      <input className="input mb-3 h-10" placeholder="Search name or employee ID" value={q} onChange={(e) => setQ(e.target.value)} />
      <DataState res={res} empty="No users found.">
        {(page) => (
          <Table rows={page.items} columns={[
            { key: 'name', label: 'Name', render: (u) => <><span className="font-medium">{u.name}</span><span className="block text-xs text-slate-500">{u.emp_id} · {u.email ?? 'no email'}</span></> },
            { key: 'role', label: 'Role', render: (u) => ROLE_NAMES[u.role_id] },
            { key: 'firebase_linked', label: 'Sign-in', render: (u) => <Badge tone={u.firebase_linked ? 'green' : 'amber'}>{u.firebase_linked ? 'Linked' : 'Not linked'}</Badge> },
            { key: 'status', label: 'Status', render: (u) => can('users.manage')
              ? <button type="button" onClick={() => toggle(u)}><Badge tone={u.status === 'active' ? 'green' : 'slate'}>{label(u.status)}</Badge></button>
              : <Badge tone={u.status === 'active' ? 'green' : 'slate'}>{label(u.status)}</Badge> },
          ]} />
        )}
      </DataState>
      <Dialog open={creating} title="Add user" onClose={() => setCreating(false)} wide>
        <UserForm divisionId={divisionId} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); res.reload(); }} />
      </Dialog>
    </Panel>
  );
}

function Divisions() {
  const { api, can } = useSession();
  const res = useResource('/divisions');
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ code: '', name: '' });
  const save = useSave(() => { setCreating(false); res.reload(); });
  return (
    <Panel title="Divisions" actions={can('divisions.manage') && <button type="button" className="btn-secondary" onClick={() => setCreating(true)}><PlusIcon /> Add division</button>}>
      <DataState res={res} empty="No divisions.">
        {(rows) => (
          <Table rows={rows} columns={[
            { key: 'code', label: 'Code', render: (d) => <span className="font-semibold">{d.code}</span> },
            { key: 'name', label: 'Name' },
            { key: 'is_active', label: 'Status', render: (d) => <Badge tone={d.is_active ? 'green' : 'slate'}>{d.is_active ? 'Active' : 'Inactive'}</Badge> },
          ]} />
        )}
      </DataState>
      <Dialog open={creating} title="Add division" onClose={() => setCreating(false)}>
        <form onSubmit={(e) => { e.preventDefault(); save.run(() => api.post('/divisions', { code: f.code.toUpperCase(), name: f.name }), 'Division created.'); }} className="space-y-3">
          <ErrorNote error={save.error} />
          <Field label="Code" hint="Uppercase letters, digits, underscore"><input className="input" required pattern="[A-Za-z0-9_]{2,16}" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Name"><input className="input" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <SubmitBar busy={save.busy} label="Create" onCancel={() => setCreating(false)} />
        </form>
      </Dialog>
    </Panel>
  );
}

export default function Masters() {
  const { can } = useSession();
  const division = useDivision();
  const tabs = [
    (can('trains.read') || can('trains.manage')) && { value: 'trains', label: 'Trains & coaches' },
    can('users.read') && { value: 'users', label: 'Users' },
    { value: 'divisions', label: 'Divisions' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0].value);
  return (
    <>
      <PageHeader title="Master data" subtitle={division.current?.name} actions={<DivisionPicker division={division} />} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'trains' && <Trains divisionId={division.divisionId} />}
      {tab === 'users' && <Users divisionId={division.divisionId} />}
      {tab === 'divisions' && <Divisions />}
    </>
  );
}
