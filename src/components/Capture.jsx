import { useRef, useState } from 'react';
import { CameraIcon, PinIcon, Spinner } from './Icons.jsx';
import { compressImage, getPosition } from '../utils/capture.js';

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
  else if (outcome.status === 'failed') notify('error', `${what} rejected by the server: ${outcome.message}`);
  else notify('warning', `${what} saved on this device. It will sync when the server is reachable.`);
}
