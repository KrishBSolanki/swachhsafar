// Division operating policy (backend: GET/PUT /divisions/{id}/policy, PolicySettings). The policy always
// exists (server defaults apply until a division saves its own) and is replaced as a whole; there is no
// activate/deactivate. It configures operational rules, not user permissions.
import { useEffect, useState } from 'react';
import { useResource, useSession } from '../../../app/session.jsx';
import { DataState, ErrorNote, Field, Panel, Select, SubmitBar } from '../../../components/ui.jsx';
import { POLICY_FIELDS, policyPayload, validatePolicy } from '../../../utils/masterValidation.js';
import { ConfirmDialog, OfflineWriteNote, useMasterAccess, useSave } from './common.jsx';

const GROUPS = [...new Set(POLICY_FIELDS.map((f) => f.group))];
const show = (field, v) => (field.type === 'bool' ? (v ? 'Yes' : 'No') : v == null || v === '' ? 'No limit' : String(v));

function PolicyForm({ policy, divisionId, onSaved, onCancel }) {
  const { api } = useSession();
  const [f, setF] = useState(policy);
  const [errors, setErrors] = useState({});
  const [confirming, setConfirming] = useState(false);
  const save = useSave((saved) => { setConfirming(false); onSaved(saved); });
  const changed = POLICY_FIELDS.filter((field) => String(f[field.key] ?? '') !== String(policy[field.key] ?? ''));

  function submit(e) {
    e.preventDefault();
    const found = validatePolicy(f);
    setErrors(found);
    if (!Object.keys(found).length && changed.length) setConfirming(true);
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <ErrorNote error={save.error} />
      {GROUPS.map((g) => (
        <fieldset key={g} className="rounded-2xl p-3 ring-1 ring-slate-200">
          <legend className="px-1 text-sm font-semibold">{g}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {POLICY_FIELDS.filter((field) => field.group === g).map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint ?? (field.type === 'int' ? `${field.min}–${field.max}` : undefined)} error={errors[field.key]}>
                {field.type === 'bool'
                  ? <Select value={f[field.key] ? 'yes' : 'no'} onChange={(v) => setF({ ...f, [field.key]: v === 'yes' })} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
                  : <input className="input" inputMode="numeric" value={f[field.key] ?? ''} onChange={(e) => setF({ ...f, [field.key]: e.target.value })} />}
              </Field>
            ))}
          </div>
        </fieldset>
      ))}
      <SubmitBar label={changed.length ? `Save ${changed.length} change(s)` : 'No changes'} disabled={!changed.length} onCancel={onCancel} />
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} busy={save.busy} error={save.error} title="Save division policy" confirmLabel="Save policy"
        message={`This changes how new records are validated in this division: ${changed.map((c) => `${c.label} → ${show(c, f[c.key])}`).join('; ')}.`}
        onConfirm={() => save.run(() => api.put(`/divisions/${divisionId}/policy`, policyPayload(f)), 'Division policy saved.')} />
    </form>
  );
}

export default function DivisionPolicy({ divisionId, divisionName }) {
  const access = useMasterAccess('policies', divisionId);
  const res = useResource(divisionId ? `/divisions/${divisionId}/policy` : null);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [divisionId]);
  return (
    <Panel title={`Operating policy${divisionName ? ` · ${divisionName}` : ''}`}
      actions={access.canEdit && !editing && res.data && <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>Edit policy</button>}>
      <OfflineWriteNote access={access} />
      <DataState res={res} isEmpty={() => false}>
        {(policy) => (editing && access.canEdit
          ? <PolicyForm key={divisionId} policy={policy} divisionId={divisionId} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); res.reload(); }} />
          : (
            <div className="space-y-4">
              {GROUPS.map((g) => (
                <div key={g}>
                  <h3 className="mb-1 text-sm font-semibold text-slate-700">{g}</h3>
                  <dl className="divide-y divide-slate-100 rounded-2xl ring-1 ring-slate-200">
                    {POLICY_FIELDS.filter((field) => field.group === g).map((field) => (
                      <div key={field.key} className="flex justify-between gap-4 px-3 py-2 text-sm" data-testid={`policy-${field.key}`}>
                        <dt className="text-slate-600">{field.label}</dt>
                        <dd className="shrink-0 font-medium tabular-nums">{show(field, policy[field.key])}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          ))}
      </DataState>
    </Panel>
  );
}
