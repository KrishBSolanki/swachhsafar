import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import { navigate } from '../../app/router.js';
import { GpsCapture, outcomeToast } from '../../components/Capture.jsx';
import {
  Badge, DataState, ErrorNote, Field, Loading, PageHeader, Panel, STATE_TONE, Select, SubmitBar, Table, Tabs, fmtDateTime, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon, Spinner } from '../../components/Icons.jsx';
import { deviceTimestamp } from '../../utils/capture.js';

const journeyDay = (j) => Math.max(1, Math.floor((Date.now() - new Date(`${j.journey_date}T00:00:00`)) / 86_400_000) + 1);

function useActiveJourneys() {
  const { can } = useSession();
  return useResource('/journeys', { state: 'active', mine: !can('journeys.read_all'), page_size: 100 });
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
    else if (outcome.status !== 'failed') setForm((f) => ({ ...f, passenger_name: '', mobile: '', pnr: '', seat_no: '' }));
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

function PassengerFlow({ id }) {
  const { api } = useSession();
  const notify = useNotify();
  const res = useResource(`/feedback/passenger/${id}`);
  const fb = res.data;
  const questions = useResource(fb && fb.status === 'verified' ? '/feedback/questions' : null, { journey_id: fb?.journey_id, coach_code: fb?.coach_code });
  const banks = useResource(fb ? '/feedback/question-banks' : null, { division_id: fb?.division_id });
  const defaults = useResource(fb ? '/feedback/question-banks' : null);
  const [otp, setOtp] = useState('');
  const [otpInfo, setOtpInfo] = useState(null);
  const [ratings, setRatings] = useState({});
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  if (res.loading && !fb) return <Loading />;
  if (!fb) return <ErrorNote error={res.error} onRetry={res.reload} />;
  const bank = [...(banks.data ?? []), ...(defaults.data ?? [])].find((b) => b.id === fb.bank_id);

  async function step(name, fn) {
    setBusy(name);
    setError(null);
    try {
      const out = await fn();
      res.reload();
      return out;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }

  const scale = bank ? Array.from({ length: bank.scale_max - bank.scale_min + 1 }, (_, i) => bank.scale_min + i) : [];

  return (
    <>
      <PageHeader back={<a href="#/feedback" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Feedback</a>}
        title={fb.passenger_name} subtitle={`Coach ${fb.coach_code} · Day ${fb.journey_day} · ${fb.mobile_masked}`} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={STATE_TONE[fb.status]}>{label(fb.status)}</Badge>
        <Badge>PNR: {label(fb.pnr_status)}</Badge>
        <Badge>OTP: {label(fb.otp_status)}</Badge>
      </div>
      <ErrorNote error={error} />
      <div className="mt-3 space-y-4">
        {fb.status === 'draft' && fb.pnr_status === 'pending' && (
          <Panel title="Step 1 · Verify PNR">
            <p className="mb-3 text-sm text-slate-600">PNR {fb.pnr ?? '—'} will be checked against this journey.</p>
            <button type="button" className="btn-primary" disabled={!!busy} onClick={() => step('pnr', () => api.post(`/feedback/passenger/${id}/verify-pnr`))}>{busy === 'pnr' && <Spinner />} Verify PNR</button>
          </Panel>
        )}
        {fb.status === 'draft' && fb.pnr_status !== 'pending' && ['not_sent', 'sent'].includes(fb.otp_status) && (
          <Panel title="Step 2 · OTP verification">
            <div className="flex flex-wrap items-end gap-2">
              <button type="button" className="btn-secondary h-12" disabled={!!busy}
                onClick={async () => { const out = await step('send', () => api.post(`/feedback/passenger/${id}/send-otp`)); if (out) { setOtpInfo(out); notify('info', `OTP sent to ${out.mobile_masked}.`); } }}>
                {busy === 'send' && <Spinner />} {fb.otp_status === 'sent' ? 'Resend OTP' : 'Send OTP'}
              </button>
              {fb.otp_status === 'sent' && (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); step('otp', () => api.post(`/feedback/passenger/${id}/verify-otp`, { code: otp })); }}>
                  <input className="input w-36 tracking-widest" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value)} required />
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
        {fb.status === 'verified' && (
          <Panel title="Step 3 · Ratings">
            {questions.loading || !bank ? <Loading label="Loading questions…" /> : questions.error ? <ErrorNote error={questions.error} /> : (
              <form className="space-y-4" onSubmit={(e) => {
                e.preventDefault();
                step('complete', () => api.post(`/feedback/passenger/${id}/complete`, {
                  ratings: Object.entries(ratings).map(([question_id, value]) => ({ question_id, value })), comments: comments || null,
                })).then((out) => out && notify('success', 'Feedback completed.'));
              }}>
                {questions.data.map((q) => (
                  <div key={q.id}>
                    <p className="mb-1.5 text-sm font-medium">{q.position}. {q.text_en}{q.required && <span className="text-red-600"> *</span>}</p>
                    {q.text_hi && <p className="mb-1.5 text-xs text-slate-500">{q.text_hi}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      {scale.map((v) => (
                        <button key={v} type="button" onClick={() => setRatings((r) => ({ ...r, [q.id]: v }))}
                          className={`h-10 w-10 rounded-xl text-sm font-semibold ring-1 ${ratings[q.id] === v ? 'bg-teal-700 text-white ring-teal-700' : 'ring-slate-200 hover:bg-slate-50'}`}>{v}</button>
                      ))}
                    </div>
                  </div>
                ))}
                <Field label="Comments"><textarea className="input h-20 py-3" maxLength={2000} value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
                <SubmitBar busy={busy === 'complete'} label="Submit feedback" disabled={questions.data.some((q) => q.required && ratings[q.id] === undefined)} />
              </form>
            )}
          </Panel>
        )}
        {fb.status === 'completed' && <Panel title="Feedback completed"><p className="text-sm text-slate-600">Submitted {fmtDateTime(fb.completed_at)} with {fb.ratings.length} rating(s).</p></Panel>}
      </div>
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
  const banks = useResource(j ? '/feedback/question-banks' : null, { division_id: j?.division_id });
  const defaults = useResource(j ? '/feedback/question-banks' : null);
  const bank = [...(banks.data ?? []), ...(defaults.data ?? [])].find((b) => b.audience === 'railway' && b.is_active);
  const scale = bank ? Array.from({ length: bank.scale_max - bank.scale_min + 1 }, (_, i) => bank.scale_min + i) : [];

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
    if (outcome.status !== 'failed') { setRatings({}); set({ railway_employee_id: '', official_name: '', designation: '', comments: '' }); }
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
                <div className="flex flex-wrap gap-1.5">
                  {scale.map((v) => (
                    <button key={v} type="button" onClick={() => setRatings((r) => ({ ...r, [q.id]: v }))}
                      className={`h-10 w-10 rounded-xl text-sm font-semibold ring-1 ${ratings[q.id] === v ? 'bg-teal-700 text-white ring-teal-700' : 'ring-slate-200'}`}>{v}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
        <Field label="Comments"><textarea className="input h-20 py-3" value={form.comments} onChange={(e) => set({ comments: e.target.value })} /></Field>
        <GpsCapture value={gps} onChange={setGps} />
        <SubmitBar busy={busy} disabled={!gps || !Object.keys(ratings).length} label="Submit" />
      </form>
    </Panel>
  );
}

function FeedbackList() {
  const res = useResource('/feedback/passenger', { page_size: 50 });
  return (
    <Panel title="Passenger feedback">
      <DataState res={res} empty="No passenger feedback recorded yet.">
        {(page) => (
          <Table rows={page.items} onRowClick={(f) => navigate(`/feedback/passenger/${f.id}`)} columns={[
            { key: 'passenger_name', label: 'Passenger' },
            { key: 'coach', label: 'Coach / day', render: (f) => `${f.coach_code} · D${f.journey_day}` },
            { key: 'mobile_masked', label: 'Mobile' },
            { key: 'status', label: 'Status', render: (f) => <Badge tone={STATE_TONE[f.status]}>{label(f.status)}</Badge> },
            { key: 'when', label: 'Captured', render: (f) => fmtDateTime(f.device_timestamp) },
          ]} />
        )}
      </DataState>
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
      {tab === 'list' && <FeedbackList />}
    </>
  );
}
