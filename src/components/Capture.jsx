import { useEffect, useRef, useState } from 'react';
import { CameraIcon, PinIcon, Spinner } from './Icons.jsx';
import { compressImage, getPosition } from '../utils/capture.js';
import { validateMedia } from '../database/mediaStore.js';
import { startVoiceRecording, voiceFormat } from '../utils/voiceRecording.js';

export function PhotoCapture({ value, onChange, required }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setError(null);
      onChange(await compressImage(file));
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div>
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={pick} data-testid="photo-input" />
      {value ? (
        <div className="relative overflow-hidden rounded-2xl ring-1 ring-slate-200">
          <img src={value} alt="Captured evidence" className="max-h-64 w-full object-cover" />
          <button type="button" className="btn-secondary absolute bottom-2 right-2" onClick={() => input.current.click()}>Retake</button>
        </div>
      ) : (
        <button type="button" onClick={() => input.current.click()}
          className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-teal-200 bg-teal-50/40 text-sm font-medium text-teal-800 hover:bg-teal-50">
          <CameraIcon className="h-6 w-6" /> Take photo{required ? '' : ' (optional)'}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function GpsCapture({ value, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function locate() {
    setBusy(true);
    setError(null);
    try {
      onChange(await getPosition());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
      <div className="flex items-center gap-2 text-sm">
        <PinIcon className={`h-5 w-5 ${value ? 'text-emerald-600' : 'text-slate-400'}`} />
        {value ? (
          <span>{value.latitude.toFixed(5)}, {value.longitude.toFixed(5)} <span className="text-slate-500">±{Math.round(value.gps_accuracy_m)} m</span></span>
        ) : (
          <span className="text-slate-500">{error ?? 'Location not captured'}</span>
        )}
      </div>
      <button type="button" className="btn-secondary" onClick={locate} disabled={busy}>
        {busy && <Spinner />} {value ? 'Refresh' : 'Get GPS'}
      </button>
    </div>
  );
}

// Message for an operationsQueue.submit() outcome. Only 'synced' claims the server has the record.
export function outcomeToast(notify, outcome, what) {
  if (outcome.status === 'synced') notify('success', `${what} saved and synchronized.`);
  else if (outcome.status === 'invalid') notify('error', `${what} not saved: ${outcome.message}`);
  else if (outcome.status === 'failed') notify('error', `${what} rejected by the server: ${outcome.message}`);
  else notify('warning', `${what} saved on this device. It will sync when the server is reachable.`);
}

// True when the record is stored on the device (synced or waiting to sync).
export const savedLocally = (outcome) => outcome.status !== 'invalid' && outcome.status !== 'failed';

// ---- video and voice ------------------------------------------------------------------------------
// Values are { blob, mimeType, size, url } (url: an object URL for the preview). Only the Blob handle is
// kept in React state; its bytes are read once, when the record is saved (mediaItem below).

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// File extensions Android camera apps use when the browser reports no content type.
const VIDEO_EXT = { mp4: 'video/mp4', '3gp': 'video/3gpp', '3gpp': 'video/3gpp', webm: 'video/webm', mov: 'video/quicktime' };

function useObjectUrl(value, onChange) {
  // Revoke the preview URL when the value is replaced or the form closes.
  useEffect(() => () => { if (value?.url) URL.revokeObjectURL(value.url); }, [value]);
  return (blob, mimeType) => onChange(blob ? { blob, mimeType, size: blob.size, url: URL.createObjectURL(blob) } : null);
}

export function VideoCapture({ value, onChange }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  const set = useObjectUrl(value, onChange);
  function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    // Same rules as device storage and the server (mediaStore MEDIA_RULES): refused here, never "saved".
    let type;
    try {
      type = validateMedia({ kind: 'inspection_video', mimeType: file.type || VIDEO_EXT[ext], size: file.size });
    } catch (err) {
      setError(err.code === 'media_type_rejected' ? 'This video format is not supported. Record an MP4, 3GP or WebM video.' : err.message);
      return;
    }
    setError(null);
    set(file, type);
  }
  return (
    <div>
      <input ref={input} type="file" accept="video/*" capture="environment" className="hidden" onChange={pick} data-testid="video-input" />
      {value ? (
        <div className="space-y-2 rounded-2xl p-2 ring-1 ring-slate-200">
          <video src={value.url} controls playsInline className="max-h-56 w-full rounded-xl bg-black" data-testid="video-preview" />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Video · {MB(value.size)}</span>
            <span className="flex gap-2">
              <button type="button" className="btn-link" onClick={() => input.current.click()}>Retake</button>
              <button type="button" className="btn-link text-red-700" onClick={() => set(null)}>Remove</button>
            </span>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => input.current.click()} className="btn-secondary w-full">Record video (optional)</button>
      )}
      {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

export { voiceFormat };

// Voice comment: the recording lifecycle lives in src/utils/voiceRecording.js (tested with fakes).
export function VoiceRecorder({ value, onChange, maxSeconds = 120 }) {
  const [state, setState] = useState({ recording: false, seconds: 0, error: null });
  const rec = useRef(null);
  const set = useObjectUrl(value, onChange);
  const format = voiceFormat();

  useEffect(() => () => rec.current?.stop(), []);

  async function start() {
    setState({ recording: false, seconds: 0, error: null });
    try {
      rec.current = await startVoiceRecording({ maxSeconds, onTick: (seconds) => setState((s) => ({ ...s, seconds })) });
    } catch (e) {
      setState({ recording: false, seconds: 0, error: e.message });
      return;
    }
    setState({ recording: true, seconds: 0, error: null });
    try {
      const out = await rec.current.done;
      set(out.blob, out.mimeType);
      setState({ recording: false, seconds: out.seconds, error: out.interrupted ? 'Recording was interrupted; the part recorded so far was kept.' : null });
    } catch (e) {
      setState({ recording: false, seconds: 0, error: e.message });
    } finally {
      rec.current = null;
    }
  }

  const stop = () => rec.current?.stop();
  return (
    <div className="space-y-2" data-testid="voice-recorder">
      {state.recording ? (
        <div className="flex items-center justify-between rounded-2xl bg-red-50 px-4 py-3 ring-1 ring-red-200">
          <span className="flex items-center gap-2 text-sm font-medium text-red-800"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" /> Recording {state.seconds}s / {maxSeconds}s</span>
          <button type="button" className="btn-secondary" onClick={stop}>Stop</button>
        </div>
      ) : value ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl p-2 ring-1 ring-slate-200">
          <audio src={value.url} controls className="min-w-0 flex-1" />
          <button type="button" className="btn-link" onClick={start}>Re-record</button>
          <button type="button" className="btn-link text-red-700" onClick={() => set(null)}>Remove</button>
        </div>
      ) : (
        <button type="button" className="btn-secondary w-full" onClick={start} disabled={!format}>
          {format ? 'Record voice comment (optional)' : 'Voice recording is not supported on this browser'}
        </button>
      )}
      {state.error && <p className="text-xs text-red-600" role="alert">{state.error}</p>}
    </div>
  );
}

// A captured video/voice value as an operationsQueue media item (bytes read once, here).
export async function mediaItem(value, { id, kind, divisionId }) {
  return { id, kind, division_id: divisionId, bytes: new Uint8Array(await value.blob.arrayBuffer()), mimeType: value.mimeType };
}
