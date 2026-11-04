// Runs one server action for a screen: busy flag, error kept for display, toast on success.
import { useCallback, useState } from 'react';
import { useNotify } from '../app/Layout.jsx';

export function useAction() {
  const notify = useNotify();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  // Resolves to the action's result, or null when it failed (the error is in `error`).
  const run = useCallback(async (name, fn, success) => {
    setBusy(name);
    setError(null);
    try {
      const out = await fn();
      if (success) notify('success', success);
      return out ?? true;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }, [notify]);

  return { busy, error, run, clearError: () => setError(null) };
}
