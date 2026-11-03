// Reusable building blocks for the operational screens: page headers, cards, tables, dialogs,
// form fields and the loading / empty / error states every data view needs.
import { useEffect } from 'react';
import { AlertIcon, Spinner, XIcon } from './Icons.jsx';

export function PageHeader({ title, subtitle, actions, back }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back}
        <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className = '' }) {
  return (
    <section className={`rounded-2xl bg-white p-4 ring-1 ring-slate-200/70 sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'teal' }) {
  const tones = { teal: 'text-teal-700', amber: 'text-amber-600', red: 'text-red-600', slate: 'text-slate-700' };
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone]}`}>{value ?? '—'}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const BADGE = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
  teal: 'bg-teal-50 text-teal-800 ring-teal-200',
};

export function Badge({ tone = 'slate', children }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${BADGE[tone]}`}>{children}</span>;
}

export const STATE_TONE = {
  active: 'green', scheduled: 'teal', history: 'slate', cancelled: 'red',
  created: 'amber', in_process: 'teal', forwarded: 'amber', completed: 'green',
  pending: 'amber', verified: 'green', rejected: 'red', draft: 'amber', void: 'red',
};

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  const unavailable = error.code === 'endpoint_unavailable';
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-200" role="alert">
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">{unavailable ? 'Backend endpoint unavailable' : error.status === 0 ? 'Offline' : 'Request failed'}</p>
        <p>{error.message}</p>
      </div>
      {onRetry && <button type="button" className="btn-link" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function StaleNote({ stale }) {
  if (!stale) return null;
  return <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">Offline — showing data last loaded on this device.</p>;
}

// Wraps the loading / error / empty decision for a useResource() result.
export function DataState({ res, empty, isEmpty, children }) {
  if (res.loading && !res.data) return <Loading />;
  if (res.error && !res.data) return <ErrorNote error={res.error} onRetry={res.reload} />;
  if (!res.data) return null;
  const blank = isEmpty ? isEmpty(res.data) : Array.isArray(res.data) ? !res.data.length : !res.data.items?.length;
  return (
    <>
      <StaleNote stale={res.stale} />
      {blank ? <Empty title={empty ?? 'Nothing here yet'} /> : children(res.data)}
    </>
  );
}

export function Table({ columns, rows, onRowClick, rowKey = (r) => r.id }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            {columns.map((c) => <th key={c.key} className="px-4 py-2 font-medium sm:px-3">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-b border-slate-100 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-teal-50/40' : ''}`}>
              {columns.map((c) => <td key={c.key} className="px-4 py-2.5 align-top sm:px-3">{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto rounded-2xl bg-slate-100 p-1" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition ${value === t.value ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ open, title, onClose, children, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100" aria-label="Close"><XIcon className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Select({ value, onChange, options, placeholder, ...rest }) {
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function SubmitBar({ busy, label, onCancel, disabled }) {
  return (
    <div className="mt-5 flex justify-end gap-2">
      {onCancel && <button type="button" className="btn-secondary h-12" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="btn-primary" disabled={busy || disabled}>{busy && <Spinner />} {label}</button>
    </div>
  );
}

export const fmtDate = (d) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const label = (s) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');
