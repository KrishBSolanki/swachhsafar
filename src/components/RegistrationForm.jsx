import { useState } from 'react';
import PasswordInput from './PasswordInput.jsx';
import { Spinner } from './Icons.jsx';
import { validateRegistration } from '../utils/validation.js';

// Collects email + password and hands them to onRegister. Field errors returned by onRegister
// (e.g. duplicate email) are shown inline.
export default function RegistrationForm({ onRegister, disabled }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    const check = validateRegistration({ email, password });
    setErrors(check.errors);
    if (!check.valid) return;

    setSubmitting(true);
    try {
      const outcome = await onRegister({ email, password });
      if (outcome?.fieldErrors) setErrors(outcome.fieldErrors);
      if (outcome?.ok) {
        setEmail('');
        setPassword('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || disabled;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-label="Registration form">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-slate-700">Username / Email</label>
        <input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck="false"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'email-error' : undefined}
          className={`input ${errors.email ? 'input-error' : ''}`}
          placeholder="you@example.com"
        />
        {errors.email && <p id="email-error" className="mt-1.5 text-sm text-red-600">{errors.email}</p>}
      </div>

      <PasswordInput value={password} onChange={setPassword} error={errors.password} showStrength disabled={busy} />

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {submitting ? (<><Spinner className="h-5 w-5" /> Registering…</>) : 'Register'}
      </button>
    </form>
  );
}
