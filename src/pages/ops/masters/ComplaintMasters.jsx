// Complaint departments and categories (backend: GET/POST /complaints/departments|categories,
// PATCH /complaints/departments|categories/{id}). Records are deactivated, never deleted: complaints keep
// referring to them. A category's division and parent cannot change after creation (not in the update schema).
import { useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { DataState, Dialog, ErrorNote, Field, Panel, Select, SubmitBar, Table } from '../../../components/ui.jsx';
import { PlusIcon } from '../../../components/Icons.jsx';
import { validateCategory, validateDepartment } from '../../../utils/masterValidation.js';
import { ActiveBadge, FilterBar, OfflineWriteNote, matches, useActiveToggle, useMasterAccess, useSave } from './common.jsx';

function DepartmentForm({ department, divisionId, onClose, onSaved }) {
  const { api } = useSession();
  const [name, setName] = useState(department?.name ?? '');
  const [errors, setErrors] = useState({});
  const save = useSave(onSaved);
  function submit(e) {
    e.preventDefault();
    const found = validateDepartment({ name });
    setErrors(found);
    if (Object.keys(found).length) return;
    save.run(
      () => (department ? api.patch(`/complaints/departments/${department.id}`, { name: name.trim() }) : api.post('/complaints/departments', { division_id: divisionId, name: name.trim() })),
      department ? 'Department updated.' : 'Department created.',
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorNote error={save.error} />
      <Field label="Department name" error={errors.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <SubmitBar busy={save.busy} label={department ? 'Save' : 'Create department'} onCancel={onClose} />
    </form>
  );
}

export function Departments({ divisionId }) {
  const access = useMasterAccess('complaintMasters', divisionId);
  const res = useResource(divisionId ? '/complaints/departments' : null, { division_id: divisionId });
  const categories = useResource(divisionId ? '/complaints/categories' : null, { division_id: divisionId });
  const [filter, setFilter] = useState({ q: '', status: '' });
  const [edit, setEdit] = useState(null);
  const toggle = useActiveToggle({ path: '/complaints/departments', what: 'department', onDone: res.reload });
  const routed = (d) => (categories.data ?? []).filter((c) => c.default_department_id === d.id);

  return (
    <Panel title="Complaint departments" actions={access.canEdit && <button type="button" className="btn-secondary" onClick={() => setEdit('new')}><PlusIcon /> Add department</button>}>
      <OfflineWriteNote access={access} />
      <FilterBar filter={filter} setFilter={setFilter} placeholder="Search department" />
      <DataState res={res} empty="No complaint departments in this division.">
        {(rows) => {
          const shown = rows.filter((d) => matches(d, filter, [(x) => x.name]));
          if (!shown.length) return <p className="py-6 text-center text-sm text-slate-500">No departments match the filters.</p>;
          return (
            <Table rows={shown} onRowClick={access.canEdit ? setEdit : undefined} columns={[
              { key: 'name', label: 'Department', render: (d) => <span className="font-medium">{d.name}</span> },
              { key: 'routing', label: 'Default for categories', render: (d) => routed(d).map((c) => c.name).join(', ') || '—' },
              { key: 'is_active', label: 'Status', render: (d) => <ActiveBadge active={d.is_active} /> },
              { key: 'actions', label: '', render: (d) => access.canEdit && (
                <button type="button" className="btn-link" onClick={(e) => { e.stopPropagation(); toggle.ask(d); }}>{d.is_active ? 'Deactivate' : 'Activate'}</button>
              ) },
            ]} />
          );
        }}
      </DataState>
      <Dialog open={!!edit} title={edit === 'new' ? 'Add department' : 'Edit department'} onClose={() => setEdit(null)}>
        {edit && <DepartmentForm department={edit === 'new' ? null : edit} divisionId={divisionId} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload(); }} />}
      </Dialog>
      {toggle.dialog}
    </Panel>
  );
}

function CategoryForm({ category, divisionId, categories, departments, onClose, onSaved }) {
  const { api } = useSession();
  const [f, setF] = useState({
    parent_id: category?.parent_id ?? '', name: category?.name ?? '', default_department_id: category?.default_department_id ?? '',
    sla_hours: category?.sla_hours ?? '', sort_order: category?.sort_order ?? 0,
  });
  const [errors, setErrors] = useState({});
  const save = useSave(onSaved);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const mains = categories.filter((c) => !c.parent_id && c.is_active && c.id !== category?.id);
  // Only active departments of this division can be chosen (backend _department); keep the current one listed.
  const depOptions = departments.filter((d) => d.is_active || d.id === category?.default_department_id);

  function submit(e) {
    e.preventDefault();
    const found = validateCategory(f);
    setErrors(found);
    if (Object.keys(found).length) return;
    const fields = {
      name: f.name.trim(), default_department_id: f.default_department_id || null,
      sla_hours: f.sla_hours === '' ? null : Number(f.sla_hours), sort_order: Number(f.sort_order),
    };
    save.run(
      () => (category ? api.patch(`/complaints/categories/${category.id}`, fields) : api.post('/complaints/categories', { ...fields, division_id: divisionId, parent_id: f.parent_id || null })),
      category ? 'Category updated.' : 'Category created.',
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorNote error={save.error} />
      <Field label="Parent category" hint={category ? 'The parent cannot be changed after creation.' : 'Leave empty for a main category'}>
        <Select value={f.parent_id} onChange={set('parent_id')} disabled={!!category} placeholder="None (main category)"
          options={(category ? categories.filter((c) => c.id === category.parent_id) : mains).map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category name" error={errors.name}><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Default department"><Select value={f.default_department_id} onChange={set('default_department_id')} placeholder="None"
          options={depOptions.map((d) => ({ value: d.id, label: d.is_active ? d.name : `${d.name} (inactive)` }))} /></Field>
        <Field label="SLA (hours)" hint="Empty: the division default applies" error={errors.sla_hours}>
          <input className="input" inputMode="numeric" value={f.sla_hours} onChange={set('sla_hours')} />
        </Field>
        <Field label="Display order" error={errors.sort_order}><input type="number" className="input" value={f.sort_order} onChange={set('sort_order')} /></Field>
      </div>
      <SubmitBar busy={save.busy} label={category ? 'Save' : 'Create category'} onCancel={onClose} />
    </form>
  );
}

export function Categories({ divisionId }) {
  const access = useMasterAccess('complaintMasters', divisionId);
  const res = useResource(divisionId ? '/complaints/categories' : null, { division_id: divisionId });
  const departments = useResource(divisionId ? '/complaints/departments' : null, { division_id: divisionId });
  const [filter, setFilter] = useState({ q: '', status: '', department: '' });
  const [edit, setEdit] = useState(null);
  const toggle = useActiveToggle({ path: '/complaints/categories', what: 'category', onDone: res.reload });
  const deps = departments.data ?? [];
  const depName = (id) => deps.find((d) => d.id === id)?.name ?? '—';

  return (
    <Panel title="Complaint categories" actions={access.canEdit && <button type="button" className="btn-secondary" onClick={() => setEdit('new')}><PlusIcon /> Add category</button>}>
      <OfflineWriteNote access={access} />
      <FilterBar filter={filter} setFilter={setFilter} placeholder="Search category">
        <div className="w-48"><Select value={filter.department} onChange={(v) => setFilter((f) => ({ ...f, department: v }))} aria-label="Department filter"
          options={[{ value: '', label: 'All departments' }, ...deps.map((d) => ({ value: d.id, label: d.name }))]} /></div>
      </FilterBar>
      <DataState res={res} empty="No complaint categories in this division.">
        {(rows) => {
          const parentName = (id) => rows.find((c) => c.id === id)?.name;
          // Main categories first, each followed by its sub-categories.
          const ordered = rows.filter((c) => !c.parent_id).flatMap((m) => [m, ...rows.filter((c) => c.parent_id === m.id)]);
          const shown = ordered.filter((c) => (!filter.department || c.default_department_id === filter.department)
            && matches(c, filter, [(x) => x.name, (x) => parentName(x.parent_id)]));
          if (!shown.length) return <p className="py-6 text-center text-sm text-slate-500">No categories match the filters.</p>;
          return (
            <Table rows={shown} onRowClick={access.canEdit ? setEdit : undefined} columns={[
              { key: 'name', label: 'Category', render: (c) => (c.parent_id
                ? <span className="pl-4">↳ {c.name}<span className="block pl-4 text-xs text-slate-500">in {parentName(c.parent_id)}</span></span>
                : <span className="font-medium">{c.name}<span className="block text-xs font-normal text-slate-500">{rows.filter((x) => x.parent_id === c.id).length} sub-categories</span></span>) },
              { key: 'department', label: 'Default department', render: (c) => depName(c.default_department_id) },
              { key: 'sla', label: 'SLA', render: (c) => (c.sla_hours ? `${c.sla_hours} h` : 'Division default') },
              { key: 'sort_order', label: 'Order' },
              { key: 'is_active', label: 'Status', render: (c) => <ActiveBadge active={c.is_active} /> },
              { key: 'actions', label: '', render: (c) => access.canEdit && (
                <button type="button" className="btn-link" onClick={(e) => { e.stopPropagation(); toggle.ask(c); }}>{c.is_active ? 'Deactivate' : 'Activate'}</button>
              ) },
            ]} />
          );
        }}
      </DataState>
      <Dialog open={!!edit} title={edit === 'new' ? 'Add category' : 'Edit category'} onClose={() => setEdit(null)} wide>
        {edit && <CategoryForm category={edit === 'new' ? null : edit} divisionId={divisionId} categories={res.data ?? []} departments={deps}
          onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload(); }} />}
      </Dialog>
      {toggle.dialog}
    </Panel>
  );
}
