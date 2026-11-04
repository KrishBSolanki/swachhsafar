import { useMemo, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import MediaPreview from '../../components/MediaPreview.jsx';
import ReviewPanel from '../../components/ReviewPanel.jsx';
import { GpsCapture, PhotoCapture, VideoCapture, mediaItem, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, DataState, DetailList, Dialog, Empty, ErrorNote, Field, FilterBar, Loading, PageHeader, Pager, Panel, STATE_TONE, Segmented, Select,
  StaleNote, SubmitBar, SyncBadge, SyncState, Table, Tabs, fmtDateTime, label,
} from '../../components/ui.jsx';
import { CheckIcon, ChevronLeftIcon } from '../../components/Icons.jsx';
import { canAct } from '../../services/authorization.js';
import { deviceTimestamp } from '../../utils/capture.js';

const PHASES = { B: 'Before', A: 'After' };
const CLASSES = [{ value: '', label: 'All coaches' }, { value: 'AC', label: 'AC' }, { value: 'NON_AC', label: 'Non-AC' }];
const VERIFICATION = [{ value: 'pending', label: 'Pending review' }, { value: 'verified', label: 'Verified' }, { value: 'rejected', label: 'Rejected' }];

function InspectDialog({ target, journey, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const [gps, setGps] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [video, setVideo] = useState(null);
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const mediaId = crypto.randomUUID();
    const videoId = video ? crypto.randomUUID() : null;
    const outcome = await queue.submit({
      type: 'inspection.create',
      payload: {
        id: crypto.randomUUID(), journey_id: journey.id, coach_code: target.coach, day: target.day, round: target.round,
        phase: target.phase, comments: comments.trim() || null, device_timestamp: deviceTimestamp(), ...gps, photo_media_id: mediaId, video_media_id: videoId,
      },
      media: [
        { id: mediaId, division_id: journey.division_id, kind: 'inspection_photo', dataUrl: photo },
        ...(video ? [await mediaItem(video, { id: videoId, kind: 'inspection_video', divisionId: journey.division_id })] : []),
      ],
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Inspection');
    onDone(outcome);
  }

  return (
    <Dialog open title={`Coach ${target.coach} · Day ${target.day} · Round ${target.round} · ${PHASES[target.phase]}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <GpsCapture value={gps} onChange={setGps} />
        <PhotoCapture value={photo} onChange={setPhoto} required />
        <Field label="Comments"><textarea className="input h-20 py-3" maxLength={2000} value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
        <VideoCapture value={video} onChange={setVideo} />
        <SubmitBar busy={busy} disabled={!gps || !photo} label="Submit inspection" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

// Coach × day × round × phase grid. Round and Before→After order and one record per cell are enforced
// by the local repository (and its triggers) and by the server.
function InspectionGrid({ journey: j, grid }) {
  const { can } = useSession();
  const [day, setDay] = useState(null);
  const [round, setRound] = useState(1);
  const [phase, setPhase] = useState(null);
  const [cls, setCls] = useState('');
  const [target, setTarget] = useState(null);
  const [local, setLocal] = useState({});

  const days = useMemo(() => [...new Set((grid.data ?? []).map((c) => c.day))].sort((a, b) => a - b), [grid.data]);
  const openDay = (grid.data ?? []).find((c) => c.day_open)?.day;
  const activeDay = day ?? openDay ?? days[0];
  const phases = [j.before_inspection_enabled && 'B', j.after_inspection_enabled && 'A'].filter(Boolean);
  const activePhase = phase ?? phases[0];
  const classOf = (code) => j.coaches.find((c) => c.code === code)?.classification;
  const coaches = (grid.data ?? []).filter((c) => c.day === activeDay && (!cls || classOf(c.coach_code) === cls));
  const done = coaches.reduce((n, c) => n + c.done, 0);
  const required = coaches.reduce((n, c) => n + c.required, 0);

  return (
    <>
      <StaleNote stale={grid.stale} />
      <Panel className="mb-4">
        <div className="space-y-3">
          <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Day</p>
            <Segmented label="Day" value={activeDay} onChange={setDay} options={days.map((d) => ({ value: d, label: `Day ${d}${d === openDay ? ' •' : ''}` }))} /></div>
          <div className="flex flex-wrap gap-6">
            <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Round</p>
              <Segmented label="Round" value={round} onChange={setRound} options={Array.from({ length: j.inspection_rounds_per_day }, (_, i) => ({ value: i + 1, label: `R${i + 1}` }))} /></div>
            <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Phase</p>
              <Segmented label="Phase" value={activePhase} onChange={setPhase} options={phases.map((p) => ({ value: p, label: PHASES[p] }))} /></div>
            <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Coach class</p>
              <Segmented label="Coach class" value={cls} onChange={setCls} options={CLASSES} /></div>
          </div>
          <div>
            <div className="flex justify-between text-sm"><span className="font-medium">Day {activeDay} completion{cls ? ` · ${cls === 'AC' ? 'AC' : 'Non-AC'}` : ''}</span><span className="tabular-nums text-slate-600">{done}/{required}</span></div>
            <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-teal-600" style={{ width: `${required ? (done / required) * 100 : 0}%` }} /></div>
          </div>
        </div>
      </Panel>
      {coaches.length === 0 ? <Empty title="No coaches to inspect on this day." /> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
          {coaches.map((c) => {
            const cell = c.cells.find((x) => x.round === round && x.phase === activePhase);
            const key = `${c.coach_code}:${activeDay}:${round}:${activePhase}`;
            const status = local[key] ? 'pending' : cell?.status ?? 'locked';
            const clickable = can('inspections.submit') && status === 'open';
            const tile = {
              taken: 'bg-emerald-600 text-white ring-emerald-600',
              pending: 'bg-amber-400 text-slate-900 ring-amber-400',
              open: 'bg-white text-teal-800 ring-teal-600 hover:bg-teal-50',
              locked: 'bg-slate-100 text-slate-400 ring-slate-200',
            }[status];
            return (
              <button key={c.coach_code} type="button" disabled={!clickable}
                onClick={() => setTarget({ coach: c.coach_code, day: activeDay, round, phase: activePhase, key })}
                className={`flex aspect-square flex-col items-center justify-center rounded-2xl text-sm font-bold ring-2 transition ${tile}`}
                aria-label={`Coach ${c.coach_code} ${status}`}>
                {status === 'taken' && <CheckIcon className="mb-0.5 h-4 w-4" />}
                {c.coach_code}
                <span className="text-[10px] font-medium opacity-80">{status === 'pending' ? 'Not synced' : `${c.done}/${c.required}`}</span>
                <span className="text-[9px] font-medium uppercase opacity-70">{classOf(c.coach_code) === 'AC' ? 'AC' : 'Non-AC'}</span>
              </button>
            );
          })}
        </div>
      )}
      {target && (
        <InspectDialog target={target} journey={j} onClose={() => setTarget(null)}
          onDone={(outcome) => {
            if (savedLocally(outcome) && outcome.status !== 'synced') setLocal((l) => ({ ...l, [target.key]: true }));
            setTarget(null);
            grid.reload();
          }} />
      )}
    </>
  );
}

function InspectionDetail({ record, journey, onClose, onChanged }) {
  const { me, ops } = useSession();
  const inspector = [{ user_id: journey.supervisor_id, name: journey.supervisor_name }, ...journey.staff].find((s) => s.user_id === record.created_by_id)?.name;
  return (
    <Dialog open title={`Coach ${record.coach_code} · Day ${record.day} · R${record.round} · ${PHASES[record.phase]}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><SyncBadge status={record.sync_status} error={record.last_sync_error} />
          {record.coach_class && <Badge>{record.coach_class === 'AC' ? 'AC' : 'Non-AC'}</Badge>}</div>
        {record.origin === 'server' && !record.device_timestamp && <p className="text-xs text-slate-500">Recorded on the server; its details are shown when online.</p>}
        <DetailList items={[
          ['Captured (device)', record.device_timestamp ? fmtDateTime(record.device_timestamp) : null],
          ['Received (server)', record.server_timestamp ? fmtDateTime(record.server_timestamp) : null],
          ['GPS', record.latitude != null ? `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}${record.gps_accuracy_m != null ? ` ±${Math.round(record.gps_accuracy_m)} m` : ''}` : null],
          ['Inspector', inspector ?? (record.created_by_id ? 'Other user' : null)],
          ['Comments', record.comments],
        ]} />
        <div className="grid gap-3 sm:grid-cols-2">
          {record.photo_media_id && <MediaPreview id={record.photo_media_id} label="Inspection photo" />}
          {record.video_media_id && <MediaPreview id={record.video_media_id} kind="video" label="Inspection video" />}
        </div>
        <ReviewPanel record={record} allowed={canAct(me, 'inspection.review', record)}
          onReview={(status, remarks) => ops.inspections.review(record.id, status, remarks)} onDone={onChanged} />
      </div>
    </Dialog>
  );
}

// Journey-wise and coach-wise inspection records (GET /inspections) and their review.
function InspectionRecords({ journey: j }) {
  const [coach, setCoach] = useState('');
  const [day, setDay] = useState('');
  const [phase, setPhase] = useState('');
  const [verification, setVerification] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [open, setOpen] = useState(null);
  const res = useResource('/inspections', {
    journey_id: j.id, coach_code: coach, day, phase, verification_status: verification, page: pageNo, page_size: 50,
  });
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };
  return (
    <Panel title="Inspection records">
      <FilterBar>
        <Field label="Coach"><Select value={coach} onChange={filter(setCoach)} placeholder="All coaches" options={j.coaches.map((c) => ({ value: c.code, label: c.code }))} /></Field>
        <Field label="Day"><Select value={day} onChange={filter(setDay)} placeholder="All days" options={Array.from({ length: j.operational_days }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }))} /></Field>
        <Field label="Phase"><Select value={phase} onChange={filter(setPhase)} placeholder="Both" options={Object.entries(PHASES).map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Verification"><Select value={verification} onChange={filter(setVerification)} placeholder="Any" options={VERIFICATION} /></Field>
      </FilterBar>
      <DataState res={res} empty="No inspections match.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={setOpen} columns={[
              { key: 'coach', label: 'Coach', render: (r) => <span className="font-semibold">{r.coach_code}</span> },
              { key: 'slot', label: 'Day · round · phase', render: (r) => `D${r.day} · R${r.round} · ${PHASES[r.phase]}` },
              { key: 'when', label: 'Captured', render: (r) => fmtDateTime(r.device_timestamp ?? r.server_timestamp) },
              { key: 'sync', label: 'Sync', render: (r) => <SyncState record={r} /> },
              { key: 'verification', label: 'Verification', render: (r) => (r.verification_status ? <Badge tone={STATE_TONE[r.verification_status]}>{label(r.verification_status)}</Badge> : '—') },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
      {open && <InspectionDetail record={open} journey={j} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); }} />}
    </Panel>
  );
}

function JourneyInspection({ id }) {
  const { can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const grid = useResource(`/inspections/journeys/${id}/status`);
  const [tab, setTab] = useState('grid');
  const j = journey.data;

  if ((journey.loading && !j) || (grid.loading && !grid.data)) return <Loading />;
  if (!j || !grid.data) return <ErrorNote error={journey.error ?? grid.error} onRetry={() => { journey.reload(); grid.reload(); }} />;
  const tabs = [{ value: 'grid', label: 'Inspect' }, ...(can('inspections.read') ? [{ value: 'records', label: 'Records' }] : [])];

  return (
    <>
      <PageHeader back={<a href="#/inspections" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Journeys</a>}
        title="Coach inspection" subtitle={`${j.train_no} · ${j.train_name}`} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'records' ? <InspectionRecords journey={j} /> : <InspectionGrid journey={j} grid={grid} />}
    </>
  );
}

export default function Inspections({ parts }) {
  if (parts[0]) return <JourneyInspection id={parts[0]} key={parts[0]} />;
  return (
    <>
      <PageHeader title="Coach inspection" subtitle="Day, round and before/after photo inspections" />
      <JourneyPicker base="/inspections" />
    </>
  );
}
