import { useId, useState } from 'react';
import { EyeIcon, EyeOffIcon } from './Icons.jsx';
import { passwordStrength } from '../utils/validation.js';

const METER_COLORS = ['bg-slate-200', 'bg-red-500', 'bg-amber-500', 'bg-lime-500', 'bg-emerald-600'];

export default function PasswordInput({
  label = 'Password', value, onChange, error, showStrength = false, autoComplete = 'new-password', autoFocus, disabled,
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const { score, label: strengthLabel } = passwordStrength(value);

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`input pr-12 ${error ? 'input-error' : ''}`}
          placeholder="At least 8 characters"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-2xl text-slate-500 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-teal-600"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
        </button>
      </div>
      {showStrength && value && (
        <div className="mt-2 flex items-center gap-2" aria-live="polite">
          <div className="flex flex-1 gap-1">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= score ? METER_COLORS[score] : 'bg-slate-200'}`} />
            ))}
          </div>
          <span className="w-16 text-right text-xs text-slate-500">{strengthLabel}</span>
        </div>
      )}
      {error && <p id={`${id}-error`} className="mt-1.5 text-sm text-red-600">{error}</p>}
    </div>
  );
}
