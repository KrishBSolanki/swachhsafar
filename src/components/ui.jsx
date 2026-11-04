// Reusable building blocks for the operational screens: page headers, cards, tables, dialogs,
// form fields and the loading / empty / error / offline / sync states every data view needs.
import { useEffect } from 'react';
import { AlertIcon, Spinner, XIcon } from './Icons.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';

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
  issue: 'teal', return: 'slate',
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
  const conflict = error.code === 'version_conflict';
  const heading = unavailable ? 'Backend endpoint unavailable' : conflict ? 'Changed by someone else'
    : error.status === 0 ? 'Offline' : 'Request failed';
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-200" role="alert">
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">{heading}</p>
        <p>{error.message}</p>
      </div>
      {onRetry && <button type="button" className="btn-link" onClick={onRetry}>{conflict ? 'Reload latest' : 'Retry'}</button>}
    </div>
  );
}

// `cachedAt`: when an offline snapshot (no local table) was loaded from the server.
export function StaleNote({ stale, cachedAt }) {
  if (!stale) return null;
  return (
    <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
      {cachedAt ? `Offline — showing the copy last loaded ${fmtDateTime(cachedAt)}. It may be out of date.` : 'Offline — showing data stored on this device.'}
    </p>
  );
}

// Wraps the loading / error / empty decision for a useResource() result.
export function DataState({ res, empty, isEmpty, children }) {
  if (res.loading && !res.data) return <Loading />;
  if (res.error && !res.data) return <ErrorNote error={res.error} onRetry={res.reload} />;
  if (!res.data) return null;
  const blank = isEmpty ? isEmpty(res.data) : Array.isArray(res.data) ? !res.data.length : !res.data.items?.length;
  return (
    <>
      <StaleNote stale={res.stale} cachedAt={res.cachedAt} />
      {blank ? <Empty title={empty ?? 'Nothing here yet'} /> : children(res.data)}
    </>
  );
}

// Page navigation for the backend's { items, total, page, page_size } envelope.
export function Pager({ data, onPage }) {
  if (!data?.total || data.total <= data.page_size) return null;
  const pages = Math.ceil(data.total / data.page_size);
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
      <span>Page {data.page} of {pages} · {data.total} records</span>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
        <button type="button" className="btn-secondary" disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}>Next</button>
      </div>
    </div>
  );
}

// A row of filters above a list.
export function FilterBar({ children }) {
  return <div className="mb-4 flex flex-wrap items-end gap-3 [&>*]:min-w-[9rem]">{children}</div>;
}

export function Segmented({ options, value, onChange, label: aria }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={aria}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition ${value === o.value ? 'bg-teal-700 text-white ring-teal-700' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Where a record stands between this device and the server. Server-confirmed records show nothing.
const SYNC = {
  pending: ['amber', 'Not synced'],
  rejected: ['red', 'Rejected by server'],
  conflict: ['red', 'Sync conflict'],
};
export function SyncBadge({ status, error }) {
  const s = SYNC[status];
  if (!s) return null;
  return <span title={error ?? undefined}><Badge tone={s[0]}>{s[1]}</Badge></span>;
}

// Table cell form: 'On server' for server-confirmed records, the badge otherwise.
export function SyncState({ record }) {
  return SYNC[record.sync_status] ? <SyncBadge status={record.sync_status} error={record.last_sync_error} /> : <span className="text-xs text-slate-500">On server</span>;
}

// A button for an action that needs the server: disabled offline, with the reason shown beside it.
export function OnlineButton({ reason, className = 'btn-secondary', disabled, children, ...rest }) {
  const online = useNetworkStatus();
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={className} disabled={!online || disabled} title={!online ? reason : undefined} {...rest}>{children}</button>
      {!online && reason && <span className="mt-1 max-w-xs text-xs text-amber-800">{reason}</span>}
    </span>
  );
}

// Explains, once per screen, why its server-only actions are unavailable.
export function OfflineActionsNote({ reason }) {
  const online = useNetworkStatus();
  if (online) return null;
  return <p className="mb-3 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">Offline: {reason}</p>;
}

export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', danger, busy, disabled, onConfirm, onClose }) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-700">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary h-12" onClick={onClose}>Back</button>
        <button type="button" className={danger ? 'btn-primary bg-red-700 hover:bg-red-800' : 'btn-primary'} disabled={busy || disabled} onClick={onConfirm}>
          {busy && <Spinner />} {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// Label/value pairs of a record. `items`: [[label, value], ...]; empty values show as '—'.
export function DetailList({ items }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1.5 sm:block sm:border-0 sm:py-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="text-right text-slate-800 sm:text-left">{v === null || v === undefined || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

// Append-only history, oldest first. `items`: [{ id, title, at, body }].
export function Timeline({ items, empty = 'No history recorded.' }) {
  if (!items.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ol className="space-y-3 border-l-2 border-teal-100 pl-4">
      {items.map((h) => (
        <li key={h.id} className="text-sm">
          <p className="font-medium">{h.title} <span className="text-xs font-normal text-slate-500">· {fmtDateTime(h.at)}</span></p>
          {h.body && <p className="text-slate-600">{h.body}</p>}
        </li>
      ))}
    </ol>
  );
}

// One rating question on the bank's scale.
export function RatingScale({ min, max, value, onChange, label: aria }) {
  const scale = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={aria}>
      {scale.map((v) => (
        <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
          className={`h-10 w-10 rounded-xl text-sm font-semibold ring-1 ${value === v ? 'bg-teal-700 text-white ring-teal-700' : 'ring-slate-200 hover:bg-slate-50'}`}>{v}</button>
      ))}
    </div>
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
