import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { navigate } from '../../app/router.js';
import MediaPreview from '../../components/MediaPreview.jsx';
import ReviewPanel from '../../components/ReviewPanel.jsx';
import { GpsCapture, VoiceRecorder, outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, ConfirmDialog, DataState, DetailList, Dialog, ErrorNote, Field, FilterBar, Loading, OfflineActionsNote, OnlineButton, PageHeader,
  Pager, Panel, RatingScale, STATE_TONE, Segmented, Select, SubmitBar, SyncBadge, SyncState, Table, Tabs, fmtDate, fmtDateTime, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon, Spinner } from '../../components/Icons.jsx';
import { useAction } from '../../hooks/useAction.js';
import { canAct } from '../../services/authorization.js';
import { ONLINE_ONLY } from '../../services/operations.js';
import { deviceTimestamp } from '../../utils/capture.js';

const journeyDay = (j) => Math.max(1, Math.floor((Date.now() - new Date(`${j.journey_date}T00:00:00`)) / 86_400_000) + 1);
const PASSENGER_STATUS = ['draft', 'verified', 'completed', 'void'].map((s) => ({ value: s, label: label(s) }));

function useActiveJourneys() {
  const { can } = useSession();
  return useResource('/journeys', { state: 'active', mine: !can('journeys.read_all'), page_size: 100 });
}

// Question banks visible for a division: its own and the global defaults (GET /feedback/question-banks).
function useBanks(divisionId) {
  const own = useResource(divisionId ? '/feedback/question-banks' : null, { division_id: divisionId });
  const defaults = useResource(divisionId ? '/feedback/question-banks' : null);
  return [...(own.data ?? []), ...(defaults.data ?? [])];
}

// Submitted ratings with their question text (from the bank the record was answered on).
function RatingsView({ ratings, bank }) {
  if (!ratings?.length) return <p className="text-sm text-slate-500">No ratings recorded.</p>;
  const question = (id) => bank?.questions.find((q) => q.id === id);
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {ratings.map((r) => (
        <li key={r.question_id} className="flex justify-between gap-3 py-1.5">
          <span>{question(r.question_id) ? `${question(r.question_id).position}. ${question(r.question_id).text_en}` : 'Question not on this device'}</span>
          <span className="font-semibold tabular-nums">{r.value}{bank ? ` / ${bank.scale_max}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function JourneyCoachFields({ journeys, form, set, coachRequired = true }) {
  const j = journeys.data?.items.find((x) => x.id === form.journey_id);
  return (
    <>
      <Field label="Journey" error={journeys.error?.message}>
        <Select value={form.journey_id} required placeholder={journeys.loading ? 'Loading…' : 'Select active journey'}
          onChange={(v) => { const nj = journeys.data.items.find((x) => x.id === v); set({ journey_id: v, coach_code: '', journey_day: nj ? journeyDay(nj) : 1 }); }}
          options={(journeys.data?.items ?? []).map((x) => ({ value: x.id, label: `${x.train_no} · ${x.train_name}` }))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Coach">
          <Select value={form.coach_code} required={coachRequired} placeholder="Select coach" onChange={(v) => set({ coach_code: v })}
            options={(j?.coaches ?? []).map((c) => ({ value: c.code, label: `${c.code} (${c.classification === 'AC' ? 'AC' : 'Non-AC'})` }))} />
        </Field>
        <Field label="Journey day"><input type="number" min={1} max={30} className="input" required value={form.journey_day} onChange={(e) => set({ journey_day: Number(e.target.value) })} /></Field>
      </div>
    </>
  );
}

function PassengerStart() {
  const { queue } = useSession();
  const notify = useNotify();
  const journeys = useActiveJourneys();
  const [form, setForm] = useState({ journey_id: '', coach_code: '', journey_day: 1, passenger_name: '', mobile: '', pnr: '', seat_no: '' });
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const id = crypto.randomUUID();
    const outcome = await queue.submit({
      type: 'feedback.passenger.start',
      payload: { id, ...form, pnr: form.pnr || null, seat_no: form.seat_no || null, device_timestamp: deviceTimestamp(), ...gps },
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Passenger details');
    if (outcome.status === 'synced') navigate(`/feedback/passenger/${id}`);
    else if (savedLocally(outcome)) setForm((f) => ({ ...f, passenger_name: '', mobile: '', pnr: '', seat_no: '' }));
  }

  return (
    <Panel title="New passenger feedback">
      <form onSubmit={submit} className="space-y-3">
        <JourneyCoachFields journeys={journeys} form={form} set={set} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Passenger name"><input className="input" required minLength={2} value={form.passenger_name} onChange={(e) => set({ passenger_name: e.target.value })} /></Field>
          <Field label="Mobile" hint="10-digit Indian mobile, used for OTP"><input className="input" required inputMode="numeric" pattern="[6-9][0-9]{9}" value={form.mobile} onChange={(e) => set({ mobile: e.target.value })} /></Field>
          <Field label="PNR" hint="10 digits, if the division verifies PNR"><input className="input" inputMode="numeric" pattern="[0-9]{10}" value={form.pnr} onChange={(e) => set({ pnr: e.target.value })} /></Field>
          <Field label="Seat"><input className="input" maxLength={10} value={form.seat_no} onChange={(e) => set({ seat_no: e.target.value })} /></Field>
        </div>
        <GpsCapture value={gps} onChange={setGps} />
        <p className="text-xs text-slate-500">PNR and OTP verification and the ratings need a connection. Details captured offline are saved and can be continued from the list once synced.</p>
        <SubmitBar busy={busy} disabled={!gps} label="Continue" />
      </form>
    </Panel>
  );
}

function VoidDialog({ open, onClose, onVoid, busy }) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog open={open} title="Void passenger feedback" confirmLabel="Void feedback" danger busy={busy} disabled={reason.trim().length < 3}
      onClose={onClose} onConfirm={() => onVoid(reason)}>
      <p>A voided record is kept but not counted in reports. This cannot be undone.</p>
      <Field label="Reason" hint="3 to 200 characters"><textarea className="input h-20 py-3" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <OfflineActionsNote reason={ONLINE_ONLY.feedback} />
    </ConfirmDialog>
  );
}

function PassengerFlow({ id }) {
  const { ops, me } = useSession();
  const notify = useNotify();
  const res = useResource(`/feedback/passenger/${id}`);
  const fb = res.data;
  const journey = useResource(fb ? `/journeys/${fb.journey_id}` : null);
  const questions = useResource(fb && fb.status === 'verified' ? '/feedback/questions' : null, { journey_id: fb?.journey_id, coach_code: fb?.coach_code });
  const banks = useBanks(fb?.division_id);
  const [otp, setOtp] = useState('');
  const [otpInfo, setOtpInfo] = useState(null);
  const [ratings, setRatings] = useState({});
  const [comments, setComments] = useState('');
  const [voice, setVoice] = useState(null);
  const [voiding, setVoiding] = useState(false);
  const { busy, error, run } = useAction();

  if (res.loading && !fb) return <Loading />;
  if (!fb) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const bank = banks.find((b) => b.id === fb.bank_id);
  const collector = canAct(me, 'feedback.passenger.collect', fb);
  const onServer = fb.sync_status !== 'pending';
  const step = async (name, fn, ok) => {
    const out = await run(name, fn, ok);
    if (out) res.reload();
    return out;
  };

  return (
    <>
      <PageHeader back={<a href="#/feedback" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Feedback</a>}
        title={fb.passenger_name} subtitle={`Coach ${fb.coach_code} · Day ${fb.journey_day} · ${fb.mobile_masked}`}
        actions={canAct(me, 'feedback.passenger.void', fb) && onServer && (
          <OnlineButton className="btn-secondary text-red-700" onClick={() => setVoiding(true)}>Void</OnlineButton>
        )} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={STATE_TONE[fb.status]}>{label(fb.status)}</Badge>
        <Badge>PNR: {label(fb.pnr_status)}</Badge>
        <Badge>OTP: {label(fb.otp_status)}</Badge>
        <SyncBadge status={fb.sync_status} error={fb.last_sync_error} />
      </div>
      <ErrorNote error={error} />
      {!onServer && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          Saved on this device, waiting to sync. PNR and OTP verification start once the server has this record.
        </p>
      )}
      {onServer && fb.status !== 'completed' && fb.status !== 'void' && collector && <OfflineActionsNote reason={ONLINE_ONLY.pnr} />}
      <div className="mt-3 space-y-4">
        <Panel title="Passenger and journey">
          <DetailList items={[
            ['Train', journey.data ? `${journey.data.train_no} · ${journey.data.train_name}` : null],
            ['Journey date', journey.data ? fmtDate(journey.data.journey_date) : null],
            ['Coach', `${fb.coach_code} · ${fb.coach_class === 'AC' ? 'AC' : 'Non-AC'}`],
            ['Seat', fb.seat_no],
            ['PNR', fb.pnr],
            ['Mobile', fb.mobile_masked],
            ['Captured', fmtDateTime(fb.device_timestamp)],
            fb.void_reason && ['Void reason', fb.void_reason],
          ]} />
        </Panel>
        {!collector && fb.status !== 'completed' && fb.status !== 'void' && (
          <p className="text-sm text-slate-500">Only the staff member who collected this feedback can verify and complete it.</p>
        )}
        {collector && onServer && fb.status === 'draft' && fb.pnr_status === 'pending' && (
          <Panel title="Step 1 · Verify PNR">
            <p className="mb-3 text-sm text-slate-600">PNR {fb.pnr ?? '—'} will be checked against this journey.</p>
            <OnlineButton className="btn-primary" disabled={!!busy} onClick={() => step('pnr', () => ops.passengerFeedback.verifyPnr(id))}>{busy === 'pnr' && <Spinner />} Verify PNR</OnlineButton>
          </Panel>
        )}
        {collector && onServer && fb.status === 'draft' && fb.pnr_status !== 'pending' && ['not_sent', 'sent'].includes(fb.otp_status) && (
          <Panel title="Step 2 · OTP verification">
            <div className="flex flex-wrap items-end gap-2">
              <OnlineButton className="btn-secondary h-12" disabled={!!busy}
                onClick={async () => { const out = await step('send', () => ops.passengerFeedback.sendOtp(id)); if (out) { setOtpInfo(out); notify('info', `OTP sent to ${out.mobile_masked}.`); } }}>
                {busy === 'send' && <Spinner />} {fb.otp_status === 'sent' ? 'Resend OTP' : 'Send OTP'}
              </OnlineButton>
              {fb.otp_status === 'sent' && (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); step('otp', () => ops.passengerFeedback.verifyOtp(id, otp)); }}>
                  <input className="input w-36 tracking-widest" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code" aria-label="OTP code" value={otp} onChange={(e) => setOtp(e.target.value)} required />
                  <button type="submit" className="btn-primary" disabled={!!busy}>{busy === 'otp' && <Spinner />} Verify</button>
                </form>
              )}
            </div>
            {otpInfo && <p className="mt-2 text-xs text-slate-500">{otpInfo.sends_remaining} resends left · expires {fmtDateTime(otpInfo.expires_at)}</p>}
          </Panel>
        )}
        {fb.status === 'draft' && (fb.pnr_status === 'invalid' || fb.otp_status === 'locked') && (
          <ErrorNote error={{ message: fb.pnr_status === 'invalid' ? 'PNR is not valid for this journey. This feedback cannot be counted.' : 'Too many wrong OTP attempts. OTP verification is locked.' }} />
        )}
        {collector && fb.status === 'verified' && (
          <Panel title="Step 3 · Ratings">
            {questions.loading || !bank ? <Loading label="Loading questions…" /> : questions.error ? <ErrorNote error={questions.error} /> : (
              <form className="space-y-4" onSubmit={(e) => {
                e.preventDefault();
                // Completion is a server step: the voice file is uploaded (and acknowledged) first, then claimed.
                step('complete', async () => {
                  const voiceId = voice ? (await ops.media.upload({ value: voice, kind: 'feedback_voice', divisionId: fb.division_id })) : null;
                  return ops.passengerFeedback.complete(id, ratings, comments, voiceId);
                }, 'Feedback completed.');
              }}>
                {questions.data.map((q) => (
                  <div key={q.id}>
                    <p className="mb-1.5 text-sm font-medium">{q.position}. {q.text_en}{q.required && <span className="text-red-600"> *</span>}</p>
                    {q.text_hi && <p className="mb-1.5 text-xs text-slate-500">{q.text_hi}</p>}
                    <RatingScale min={bank.scale_min} max={bank.scale_max} value={ratings[q.id]} label={`Rating for question ${q.position}`}
                      onChange={(v) => setRatings((r) => ({ ...r, [q.id]: v }))} />
                  </div>
                ))}
                <Field label="Comments"><textarea className="input h-20 py-3" maxLength={2000} value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
                <Field label="Voice comment"><VoiceRecorder value={voice} onChange={setVoice} /></Field>
                <SubmitBar busy={busy === 'complete'} label="Submit feedback" disabled={questions.data.some((q) => q.required && ratings[q.id] === undefined)} />
              </form>
            )}
          </Panel>
        )}
        {fb.status === 'completed' && (
          <Panel title="Feedback completed">
            <p className="mb-3 text-sm text-slate-600">Submitted {fmtDateTime(fb.completed_at)} with {fb.ratings.length} rating(s).</p>
            <RatingsView ratings={fb.ratings} bank={bank} />
            {fb.comments && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{fb.comments}</p>}
            {fb.voice_media_id && <div className="mt-3"><MediaPreview id={fb.voice_media_id} kind="audio" label="Voice comment" /></div>}
          </Panel>
        )}
      </div>
      <VoidDialog open={voiding} busy={busy === 'void'} onClose={() => setVoiding(false)}
        onVoid={async (reason) => { if (await step('void', () => ops.passengerFeedback.void(id, reason), 'Feedback voided.')) setVoiding(false); }} />
    </>
  );
}

function RailwayForm() {
  const { queue } = useSession();
  const notify = useNotify();
  const journeys = useActiveJourneys();
  const [form, setForm] = useState({ journey_id: '', coach_code: '', journey_day: 1, railway_employee_id: '', official_name: '', designation: '', comments: '' });
  const [ratings, setRatings] = useState({});
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const j = journeys.data?.items.find((x) => x.id === form.journey_id);
  const questions = useResource(j ? '/feedback/questions' : null, { journey_id: form.journey_id, audience: 'railway' });
  const bank = useBanks(j?.division_id).find((b) => b.audience === 'railway' && b.is_active);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const outcome = await queue.submit({
      type: 'feedback.railway.create',
      payload: {
        id: crypto.randomUUID(), ...form, coach_code: form.coach_code || null, designation: form.designation || null, comments: form.comments || null,
        ratings: Object.entries(ratings).map(([question_id, value]) => ({ question_id, value })), device_timestamp: deviceTimestamp(), ...gps,
      },
    });
    setBusy(false);
    outcomeToast(notify, outcome, 'Railway feedback');
    if (savedLocally(outcome)) { setRatings({}); set({ railway_employee_id: '', official_name: '', designation: '', comments: '' }); }
  }

  return (
    <Panel title="Railway official feedback">
      <form onSubmit={submit} className="space-y-3">
        <JourneyCoachFields journeys={journeys} form={form} set={set} coachRequired={false} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Railway employee ID"><input className="input" required minLength={2} value={form.railway_employee_id} onChange={(e) => set({ railway_employee_id: e.target.value })} /></Field>
          <Field label="Official name"><input className="input" required minLength={2} value={form.official_name} onChange={(e) => set({ official_name: e.target.value })} /></Field>
          <Field label="Designation"><input className="input" value={form.designation} onChange={(e) => set({ designation: e.target.value })} /></Field>
        </div>
        {j && (questions.loading ? <Loading label="Loading questions…" /> : questions.error ? <ErrorNote error={questions.error} /> : (
          <div className="space-y-3">
            {(questions.data ?? []).map((q) => (
              <div key={q.id}>
                <p className="mb-1.5 text-sm font-medium">{q.position}. {q.text_en}</p>
                {bank && <RatingScale min={bank.scale_min} max={bank.scale_max} value={ratings[q.id]} label={`Rating for question ${q.position}`}
                  onChange={(v) => setRatings((r) => ({ ...r, [q.id]: v }))} />}
              </div>
            ))}
          </div>
        ))}
        <Field label="Comments"><textarea className="input h-20 py-3" value={form.comments} onChange={(e) => set({ comments: e.target.value })} /></Field>
        <GpsCapture value={gps} onChange={setGps} />
        <p className="text-xs text-slate-500">Photo or voice attachments are not part of railway feedback on the server yet.</p>
        <SubmitBar busy={busy} disabled={!gps || !Object.keys(ratings).length} label="Submit" />
      </form>
    </Panel>
  );
}

// Journeys for the record filters: every journey the user can see, newest first.
function useJourneyOptions() {
  const res = useResource('/journeys', { page_size: 200 });
  return (res.data?.items ?? []).map((j) => ({ value: j.id, label: `${j.train_no} · ${fmtDate(j.journey_date)}` }));
}

function PassengerRecords() {
  const journeys = useJourneyOptions();
  const [journeyId, setJourneyId] = useState('');
  const [status, setStatus] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const res = useResource('/feedback/passenger', { journey_id: journeyId, status, page: pageNo, page_size: 50 });
  const filter = (fn) => (v) => { fn(v); setPageNo(1); };
  return (
    <>
      <FilterBar>
        <Field label="Journey filter"><Select value={journeyId} onChange={filter(setJourneyId)} placeholder="All journeys" options={journeys} /></Field>
        <Field label="Status"><Select value={status} onChange={filter(setStatus)} placeholder="Any status" options={PASSENGER_STATUS} /></Field>
      </FilterBar>
      <DataState res={res} empty="No passenger feedback recorded yet.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={(f) => navigate(`/feedback/passenger/${f.id}`)} columns={[
              { key: 'passenger_name', label: 'Passenger' },
              { key: 'coach', label: 'Coach / day', render: (f) => `${f.coach_code} · D${f.journey_day}` },
              { key: 'mobile_masked', label: 'Mobile' },
              { key: 'status', label: 'Status', render: (f) => (f.sync_status === 'pending' ? <Badge tone="amber">Not synced</Badge> : <Badge tone={STATE_TONE[f.status]}>{label(f.status)}</Badge>) },
              { key: 'when', label: 'Captured', render: (f) => fmtDateTime(f.device_timestamp) },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
    </>
  );
}

// The verification state of a railway feedback record as this device knows it. Only a status received from
// the server is shown as verified or rejected; nothing is assumed.
export function railwayStatus(f) {
  if (f.sync_status === 'rejected' || f.sync_status === 'conflict') return { key: 'sync_rejected', label: 'Rejected by server (not saved)', tone: 'red' };
  if (f.sync_status !== 'synced') return { key: 'not_synced', label: 'Saved on device, not yet submitted', tone: 'amber' };
  if (f.verification_status === 'verified') return { key: 'verified', label: 'Verified', tone: 'green' };
  if (f.verification_status === 'rejected') return { key: 'rejected', label: 'Rejected in review', tone: 'red' };
  if (f.verification_status === 'submitted') return { key: 'submitted', label: 'Awaiting verification', tone: 'amber' };
  return { key: 'unknown', label: 'Status unknown (not yet received)', tone: 'slate' };
}

const RailwayStatusBadge = ({ record }) => {
  const s = railwayStatus(record);
  return <Badge tone={s.tone}>{s.label}</Badge>;
};

// No GET /feedback/railway/{id} exists on the server: the detail is the list row.
function RailwayDetail({ record, onClose, onChanged }) {
  const { me, ops } = useSession();
  const bank = useBanks(record.division_id).find((b) => b.id === record.bank_id);
  return (
    <Dialog open title={`${record.official_name} · ${record.railway_employee_id}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2"><SyncBadge status={record.sync_status} error={record.last_sync_error} /><RailwayStatusBadge record={record} /></div>
        <DetailList items={[
          ['Verified', record.verified_at ? fmtDateTime(record.verified_at) : null],
          ['Designation', record.designation],
          ['Coach', record.coach_code],
          ['Journey day', record.journey_day],
          ['Captured', fmtDateTime(record.device_timestamp)],
          ['Comments', record.comments],
        ]} />
        <RatingsView ratings={record.ratings} bank={bank} />
        <ReviewPanel record={record} allowed={canAct(me, 'feedback.railway.review', record)}
          onReview={(status, remarks) => ops.railwayFeedback.review(record.id, status, remarks)} onDone={onChanged} />
      </div>
    </Dialog>
  );
}

function RailwayRecords() {
  const journeys = useJourneyOptions();
  const [journeyId, setJourneyId] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [open, setOpen] = useState(null);
  const res = useResource('/feedback/railway', { journey_id: journeyId, page: pageNo, page_size: 50 });
  return (
    <>
      <FilterBar>
        <Field label="Journey filter"><Select value={journeyId} onChange={(v) => { setJourneyId(v); setPageNo(1); }} placeholder="All journeys" options={journeys} /></Field>
      </FilterBar>
      <DataState res={res} empty="No railway official feedback recorded yet.">
        {(page) => (
          <>
            <Table rows={page.items} onRowClick={setOpen} columns={[
              { key: 'official_name', label: 'Official', render: (f) => <>{f.official_name}<span className="block text-xs text-slate-500">{f.railway_employee_id}</span></> },
              { key: 'coach', label: 'Coach / day', render: (f) => `${f.coach_code ?? '—'} · D${f.journey_day}` },
              { key: 'ratings', label: 'Ratings', render: (f) => f.ratings?.length ?? 0 },
              { key: 'sync', label: 'Sync', render: (f) => <SyncState record={f} /> },
              { key: 'verification', label: 'Verification', render: (f) => <RailwayStatusBadge record={f} /> },
            ]} />
            <Pager data={page} onPage={setPageNo} />
          </>
        )}
      </DataState>
      {open && <RailwayDetail record={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); res.reload(); }} />}
    </>
  );
}

function FeedbackRecords() {
  const [audience, setAudience] = useState('passenger');
  return (
    <Panel>
      <div className="mb-4"><Segmented label="Feedback type" value={audience} onChange={setAudience}
        options={[{ value: 'passenger', label: 'Passenger' }, { value: 'railway', label: 'Railway official' }]} /></div>
      {audience === 'passenger' ? <PassengerRecords /> : <RailwayRecords />}
    </Panel>
  );
}

export default function Feedback({ parts }) {
  const { can } = useSession();
  const tabs = [
    can('feedback.collect') && { value: 'passenger', label: 'Passenger' },
    can('feedback.railway.submit') && { value: 'railway', label: 'Railway official' },
    can('feedback.read') && { value: 'list', label: 'Records' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.value);
  if (parts[0] === 'passenger' && parts[1]) return <PassengerFlow id={parts[1]} key={parts[1]} />;
  return (
    <>
      <PageHeader title="Feedback" subtitle="Passenger (PNR/OTP verified) and railway official feedback" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'passenger' && <PassengerStart />}
      {tab === 'railway' && <RailwayForm />}
      {tab === 'list' && <FeedbackRecords />}
    </>
  );
}
