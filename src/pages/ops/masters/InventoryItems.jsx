// Inventory item master (backend: GET/POST /inventory/items, PATCH /inventory/items/{id}). Master data only:
// stock issue/return belongs to journey inventory. The unit is fixed after creation (not in ItemUpdate).
import { useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { DataState, Dialog, ErrorNote, Field, Panel, Select, SubmitBar, Table } from '../../../components/ui.jsx';
import { PlusIcon } from '../../../components/Icons.jsx';
import { UNITS, validateItem } from '../../../utils/masterValidation.js';
import { ActiveBadge, FilterBar, OfflineWriteNote, matches, useActiveToggle, useMasterAccess, useSave } from './common.jsx';

const unitLabel = (u) => UNITS.find((x) => x.value === u)?.label ?? u;

function ItemForm({ item, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const [f, setF] = useState({ name: item?.name ?? '', unit: item?.unit ?? '', ideal_qty: item?.ideal_qty ?? 0 });
  const [errors, setErrors] = useState({});
  const save = useSave(onSaved);
  function submit(e) {
    e.preventDefault();
    const found = validateItem(f, { creating: !item });
    setErrors(found);
    if (Object.keys(found).length) return;
    const fields = { name: f.name.trim(), ideal_qty: Number(f.ideal_qty) };
    save.run(
      () => (item ? api.patch(`/inventory/items/${item.id}`, fields) : api.post('/inventory/items', { ...fields, division_id: divisionId, unit: f.unit })),
      item ? 'Item updated.' : 'Item created.',
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorNote error={save.error} />
      <Field label="Item name" error={errors.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Unit" hint={item ? 'The unit cannot be changed after creation.' : undefined} error={errors.unit}>
          <Select value={f.unit} onChange={(v) => setF({ ...f, unit: v })} disabled={!!item} placeholder="Select unit" options={UNITS} />
        </Field>
        <Field label="Ideal quantity per journey" error={errors.ideal_qty}>
          <input className="input" inputMode="decimal" value={f.ideal_qty} onChange={(e) => setF({ ...f, ideal_qty: e.target.value })} />
        </Field>
      </div>
      <SubmitBar busy={save.busy} label={item ? 'Save' : 'Create item'} onCancel={onClose} />
    </form>
  );
}

export default function InventoryItems({ divisionId }) {
  const access = useMasterAccess('inventoryItems', divisionId);
  const res = useResource(divisionId ? '/inventory/items' : null, { division_id: divisionId });
  const [filter, setFilter] = useState({ q: '', status: '', unit: '' });
  const [edit, setEdit] = useState(null);
  const toggle = useActiveToggle({ path: '/inventory/items', what: 'item', onDone: res.reload });
  return (
    <Panel title="Inventory items" actions={access.canEdit && <button type="button" className="btn-secondary" onClick={() => setEdit('new')}><PlusIcon /> Add item</button>}>
      <OfflineWriteNote access={access} />
      <FilterBar filter={filter} setFilter={setFilter} placeholder="Search item">
        <div className="w-44"><Select value={filter.unit} onChange={(v) => setFilter((f) => ({ ...f, unit: v }))} aria-label="Unit filter"
          options={[{ value: '', label: 'All units' }, ...UNITS]} /></div>
      </FilterBar>
      <DataState res={res} empty="No inventory items in this division.">
        {(rows) => {
          const shown = rows.filter((i) => (!filter.unit || i.unit === filter.unit) && matches(i, filter, [(x) => x.name]));
          if (!shown.length) return <p className="py-6 text-center text-sm text-slate-500">No items match the filters.</p>;
          return (
            <Table rows={shown} onRowClick={access.canEdit ? setEdit : undefined} columns={[
              { key: 'name', label: 'Item', render: (i) => <span className="font-medium">{i.name}</span> },
              { key: 'unit', label: 'Unit', render: (i) => unitLabel(i.unit) },
              { key: 'ideal_qty', label: 'Ideal qty / journey', render: (i) => <span className="tabular-nums">{i.ideal_qty}</span> },
              { key: 'is_active', label: 'Status', render: (i) => <ActiveBadge active={i.is_active} /> },
              { key: 'actions', label: '', render: (i) => access.canEdit && (
                <button type="button" className="btn-link" onClick={(e) => { e.stopPropagation(); toggle.ask(i); }}>{i.is_active ? 'Deactivate' : 'Activate'}</button>
              ) },
            ]} />
          );
        }}
      </DataState>
      <Dialog open={!!edit} title={edit === 'new' ? 'Add inventory item' : 'Edit inventory item'} onClose={() => setEdit(null)}>
        {edit && <ItemForm item={edit === 'new' ? null : edit} divisionId={divisionId} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload(); }} />}
      </Dialog>
      {toggle.dialog}
    </Panel>
  );
}
