// Shared pieces of the master-data administration screens.
import { useState } from 'react';
import { useNotify } from '../../../app/Layout.jsx';
import { useSession } from '../../../app/session.jsx';
import { useNetworkStatus } from '../../../hooks/useNetworkStatus.js';
import { canManageMaster } from '../../../services/authorization.js';
import { Badge, Dialog, Select } from '../../../components/ui.jsx';
import { Spinner } from '../../../components/Icons.jsx';

// Runs a server write; reports success only after the server accepted it.
export function useSave(onDone) {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn, ok) => {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      notify('success', ok);
      onDone(out);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

// Whether the signed-in user may change `area` master data of `divisionId` right now.
export function useMasterAccess(area, divisionId) {
  const { me } = useSession();
  const online = useNetworkStatus();
  const allowed = canManageMaster(me, area, divisionId);
  return { allowed, online, canEdit: allowed && online };
}

export function OfflineWriteNote({ access }) {
  if (!access.allowed || access.online) return null;
  return (
    <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200" data-testid="master-offline-note">
      Offline — changes to master data need a connection to the Swachh Safar server. You can still view the data stored on this device.
    </p>
  );
}

export const ActiveBadge = ({ active }) => <Badge tone={active ? 'green' : 'slate'}>{active ? 'Active' : 'Inactive'}</Badge>;

export const STATUS_FILTERS = [{ value: '', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];

export function matches(row, { q, status }, fields) {
  if (status === 'active' && !row.is_active) return false;
  if (status === 'inactive' && row.is_active) return false;
  const needle = q.trim().toLowerCase();
  return !needle || fields.some((f) => String(f(row) ?? '').toLowerCase().includes(needle));
}

export function FilterBar({ filter, setFilter, placeholder, children }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      <input className="input h-10 min-w-0 flex-1" placeholder={placeholder} aria-label="Search" value={filter.q}
        onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />
      <div className="w-40"><Select value={filter.status} onChange={(v) => setFilter((f) => ({ ...f, status: v }))} options={STATUS_FILTERS} aria-label="Status filter" /></div>
      {children}
    </div>
  );
}

// Confirmation for state-changing actions; the action runs only after the user confirms.
export function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onClose, busy, error }) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <p className="text-sm text-slate-700">{message}</p>
      {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">{error.message}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary h-12" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>{busy && <Spinner />} {confirmLabel}</button>
      </div>
    </Dialog>
  );
}

// Toggle is_active through a PATCH endpoint, after confirmation.
export function useActiveToggle({ path, what, onDone }) {
  const { api } = useSession();
  const [target, setTarget] = useState(null);
  const save = useSave(() => { setTarget(null); onDone(); });
  const dialog = (
    <ConfirmDialog open={!!target} onClose={() => { setTarget(null); save.setError(null); }} busy={save.busy} error={save.error}
      title={target?.is_active ? `Deactivate ${what}` : `Activate ${what}`}
      message={target?.is_active
        ? `"${target?.name}" will no longer be offered for new records. Existing records keep referring to it.`
        : `"${target?.name}" will be offered for new records again.`}
      confirmLabel={target?.is_active ? 'Deactivate' : 'Activate'}
      onConfirm={() => save.run(() => api.patch(`${path}/${target.id}`, { is_active: !target.is_active }), `${target.name} ${target.is_active ? 'deactivated' : 'activated'}.`)} />
  );
  return { ask: setTarget, dialog };
}
