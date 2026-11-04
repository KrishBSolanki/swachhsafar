import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import MediaPreview from '../../components/MediaPreview.jsx';
import ReviewPanel from '../../components/ReviewPanel.jsx';
import { GpsCapture, PhotoCapture, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, DataState, DetailList, Dialog, Empty, Field, FilterBar, Loading, PageHeader, Pager, Panel, STATE_TONE, Segmented, Select, SubmitBar, SyncBadge,
  SyncState, Table, Tabs, fmtDateTime, label,
} from '../../components/ui.jsx';
import { CheckIcon, ChevronLeftIcon } from '../../components/Icons.jsx';
import { canAct } from '../../services/authorization.js';
import { deviceTimestamp } from '../../utils/capture.js';

export const STAGES = ['Source', 'Enroute 1', 'Destination', 'Enroute 2', 'End'];

const CELL = {
  taken: 'bg-emerald-600 text-white',
  pending: 'bg-amber-400 text-slate-900',
  next: 'bg-white text-teal-800 ring-2 ring-teal-600 hover:bg-teal-50',
  locked: 'bg-slate-100 text-slate-400',
};

const VERIFICATION = [{ value: 'pending', label: 'Pending review' }, { value: 'verified', label: 'Verified' }, { value: 'rejected', label: 'Rejected' }];
const gpsText = (r) => (r.latitude != null ? `${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}${r.gps_accuracy_m != null ? ` ±${Math.round(r.gps_accuracy_m)} m` : ''}` : null);

function CaptureDialog({ target, journey, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const [gps, setGps] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const mediaId = photo ? crypto.randomUUID() : null;
    const outcome = await queue.submit({
      type: 'attendance.create',
      payload: {
        id: crypto.randomUUID(), journey_id: journey.id, employee_id: target.staff.employee_id, stage: target.stage,
        device_timestamp: deviceTimestamp(), ...gps, photo_media_id: mediaId,
      },
      media: photo ? [{ id: mediaId, division_id: journey.division_id, kind: 'attendance_photo', dataUrl: photo }] : [],
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Attendance');
    onDone(outcome);
  }

  return (
    <Dialog open title={`${target.staff.name} · ${STAGES[target.stage - 1]}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <GpsCapture value={gps} onChange={setGps} />
        <PhotoCapture value={photo} onChange={setPhoto} required />
        <SubmitBar busy={busy} disabled={!gps || !photo} label="Mark attendance" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

// Group attendance: one stage for several staff with one GPS fix and capture time. As on the server
// (backend attendance.create_group), it is one attendance record per member sharing a
// group_submission_id, and each member succeeds or fails independently. Each record is an ordinary
// 'attendance.create' operation, so the whole group works offline and is delivered exactly once.
function GroupDialog({ journey, rows, local, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const policy = useResource(`/divisions/${journey.division_id}/policy`);
  // Photo required unless the division policy relaxes it (the strict default while it is loading).
  const photoRequired = policy.data?.attendance_photo_required !== false;
  const eligible = (stage) => rows.filter((s) => s.stages.some((c) => c.stage === stage && c.status === 'next') && !local[`${s.employee_id}:${stage}`]);
  const stages = STAGES.map((name, i) => ({ value: i + 1, label: name })).filter((o) => eligible(o.value).length);
  const [stage, setStage] = useState(stages[0]?.value ?? null);
  const [picked, setPicked] = useState({});
  const [photos, setPhotos] = useState({});
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);
  const members = stage ? eligible(stage) : [];
  const chosen = members.filter((m) => picked[m.employee_id]);
  const ready = gps && chosen.length && (!photoRequired || chosen.every((m) => photos[m.employee_id]));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const group = crypto.randomUUID();
    const at = deviceTimestamp();
    const results = [];
    for (const m of chosen) {
      const photo = photos[m.employee_id];
      const mediaId = photo ? crypto.randomUUID() : null;
      const outcome = await queue.submit({
        type: 'attendance.create',
        payload: {
          id: crypto.randomUUID(), journey_id: journey.id, employee_id: m.employee_id, stage, device_timestamp: at, ...gps,
          photo_media_id: mediaId, group_submission_id: group,
        },
        media: photo ? [{ id: mediaId, division_id: journey.division_id, kind: 'attendance_photo', dataUrl: photo }] : [],
      });
      results.push({ member: m, outcome });
    }
    setBusy(false);
    const saved = results.filter((r) => savedLocally(r.outcome));
    const synced = saved.filter((r) => r.outcome.status === 'synced').length;
    const refused = results.filter((r) => !savedLocally(r.outcome));
    if (saved.length) notify(synced === saved.length ? 'success' : 'warning', synced === saved.length
      ? `Group attendance saved and synchronized for ${synced} staff.`
      : `Group attendance saved on this device for ${saved.length} staff. It will sync when the server is reachable.`);
    for (const r of refused) notify('error', `${r.member.name}: ${r.outcome.message}`);
    onDone(stage, saved.filter((r) => r.outcome.status !== 'synced').map((r) => r.member.employee_id));
  }

  return (
    <Dialog open title="Group attendance" onClose={onClose} wide>
      {!stages.length ? <Empty title="No staff are due for a stage right now." /> : (
        <form onSubmit={submit} className="space-y-3">
          <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Stage</p>
            <Segmented label="Stage" value={stage} onChange={(v) => { setStage(v); setPicked({}); }} options={stages} /></div>
          <GpsCapture value={gps} onChange={setGps} />
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase text-slate-500">Staff due for {STAGES[stage - 1]} ({chosen.length}/{members.length} selected)</p>
            <button type="button" className="btn-link text-xs" onClick={() => setPicked(Object.fromEntries(members.map((m) => [m.employee_id, true])))}>Select all</button>
          </div>
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.employee_id} className="rounded-2xl p-3 ring-1 ring-slate-200">
                <label className="flex items-center gap-3 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={!!picked[m.employee_id]} onChange={(e) => setPicked((p) => ({ ...p, [m.employee_id]: e.target.checked }))} />
                  <span className="font-medium">{m.name}</span><span className="text-slate-500">· {m.emp_id}</span>
                </label>
                {picked[m.employee_id] && (
                  <div className="mt-2"><PhotoCapture value={photos[m.employee_id]} required={photoRequired} onChange={(v) => setPhotos((p) => ({ ...p, [m.employee_id]: v }))} /></div>
                )}
              </li>
            ))}
          </ul>
          <SubmitBar busy={busy} disabled={!ready} label={chosen.length ? `Mark attendance for ${chosen.length}` : 'Mark attendance'} onCancel={onClose} />
        </form>
      )}
    </Dialog>
  );
}

// The five-stage grid of every allocated staff member (stage order and one record per stage are
// enforced by the local repository and the server).
function StageGrid({ journey: j, status }) {
  const { can } = useSession();
  const [target, setTarget] = useState(null);
  // Records captured offline aren't in the server's status yet: show them as pending locally.
  const [local, setLocal] = useState({});
  const [groupOpen, setGroupOpen] = useState(false);
  const submit = can('attendance.submit');

  return (
    <>
      <Panel title="Staff · five-stage attendance">
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-emerald-600" /> Taken</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded ring-2 ring-teal-600" /> Next</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-amber-400" /> Saved on device, not yet synced</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded bg-slate-200" /> Locked</span>
        </div>
        <DataState res={status} empty="No staff allocated to this journey.">
          {(rows) => (
            <ul className="space-y-3">
              {rows.map((s) => (
                <li key={s.employee_id} className="rounded-2xl p-3 ring-1 ring-slate-200">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold">{s.name} <span className="font-normal text-slate-500">· {s.emp_id}</span></p>
                    {s.completed && <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckIcon className="h-3.5 w-3.5" /> Complete</span>}
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {s.stages.map((c) => {
                      const pending = local[`${s.employee_id}:${c.stage}`] || c.status === 'pending';
                      const cls = pending ? 'bg-amber-400 text-slate-900' : CELL[c.status];
                      const clickable = submit && c.status === 'next' && !pending && j;
                      return (
                        <button key={c.stage} type="button" disabled={!clickable} onClick={() => setTarget({ staff: s, stage: c.stage })}
                          className={`rounded-xl px-1 py-2 text-[11px] font-semibold leading-tight transition sm:text-xs ${cls}`}
                          aria-label={`${s.name} stage ${c.stage} ${pending ? 'pending sync' : c.status}`}>
                          {STAGES[c.stage - 1]}
                        </button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </Panel>
      {submit && j && (status.data ?? []).length > 1 && (
        <button type="button" className="btn-secondary mt-3" onClick={() => setGroupOpen(true)}>Group attendance</button>
      )}
      {groupOpen && j && (
        <GroupDialog journey={j} rows={status.data ?? []} local={local} onClose={() => setGroupOpen(false)}
          onDone={(stage, pendingIds) => {
            setLocal((l) => ({ ...l, ...Object.fromEntries(pendingIds.map((id) => [`${id}:${stage}`, true])) }));
            setGroupOpen(false);
            status.reload();
          }} />
      )}
      {target && j && (
        <CaptureDialog target={target} journey={j} onClose={() => setTarget(null)}
          onDone={(outcome) => {
            if (savedLocally(outcome) && outcome.status !== 'synced') setLocal((l) => ({ ...l, [`${target.staff.employee_id}:${target.stage}`]: true }));
            setTarget(null);
            status.reload();
          }} />
      )}
    </>
  );
}

function AttendanceDetail({ record, staffName, onClose, onChanged }) {
  const { me, ops } = useSession();
  return (
    <Dialog open title={`${staffName(record.employee_id)} · ${STAGES[record.stage - 1]}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><SyncBadge status={record.sync_status} error={record.last_sync_error} />
          {record.verification_status && <Badge tone={STATE_TONE[record.verification_status]}>{label(record.verification_status)}</Badge>}</div>
        {record.origin === 'server' && !record.device_timestamp && (
          <p className="text-xs text-slate-500">Recorded on the server; its details are shown when online.</p>
        )}
        <DetailList items={[
          ['Stage', `${record.stage} · ${STAGES[record.stage - 1]}`],
          ['Captured (device)', record.device_timestamp ? fmtDateTime(record.device_timestamp) : null],
          ['Received (server)', record.server_timestamp ? fmtDateTime(record.server_timestamp) : null],
          ['GPS', gpsText(record)],
          ['Recorded by', record.created_by_id ? staffName(record.created_by_id) : null],
          ['Review remarks', record.review_remarks],
        ]} />
        {record.photo_media_id && <MediaPreview id={record.photo_media_id} label="Attendance photo" />}
        <ReviewPanel record={record} allowed={canAct(me, 'attendance.review', record)}
          onReview={(status, remarks) => ops.attendance.review(record.id, status, remarks)} onDone={onChanged} />
      </div>
    </Dialog>
  );
}

// Journey-wise and staff-wise attendance records (GET /attendance), with evidence and review.
function AttendanceRecords({ journey: j }) {
  const [employee, setEmployee] = useState('');
  const [stage, setStage] = useState('');
  const [verification, setVerification] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [open, setOpen] = useState(null);
  const res = useResource('/attendance', {
    journey_id: j.id, employee_id: employee, stage, verification_status: verification, page: pageNo, page_size: 50,
  });
  const people = [{ user_id: j.supervisor_id, name: j.supervisor_name }, ...j.staff];
  const staffName = (id) => people.find((s) => s.user_id === id)?.name ?? 'Unknown user';
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };

  return (
    <Panel title="Attendance records">
      <FilterBar>
        <Field label="Staff"><Select value={employee} onChange={filter(setEmployee)} placeholder="All staff" options={j.staff.filter((s) => !s.removed_at).map((s) => ({ value: s.user_id, label: s.name }))} /></Field>
        <Field label="Stage"><Select value={stage} onChange={filter(setStage)} placeholder="All stages" options={STAGES.map((n, i) => ({ value: String(i + 1), label: `${i + 1} · ${n}` }))} /></Field>
        <Field label="Verification"><Select value={verification} onChange={filter(setVerification)} placeholder="Any" options={VERIFICATION} /></Field>
      </FilterBar>
      <DataState res={res} empty="No attendance records match.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={setOpen} columns={[
              { key: 'employee', label: 'Staff', render: (r) => staffName(r.employee_id) },
              { key: 'stage', label: 'Stage', render: (r) => STAGES[r.stage - 1] },
              { key: 'when', label: 'Captured', render: (r) => fmtDateTime(r.device_timestamp ?? r.server_timestamp) },
              { key: 'gps', label: 'GPS', render: (r) => (r.latitude != null ? 'Yes' : '—') },
              { key: 'status', label: 'Sync', render: (r) => <SyncState record={r} /> },
              { key: 'verification', label: 'Verification', render: (r) => (r.verification_status ? <Badge tone={STATE_TONE[r.verification_status]}>{label(r.verification_status)}</Badge> : '—') },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
      {open && <AttendanceDetail record={open} staffName={staffName} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); }} />}
    </Panel>
  );
}

function JourneyAttendance({ id }) {
  const { can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const status = useResource(`/attendance/journeys/${id}/status`);
  const [tab, setTab] = useState('stages');

  if (journey.loading && !journey.data) return <Loading />;
  const j = journey.data;
  const tabs = [{ value: 'stages', label: 'Stages' }, ...(can('attendance.read') && j ? [{ value: 'records', label: 'Records' }] : [])];

  return (
    <>
      <PageHeader back={<a href="#/attendance" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Journeys</a>}
        title="Attendance" subtitle={j ? `${j.train_no} · ${j.train_name}` : undefined} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'records' && j ? <AttendanceRecords journey={j} /> : <StageGrid journey={j} status={status} />}
    </>
  );
}

export default function Attendance({ parts }) {
  if (parts[0]) return <JourneyAttendance id={parts[0]} key={parts[0]} />;
  return (
    <>
      <PageHeader title="Attendance" subtitle="GPS and photo verified staff attendance" />
      <JourneyPicker base="/attendance" />
    </>
  );
}
