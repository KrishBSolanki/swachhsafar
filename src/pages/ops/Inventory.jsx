// CP-10 Inventory: issue / return of consumables per journey.
//
// Transactions are immutable and recorded through the operations queue ('inventory.record', a
// /sync/batch operation), so they work offline. The local repository refuses a return larger than the
// quantity issued for the same journey, item and coach, as the server does; balances are always derived
// from the ledger, never edited.
import { useState } from 'react';
import { useResource, useSession } from '../../app/session.jsx';
import { useNotify } from '../../app/Layout.jsx';
import JourneyPicker from '../../components/JourneyPicker.jsx';
import { outcomeToast, savedLocally } from '../../components/Capture.jsx';
import {
  Badge, ConfirmDialog, DataState, Dialog, Empty, ErrorNote, Field, Loading, PageHeader, Pager, Panel, STATE_TONE, Segmented, Select,
  SubmitBar, SyncState, Table, fmtDateTime, label,
} from '../../components/ui.jsx';
import { ChevronLeftIcon } from '../../components/Icons.jsx';
import { canAct } from '../../services/authorization.js';

const qty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

// Outstanding (issued − returned) for an item and coach, from the balance rows.
export const outstandingOf = (balance, itemId, coachCode) => {
  const row = (balance ?? []).find((r) => r.item_id === itemId && (r.coach_code ?? null) === (coachCode || null));
  return row ? row.issued - row.returned : 0;
};

function MovementForm({ journey, type, balance, onClose, onDone }) {
  const { queue } = useSession();
  const notify = useNotify();
  const items = useResource('/inventory/items', { division_id: journey.division_id, active: true });
  const [form, setForm] = useState({ item_id: '', coach_code: '', quantity: '', remarks: '' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const item = (items.data ?? []).find((i) => i.id === form.item_id);
  const quantity = Number(form.quantity);
  const open = outstandingOf(balance, form.item_id, form.coach_code);
  const tooMuch = type === 'return' && form.item_id && quantity > open + 1e-9;
  const valid = item && Number.isFinite(quantity) && quantity > 0 && quantity <= 1_000_000 && !tooMuch;

  async function record() {
    setBusy(true);
    const outcome = await queue.submit({
      type: 'inventory.record',
      // backend TxnIn (unknown fields are refused)
      payload: {
        id: crypto.randomUUID(), journey_id: journey.id, item_id: form.item_id, coach_code: form.coach_code || null,
        txn_type: type, quantity, remarks: form.remarks.trim() || null,
      },
    });
    setBusy(false);
    setConfirming(false);
    outcomeToast(notify, outcome, type === 'issue' ? 'Issue' : 'Return');
    if (savedLocally(outcome)) onDone();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); setConfirming(true); }} className="space-y-3">
      <ErrorNote error={items.error} />
      <Field label="Item">
        <Select value={form.item_id} required onChange={(v) => set({ item_id: v })}
          placeholder={items.loading ? 'Loading…' : (items.data ?? []).length ? 'Select item' : 'No active items in this division'}
          options={(items.data ?? []).map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Coach" hint="Leave empty for the whole journey">
          <Select value={form.coach_code} onChange={(v) => set({ coach_code: v })} placeholder="Whole journey"
            options={journey.coaches.map((c) => ({ value: c.code, label: c.code }))} />
        </Field>
        <Field label={`Quantity${item ? ` (${item.unit})` : ''}`}
          hint={type === 'return' && form.item_id ? `Outstanding: ${qty(open)}${item ? ` ${item.unit}` : ''}` : undefined}
          error={tooMuch ? 'A return cannot exceed the quantity issued.' : undefined}>
          <input className="input" type="number" min="0.01" step="any" max={1_000_000} required value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} />
        </Field>
      </div>
      <Field label="Remarks"><textarea className="input h-20 py-3" maxLength={300} value={form.remarks} onChange={(e) => set({ remarks: e.target.value })} /></Field>
      <SubmitBar label={type === 'issue' ? 'Review issue' : 'Review return'} disabled={!valid} onCancel={onClose} />
      <ConfirmDialog open={confirming} title={type === 'issue' ? 'Confirm issue' : 'Confirm return'} busy={busy}
        confirmLabel={type === 'issue' ? 'Record issue' : 'Record return'} onClose={() => setConfirming(false)} onConfirm={record}>
        <p>{type === 'issue' ? 'Issue' : 'Return'} <strong>{qty(quantity || 0)} {item?.unit}</strong> of <strong>{item?.name}</strong>{form.coach_code ? ` for coach ${form.coach_code}` : ' for the journey'}?</p>
        <p className="text-xs text-slate-500">Inventory transactions cannot be edited or deleted once recorded. A mistake is corrected with a new transaction.</p>
      </ConfirmDialog>
    </form>
  );
}

function JourneyInventory({ id }) {
  const { me, queue, can } = useSession();
  const journey = useResource(`/journeys/${id}`);
  const j = journey.data;
  const readable = can('inventory.read');
  const balance = useResource(j && readable ? `/inventory/journeys/${id}/balance` : null);
  const [pageNo, setPageNo] = useState(1);
  const ledger = useResource(j && readable ? `/inventory/journeys/${id}/transactions` : null, { page: pageNo, page_size: 50 });
  const [type, setType] = useState(null);
  const [scope, setScope] = useState('');

  if (journey.loading && !j) return <Loading />;
  if (!j) return <ErrorNote error={journey.error} onRetry={journey.reload} />;
  const canRecord = canAct(me, 'inventory.record', j);
  const people = [{ user_id: j.supervisor_id, name: j.supervisor_name }, ...j.staff];
  const by = (uid) => people.find((p) => p.user_id === uid)?.name ?? (uid ? 'Other user' : '—');
  const unsynced = (ledger.data?.items ?? []).filter((t) => t.sync_status === 'pending').length;
  const refresh = () => {
    balance.reload();
    ledger.reload();
    queue.refresh();
  };
  const coachRows = (rows) => rows.filter((r) => !scope || (scope === 'journey' ? !r.coach_code : r.coach_code === scope));

  return (
    <>
      <PageHeader back={<a href="#/inventory" className="btn-link mb-1 inline-flex items-center"><ChevronLeftIcon /> Journeys</a>}
        title="Inventory" subtitle={`${j.train_no} · ${j.train_name}`}
        actions={canRecord && (
          <>
            <button type="button" className="btn-primary h-10 text-sm" onClick={() => setType('issue')}>Issue</button>
            <button type="button" className="btn-secondary" onClick={() => setType('return')}>Return</button>
          </>
        )} />
      {!canRecord && can('inventory.transact') && (
        <p className="mb-3 text-sm text-slate-500">Only the journey supervisor, its allocated staff or a journey manager can record movements, while the journey is open.</p>
      )}
      {!readable ? <Empty title="You can record movements but not view the journey ledger.">Ask for inventory.read to see balances.</Empty> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase text-slate-500">Scope</span>
            <Segmented label="Scope" value={scope} onChange={setScope}
              options={[{ value: '', label: 'All' }, { value: 'journey', label: 'Whole journey' }, ...j.coaches.map((c) => ({ value: c.code, label: c.code }))]} />
          </div>
          <Panel title="Balance">
            {unsynced > 0 && balance.source === 'remote' && (
              <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                {unsynced} movement(s) recorded on this device are not yet included in the server balance.
              </p>
            )}
            <DataState res={balance} empty="Nothing issued on this journey yet.">
              {(rows) => (
                <Table rowKey={(r) => `${r.item_id}:${r.coach_code ?? ''}`} rows={coachRows(rows)} columns={[
                  { key: 'item_name', label: 'Item', render: (r) => <><span className="font-medium">{r.item_name}</span><span className="block text-xs text-slate-500">{r.unit}</span></> },
                  { key: 'coach', label: 'Coach', render: (r) => r.coach_code ?? 'Journey' },
                  { key: 'issued', label: 'Issued', render: (r) => qty(r.issued) },
                  { key: 'returned', label: 'Returned', render: (r) => qty(r.returned) },
                  { key: 'consumed', label: 'Consumed', render: (r) => qty(r.consumed) },
                  { key: 'ideal', label: 'Ideal qty', render: (r) => qty(r.ideal_qty) },
                ]} />
              )}
            </DataState>
          </Panel>
          <Panel title="Transactions">
            <DataState res={ledger} empty="No transactions recorded.">
              {(page) => (
                <>
                  <Table rows={coachRows([...page.items].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))))} columns={[
                    { key: 'when', label: 'When', render: (t) => fmtDateTime(t.created_at) },
                    { key: 'type', label: 'Type', render: (t) => <Badge tone={STATE_TONE[t.txn_type]}>{label(t.txn_type)}</Badge> },
                    { key: 'item', label: 'Item', render: (t) => t.item_name ?? (balance.data ?? []).find((b) => b.item_id === t.item_id)?.item_name ?? '—' },
                    { key: 'qty', label: 'Quantity', render: (t) => `${qty(t.quantity)}${t.unit ? ` ${t.unit}` : ''}` },
                    { key: 'coach', label: 'Coach', render: (t) => t.coach_code ?? 'Journey' },
                    { key: 'by', label: 'Recorded by', render: (t) => by(t.created_by_id) },
                    { key: 'remarks', label: 'Remarks', render: (t) => t.remarks ?? '—' },
                    { key: 'sync', label: 'Sync', render: (t) => <SyncState record={t} /> },
                  ]} />
                  <Pager data={page} onPage={setPageNo} />
                </>
              )}
            </DataState>
          </Panel>
        </div>
      )}
      <Dialog open={!!type} title={type === 'issue' ? 'Issue inventory' : 'Return inventory'} onClose={() => setType(null)} wide>
        {type && <MovementForm journey={j} type={type} balance={balance.data} onClose={() => setType(null)} onDone={() => { setType(null); refresh(); }} />}
      </Dialog>
    </>
  );
}

export default function Inventory({ parts }) {
  if (parts[0]) return <JourneyInventory id={parts[0]} key={parts[0]} />;
  return (
    <>
      <PageHeader title="Inventory" subtitle="Consumables issued to and returned from journeys" />
      <JourneyPicker base="/inventory" />
    </>
  );
}
