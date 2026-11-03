import { useMemo, useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import { GpsCapture, PhotoCapture, outcomeToast } from '../../components/Capture.jsx';
import { Dialog, Empty, ErrorNote, Field, Loading, PageHeader, Panel, StaleNote, SubmitBar } from '../../components/ui.jsx';
import { CheckIcon, ChevronLeftIcon } from '../../components/Icons.jsx';
import { deviceTimestamp } from '../../utils/capture.js';

const PHASES = { B: 'Before', A: 'After' };

function Segmented({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition ${value === o.value ? 'bg-teal-700 text-white ring-teal-700' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function InspectDialog({ target, journey, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const [gps, setGps] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const mediaId = crypto.randomUUID();
    const outcome = await queue.submit({
      type: 'inspection.create',
      payload: {
        id: crypto.randomUUID(), journey_id: journey.id, coach_code: target.coach, day: target.day, round: target.round,
        phase: target.phase, comments: comments.trim() || null, device_timestamp: deviceTimestamp(), ...gps, photo_media_id: mediaId,
      },
      media: [{ id: mediaId, division_id: journey.division_id, kind: 'inspection_photo', dataUrl: photo }],
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
        <SubmitBar busy={busy} disabled={!gps || !photo} label="Submit inspection" onCancel={onClose} />
      </form>
    </Dialog>
  );
}

function JourneyInspection({ id }) {
  const { can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const grid = useResource(`/inspections/journeys/${id}/status`);
  const [day, setDay] = useState(null);
  const [round, setRound] = useState(1);
  const [phase, setPhase] = useState(null);
  const [target, setTarget] = useState(null);
  const [local, setLocal] = useState({});
  const j = journey.data;

  const days = useMemo(() => [...new Set((grid.data ?? []).map((c) => c.day))].sort((a, b) => a - b), [grid.data]);
  const openDay = (grid.data ?? []).find((c) => c.day_open)?.day;
  const activeDay = day ?? openDay ?? days[0];
  const phases = j ? [j.before_inspection_enabled && 'B', j.after_inspection_enabled && 'A'].filter(Boolean) : [];
  const activePhase = phase ?? phases[0];
  const coaches = (grid.data ?? []).filter((c) => c.day === activeDay);
  const done = coaches.reduce((n, c) => n + c.done, 0);
  const required = coaches.reduce((n, c) => n + c.required, 0);

  if ((journey.loading && !j) || (grid.loading && !grid.data)) return <Loading />;
  if (!j || !grid.data) return <ErrorNote error={journey.error ?? grid.error} onRetry={() => { journey.reload(); grid.reload(); }} />;

  return (
    <>
      <PageHeader back={<a href="#/inspections" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Journeys</a>}
        title="Coach inspection" subtitle={`${j.train_no} · ${j.train_name}`} />
      <StaleNote stale={grid.stale} />
      <Panel className="mb-4">
        <div className="space-y-3">
          <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Day</p>
            <Segmented value={activeDay} onChange={setDay} options={days.map((d) => ({ value: d, label: `Day ${d}${d === openDay ? ' •' : ''}` }))} /></div>
          <div className="flex flex-wrap gap-6">
            <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Round</p>
              <Segmented value={round} onChange={setRound} options={Array.from({ length: j.inspection_rounds_per_day }, (_, i) => ({ value: i + 1, label: `R${i + 1}` }))} /></div>
            <div><p className="mb-1.5 text-xs font-medium uppercase text-slate-500">Phase</p>
              <Segmented value={activePhase} onChange={setPhase} options={phases.map((p) => ({ value: p, label: PHASES[p] }))} /></div>
          </div>
          <div>
            <div className="flex justify-between text-sm"><span className="font-medium">Day {activeDay} completion</span><span className="tabular-nums text-slate-600">{done}/{required}</span></div>
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
            const cls = {
              taken: 'bg-emerald-600 text-white ring-emerald-600',
              pending: 'bg-amber-400 text-slate-900 ring-amber-400',
              open: 'bg-white text-teal-800 ring-teal-600 hover:bg-teal-50',
              locked: 'bg-slate-100 text-slate-400 ring-slate-200',
            }[status];
            return (
              <button key={c.coach_code} type="button" disabled={!clickable}
                onClick={() => setTarget({ coach: c.coach_code, day: activeDay, round, phase: activePhase, key })}
                className={`flex aspect-square flex-col items-center justify-center rounded-2xl text-sm font-bold ring-2 transition ${cls}`}
                aria-label={`Coach ${c.coach_code} ${status}`}>
                {status === 'taken' && <CheckIcon className="mb-0.5 h-4 w-4" />}
                {c.coach_code}
                <span className="text-[10px] font-medium opacity-80">{status === 'pending' ? 'Not synced' : `${c.done}/${c.required}`}</span>
              </button>
            );
          })}
        </div>
      )}
      {target && (
        <InspectDialog target={target} journey={j} onClose={() => setTarget(null)}
          onDone={(outcome) => {
            if (outcome.status !== 'synced' && outcome.status !== 'failed') setLocal((l) => ({ ...l, [target.key]: true }));
            setTarget(null);
            grid.reload();
          }} />
      )}
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
