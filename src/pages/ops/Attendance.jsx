import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import { GpsCapture, PhotoCapture, outcomeToast } from '../../components/Capture.jsx';
import { DataState, Dialog, Loading, PageHeader, Panel, SubmitBar } from '../../components/ui.jsx';
import { CheckIcon, ChevronLeftIcon } from '../../components/Icons.jsx';
import { deviceTimestamp } from '../../utils/capture.js';

export const STAGES = ['Source', 'Enroute 1', 'Destination', 'Enroute 2', 'End'];

const CELL = {
  taken: 'bg-emerald-600 text-white',
  next: 'bg-white text-teal-800 ring-2 ring-teal-600 hover:bg-teal-50',
  locked: 'bg-slate-100 text-slate-400',
};

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

function JourneyAttendance({ id }) {
  const { can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const status = useResource(`/attendance/journeys/${id}/status`);
  const [target, setTarget] = useState(null);
  // Records captured offline aren't in the server's status yet: show them as pending locally.
  const [local, setLocal] = useState({});

  if (journey.loading && !journey.data) return <Loading />;
  const j = journey.data;
  const submit = can('attendance.submit');

  return (
    <>
      <PageHeader back={<a href="#/attendance" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Journeys</a>}
        title="Attendance" subtitle={j ? `${j.train_no} · ${j.train_name}` : undefined} />
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
                      const pending = local[`${s.employee_id}:${c.stage}`];
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
      {target && j && (
        <CaptureDialog target={target} journey={j} onClose={() => setTarget(null)}
          onDone={(outcome) => {
            if (outcome.status !== 'synced' && outcome.status !== 'failed') setLocal((l) => ({ ...l, [`${target.staff.employee_id}:${target.stage}`]: true }));
            setTarget(null);
            status.reload();
          }} />
      )}
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
