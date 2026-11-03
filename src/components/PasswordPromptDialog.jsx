import { useEffect, useRef, useState } from 'react';
import PasswordInput from './PasswordInput.jsx';
import { Spinner } from './Icons.jsx';

// Asks for the password of a registration saved offline so the Firebase account can be created.
// The password is verified against the local hash by the sync service and never stored.
export default function PasswordPromptDialog({ user, onSubmit, onClose }) {
  const dialogRef = useRef(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (user && !dialog.open) dialog.showModal();
    if (!user && dialog.open) dialog.close();
    setPassword('');
    setError(null);
  }, [user]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!password) return setError('Enter your password.');
    setBusy(true);
    setError(null);
    try {
      const message = await onSubmit(user, password);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-3xl p-0 shadow-2xl backdrop:bg-slate-900/40"
      aria-labelledby="password-prompt-title"
    >
      {user && (
        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div>
            <h2 id="password-prompt-title" className="text-lg font-semibold text-slate-900">Finish cloud registration</h2>
            <p className="mt-1 text-sm text-slate-600">
              You&apos;re back online. Enter the password you chose for <strong className="break-all">{user.email}</strong> to
              create your Swachh Safar cloud account.
            </p>
          </div>
          <PasswordInput label="Password" value={password} onChange={setPassword} error={error}
            autoComplete="current-password" autoFocus disabled={busy} />
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1 justify-center" onClick={onClose} disabled={busy}>Later</button>
            <button type="submit" className="btn-primary flex-1" disabled={busy}>
              {busy ? (<><Spinner /> Syncing…</>) : 'Sync account'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
