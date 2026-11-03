import { useState } from 'react';
import Logo from '../components/Logo.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { AlertIcon, Spinner } from '../components/Icons.jsx';
import { useSession } from '../app/session.jsx';

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/invalid-login-credentials': 'Incorrect email or password.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Try again later.',
  'auth/network-request-failed': 'No connection. Signing in needs internet the first time.',
};

export default function Login() {
  const { signIn, configError } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(AUTH_MESSAGES[err.code] ?? err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-teal-50 to-white px-4 py-10">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-xl font-bold">Sign in</h1>
            <p className="text-sm text-slate-500">Swachh Safar operations</p>
          </div>
        </div>
        {(error || configError) && (
          <p className="flex gap-2 rounded-2xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200" role="alert">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> {error ?? configError}
          </p>
        )}
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        <button type="submit" className="btn-primary w-full" disabled={busy || !email || !password}>{busy && <Spinner />} Sign in</button>
        <p className="text-center text-sm text-slate-500">New user? <a className="btn-link" href="#/register">Register</a></p>
      </form>
    </div>
  );
}
