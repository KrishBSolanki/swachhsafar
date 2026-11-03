import { useEffect, useRef, useState } from 'react';
import Logo from '../components/Logo.jsx';
import NetworkStatus from '../components/NetworkStatus.jsx';
import RegistrationForm from '../components/RegistrationForm.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import PasswordPromptDialog from '../components/PasswordPromptDialog.jsx';
import Toasts, { useToasts } from '../components/Toasts.jsx';
import { AlertIcon, CheckIcon, ClockIcon } from '../components/Icons.jsx';
import { useLocalDatabase } from '../hooks/useLocalDatabase.js';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import { useSyncStatus } from '../hooks/useSyncStatus.js';
import { useFirebaseStatus } from '../hooks/useFirebaseStatus.js';
import { RegistrationError } from '../services/registrationService.js';

export const MESSAGES = {
  savedOffline: 'Registration saved locally. Waiting for internet synchronization.',
  synced: 'Registration complete. Your Swachh Safar cloud account and profile have been created.',
};

const BANNER_STYLES = {
  success: { cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200', Icon: CheckIcon },
  pending: { cls: 'bg-amber-50 text-amber-900 ring-amber-200', Icon: ClockIcon },
  error: { cls: 'bg-red-50 text-red-800 ring-red-200', Icon: AlertIcon },
};

function StatusBanner({ banner }) {
  if (!banner) return null;
  const { cls, Icon } = BANNER_STYLES[banner.tone];
  return (
    <div role="status" data-testid="registration-status" data-tone={banner.tone}
      className={`flex gap-3 rounded-2xl p-4 text-sm ring-1 ${cls}`}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <p>{banner.message}</p>
    </div>
  );
}

function bannerForSyncResult(result) {
  if (result?.status === 'synced') return { tone: 'success', message: MESSAGES.synced };
  if (result?.status === 'failed') return { tone: 'error', message: `Saved on this device, but cloud registration failed: ${result.message}` };
  if (result?.status === 'retry') {
    return { tone: 'pending', message: `Registration saved locally. Cloud sync failed (${result.message}) and will be retried automatically.` };
  }
  return { tone: 'pending', message: MESSAGES.savedOffline };
}

export default function Register() {
  const db = useLocalDatabase();
  const online = useNetworkStatus();
  const syncService = db.services?.sync;
  const sync = useSyncStatus(syncService);
  const firebase = useFirebaseStatus(online, sync.lastSyncAt);
  const { toasts, notify, dismiss } = useToasts();
  const [banner, setBanner] = useState(null);
  const [promptUser, setPromptUser] = useState(null);
  const dismissedPrompts = useRef(new Set());
  const lastSyncSeen = useRef(undefined);

  // Ask for the password of the first offline registration still waiting for one.
  useEffect(() => {
    if (!online || promptUser) return;
    const id = sync.needsPassword.find((uid) => !dismissedPrompts.current.has(uid));
    const user = id && sync.users.find((u) => u.id === id);
    if (user) setPromptUser(user);
  }, [online, sync.needsPassword, sync.users, promptUser]);

  // Toast when a background sync (reconnect / retry / foreground) completes.
  useEffect(() => {
    if (!sync.loaded) return;
    if (lastSyncSeen.current !== undefined && sync.lastSyncAt !== lastSyncSeen.current) {
      notify('success', 'Synchronization completed.');
    }
    lastSyncSeen.current = sync.lastSyncAt;
  }, [sync.loaded, sync.lastSyncAt, notify]);

  async function handleRegister({ email, password }) {
    let user;
    try {
      user = await db.services.registration.register({ email, password });
    } catch (e) {
      if (e instanceof RegistrationError) {
        if (e.code === 'duplicate') setBanner({ tone: 'error', message: e.message });
        return { fieldErrors: e.fieldErrors };
      }
      setBanner({ tone: 'error', message: `Could not save the registration on this device: ${e.message}` });
      return { ok: false };
    }

    await syncService.refresh();
    if (!online) {
      setBanner({ tone: 'pending', message: MESSAGES.savedOffline });
      notify('info', 'Saved on this device.');
      return { ok: true };
    }
    setBanner({ tone: 'pending', message: 'Saved on this device. Creating your cloud account…' });
    const result = await syncService.syncNewRegistration(user.id, password);
    setBanner(bannerForSyncResult(result));
    if (result?.status === 'synced') {
      lastSyncSeen.current = syncService.getState().lastSyncAt; // banner already says so; skip the toast
      notify('success', 'Cloud account created.');
    }
    return { ok: true };
  }

  async function handlePasswordSubmit(user, password) {
    const response = await syncService.provideCredential(user.id, password);
    if (!response.ok) return "That password doesn't match the one used when registering on this device.";
    const result = response.result;
    setPromptUser(null);
    dismissedPrompts.current.add(user.id);
    if (result?.status === 'synced') {
      lastSyncSeen.current = syncService.getState().lastSyncAt;
      setBanner({ tone: 'success', message: MESSAGES.synced });
      notify('success', `Synchronization completed for ${user.email}.`);
    } else if (result?.status === 'failed') {
      setBanner({ tone: 'error', message: result.message });
      notify('error', 'Cloud registration failed.');
    } else {
      notify('warning', result?.message ?? 'Sync is pending and will be retried.');
    }
    return null;
  }

  async function handleRetry(user) {
    await syncService.retry(user.id);
    dismissedPrompts.current.delete(user.id);
    setPromptUser(user);
  }

  return (
    <div className="min-h-dvh bg-gradient-to-b from-teal-50/70 via-white to-white">
      <header className="mx-auto flex max-w-md items-center justify-between px-4 pt-6 pb-2">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <p className="text-lg font-bold tracking-tight text-slate-900">Swachh Safar</p>
            <p className="text-xs text-slate-500">Clean journeys, together</p>
          </div>
        </div>
        <NetworkStatus online={online} />
      </header>

      <main className="mx-auto max-w-md space-y-4 px-4 pt-4 pb-24">
        <section className="card space-y-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Create your account</h1>
            <p className="mt-1 text-sm text-slate-600">
              Works offline. Your registration is saved securely on this device and synced when you&apos;re online.
            </p>
          </div>
          <StatusBanner banner={banner} />
          {db.status === 'error' && (
            <StatusBanner banner={{ tone: 'error', message: `Registration is disabled: the local database could not start. ${db.error?.message}` }} />
          )}
          <RegistrationForm onRegister={handleRegister} disabled={db.status !== 'ready'} />
          <p className="text-center text-sm text-slate-500">
            Already registered? <a className="btn-link" href="#/login">Sign in to operations</a>
          </p>
        </section>

        <SyncStatus
          db={db}
          sync={sync}
          firebase={firebase}
          online={online}
          onSyncNow={() => syncService?.sync({ trigger: 'manual' })}
          onEnterPassword={(user) => { dismissedPrompts.current.delete(user.id); setPromptUser(user); }}
          onRetry={handleRetry}
        />
      </main>

      <PasswordPromptDialog
        user={promptUser}
        onSubmit={handlePasswordSubmit}
        onClose={() => { dismissedPrompts.current.add(promptUser.id); setPromptUser(null); }}
      />
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
