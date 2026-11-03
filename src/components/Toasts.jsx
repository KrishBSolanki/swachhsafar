import { useCallback, useState } from 'react';

const TONES = {
  success: 'bg-emerald-600 text-white',
  info: 'bg-slate-800 text-white',
  warning: 'bg-amber-500 text-slate-900',
  error: 'bg-red-600 text-white',
};

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const notify = useCallback((tone, message) => {
    const id = crypto.randomUUID();
    setToasts((list) => [...list.slice(-2), { id, tone, message }]);
    setTimeout(() => dismiss(id), 5000);
  }, [dismiss]);
  return { toasts, notify, dismiss };
}

export default function Toasts({ toasts, onDismiss }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto w-full max-w-md rounded-2xl px-4 py-3 text-left text-sm font-medium shadow-lg ${TONES[t.tone]}`}
          data-testid="toast"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
