// Installed-app UI: the install banner, the "new version" banner and the offline readiness panel.
import { useEffect, useState } from 'react';
import { useQueueState, useSession } from '../app/session.jsx';
import { dismissInstall, installDismissed, isAndroid, isStandalone, promptInstall, pwa, requestPersistence, storageStatus, usePwa } from '../pwa/pwaState.js';
import { Badge, Panel, fmtDateTime } from './ui.jsx';

const MB = (n) => (n == null ? '—' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

// Shown at most once per 30 days, only when Chrome offers installation and the app is not installed.
export function InstallBanner() {
  const { installEvent } = usePwa();
  const [hidden, setHidden] = useState(installDismissed);
  if (!installEvent || hidden || isStandalone()) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-teal-700 px-4 py-2 text-sm text-white sm:px-6" role="region" aria-label="Install app" data-testid="install-banner">
      <span className="flex-1">Install Swachh Safar on this device for full-screen use and offline start.</span>
      <button type="button" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-teal-800" onClick={promptInstall}>Install</button>
      <button type="button" className="text-white/80 underline" onClick={() => { dismissInstall(); setHidden(true); }}>Not now</button>
    </div>
  );
}

export function UpdateBanner() {
  const { updateReady } = usePwa();
  const { pending } = useQueueState();
  if (!updateReady) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-sky-700 px-4 py-2 text-sm text-white sm:px-6" role="status" data-testid="update-banner">
      <span className="flex-1">
        A new version of Swachh Safar is ready. {pending ? `Your ${pending} unsynced record(s) are stored on this device and are kept.` : ''} Save any open form first.
      </span>
      <button type="button" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-sky-800" onClick={pwa.update}>Update now</button>
    </div>
  );
}

function Check({ ok, warn, title, children }) {
  const tone = ok ? 'green' : warn ? 'amber' : 'red';
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{title}</p>
        {children && <p className="text-xs text-slate-500">{children}</p>}
      </div>
      <Badge tone={tone}>{ok ? 'Ready' : warn ? 'Attention' : 'Not ready'}</Badge>
    </li>
  );
}

// What this device needs before it can be used without a network, and whether it has it.
export function OfflineReadiness() {
  const { me } = useSession();
  const q = useQueueState();
  const { controlled, offlineReady, installEvent } = usePwa();
  const [storage, setStorage] = useState(null);
  const standalone = isStandalone();

  useEffect(() => {
    let off = false;
    storageStatus().then((s) => !off && setStorage(s));
    return () => {
      off = true;
    };
  }, []);

  const persist = async () => {
    await requestPersistence();
    setStorage(await storageStatus());
  };
  const shell = controlled || offlineReady || !!navigator.serviceWorker?.controller;
  const pulled = !!q.lastPullAt;
  const ready = shell && pulled;

  return (
    <Panel title="Offline readiness" actions={<Badge tone={ready ? 'green' : 'amber'}>{ready ? 'Ready for offline use' : 'Setup incomplete'}</Badge>}>
      <ul className="divide-y divide-slate-100" data-testid="offline-readiness">
        <Check ok={shell} title="App available offline">
          {shell ? 'The app itself is stored on this device and starts without internet.' : 'Open the app once while online so it can be stored on this device.'}
        </Check>
        <Check ok title="Profile cached for offline sign-in">
          {me.offline ? 'Signed in offline with your cached profile. Permissions refresh when you reconnect.' : 'Signed in online; your profile and permissions are cached on this device.'}
        </Check>
        <Check ok={pulled} warn={!pulled} title="Master data and journeys downloaded">
          {pulled ? `Last synchronized ${fmtDateTime(q.lastPullAt)}.` : 'Not downloaded yet. Connect to the internet to download your divisions, trains, journeys and question banks.'}
          {q.pullError ? ` Last attempt failed: ${q.pullError}` : ''}
        </Check>
        <Check ok={storage?.persisted} warn={!storage?.persisted} title="Persistent device storage">
          {!storage ? 'Checking…' : !storage.supported ? 'This browser does not report storage persistence.'
            : `${storage.persisted ? 'Granted: the browser will not evict this data under storage pressure.' : 'Not granted: the browser may remove data when the device runs low on space.'} Using ${MB(storage.usage)} of ${MB(storage.quota)}. Clearing site data or uninstalling the app still deletes it.`}
          {storage && storage.supported && !storage.persisted && <> <button type="button" className="btn-link text-xs" onClick={persist}>Request</button></>}
        </Check>
        <Check ok={!q.pending && !q.failed.length} warn={!q.failed.length} title="Records waiting to sync">
          {q.pending || q.failed.length ? `${q.pending} pending, ${q.failed.length} rejected by the server.` : 'Everything you recorded has reached the server.'}
          {q.othersPending ? ` ${q.othersPending} record(s) of another user wait for that user to sign in.` : ''}
        </Check>
        <Check ok={standalone} warn={!standalone} title="Installed as an app">
          {standalone ? 'Running as an installed app.'
            : installEvent ? <>Not installed. <button type="button" className="btn-link text-xs" onClick={promptInstall}>Install now</button></>
              : isAndroid() ? 'Not installed. In Chrome, open the ⋮ menu and choose “Install app” (or “Add to Home screen”).'
                : 'Not installed. Use the browser’s install option (address bar or menu) to install Swachh Safar.'}
        </Check>
      </ul>
    </Panel>
  );
}
