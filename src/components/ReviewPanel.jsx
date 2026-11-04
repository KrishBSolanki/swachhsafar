// Verify / reject a server record (attendance, inspection, railway feedback): backend ReviewIn
// { status: 'verified' | 'rejected', remarks ≤ 500 }. Online only; records not yet on the server
// cannot be reviewed.
import { useState } from 'react';
import { useAction } from '../hooks/useAction.js';
import { ONLINE_ONLY } from '../services/operations.js';
import { Badge, ErrorNote, Field, OnlineButton, STATE_TONE, label } from './ui.jsx';
import { Spinner } from './Icons.jsx';

export default function ReviewPanel({ record, allowed, onReview, onDone }) {
  const [remarks, setRemarks] = useState('');
  const { busy, error, run } = useAction();
  const status = record.verification_status;

  if (record.sync_status === 'pending') {
    return <p className="text-sm text-slate-500">Review becomes available once this record has synced to the server.</p>;
  }
  const current = <p className="text-sm">Verification: <Badge tone={STATE_TONE[status] ?? 'slate'}>{status ? label(status) : 'Unknown offline'}</Badge>{record.review_remarks && <span className="ml-2 text-slate-600">{record.review_remarks}</span>}</p>;
  if (!allowed) return current;

  const decide = async (to) => {
    const out = await run(to, () => onReview(to, remarks), `Marked ${label(to).toLowerCase()}.`);
    if (out) {
      setRemarks('');
      onDone?.(out);
    }
  };

  return (
    <div className="space-y-3">
      {current}
      <ErrorNote error={error} />
      <Field label="Review remarks" hint="Optional, up to 500 characters">
        <textarea className="input h-20 py-3" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <OnlineButton reason={ONLINE_ONLY.review} className="btn-primary h-10 text-sm" disabled={!!busy || status === 'verified'} onClick={() => decide('verified')}>
          {busy === 'verified' && <Spinner />} Verify
        </OnlineButton>
        <OnlineButton className="btn-secondary text-red-700" disabled={!!busy || status === 'rejected'} onClick={() => decide('rejected')}>
          {busy === 'rejected' && <Spinner />} Reject
        </OnlineButton>
      </div>
    </div>
  );
}
