import { createContext, useContext, useEffect, useState } from 'react';
import Logo from '../components/Logo.jsx';
import Toasts, { useToasts } from '../components/Toasts.jsx';
import {
  BoxIcon, ChartIcon, ChatIcon, ClipboardIcon, DatabaseGridIcon, FlagIcon, HomeIcon, LogoutIcon, MenuIcon, RefreshIcon,
  Spinner, TrainIcon, UsersIcon, XIcon,
} from '../components/Icons.jsx';
import { useNetworkStatus } from '../hooks/useNetworkStatus.js';
import { ROLE_NAMES, useQueueState, useSession } from './session.jsx';
import { MODULES } from './modules.js';
import { DEMO_MODE } from '../services/demoApi.js';
import { InstallBanner, UpdateBanner } from '../components/PwaPanels.jsx';
import { requestPersistence } from '../pwa/pwaState.js';

const ToastContext = createContext(() => {});
export const useNotify = () => useContext(ToastContext);

const ICONS = {
  dashboard: HomeIcon, journeys: TrainIcon, attendance: UsersIcon, inspections: ClipboardIcon, feedback: ChatIcon,
  complaints: FlagIcon, inventory: BoxIcon, masters: DatabaseGridIcon, reports: ChartIcon,
};

// Navigation is the module registry (src/app/modules.js) with an icon per module.
export const NAV = MODULES.map((m) => ({ ...m, Icon: ICONS[m.key] }));

export const visibleNav = (can) => NAV.filter((n) => !n.any.length || n.any.some(can));

function NavList({ items, active, onPick }) {
  return (
    <nav className="space-y-1">
      {items.map(({ path, label, Icon }) => {
        const on = path === '/' ? active === '/' : active.startsWith(path);
        return (
          <a key={path} href={`#${path}`} onClick={onPick}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${on ? 'bg-teal-700 text-white shadow-sm' : 'text-slate-600 hover:bg-teal-50 hover:text-teal-800'}`}>
            <Icon className="h-5 w-5" /> {label}
          </a>
        );
      })}
    </nav>
  );
}

function QueueIndicator() {
  const q = useQueueState();
  const { queue } = useSession();
  // Records captured by another user of this device sync only when that user signs in again.
  const others = q.othersPending ? <span className="text-xs text-slate-500" data-testid="ops-queue-others"> · {q.othersPending} waiting for another user</span> : null;
  if (!q.pending && !q.failed.length) return <span className="text-xs text-slate-500">All records synced{others}</span>;
  return (
    <button type="button" onClick={() => (q.failed.length ? queue.retryFailed() : queue.flush())}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${q.failed.length ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-amber-50 text-amber-800 ring-amber-200'}`}
      title={q.lastError ?? 'Tap to sync now'} data-testid="ops-queue">
      {q.running ? <Spinner className="h-3 w-3" /> : <RefreshIcon className="h-3 w-3" />}
      {q.pending ? `${q.pending} pending` : ''}{q.pending && q.failed.length ? ' · ' : ''}{q.failed.length ? `${q.failed.length} failed` : ''}
    </button>
  );
}

// Browser connectivity is not server connectivity: "Online" only when the last exchange with the server
// worked; a failed pull while the network is up shows as a server problem.
function ConnectionIndicator({ online }) {
  const q = useQueueState();
  const [tone, text, title] = !online ? ['amber', 'Offline', 'No network. Records are saved on this device.']
    : q.running || q.pulling ? ['sky', 'Syncing…', 'Exchanging records with the server']
      : q.pullError || (q.lastError && q.pending) ? ['red', 'Server unreachable', q.pullError ?? q.lastError]
        : ['emerald', 'Online', q.lastPullAt ? 'Connected to the server' : 'Network available'];
  const dot = { amber: 'bg-amber-500', sky: 'bg-sky-500', red: 'bg-red-500', emerald: 'bg-emerald-500' }[tone];
  const color = { amber: 'text-amber-700', sky: 'text-sky-700', red: 'text-red-700', emerald: 'text-emerald-700' }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${color}`} title={title} role="status" data-testid="connection-status">
      <span className={`h-2 w-2 rounded-full ${dot}`} /> {text}
    </span>
  );
}

export default function Layout({ path, children }) {
  const { user, can, signOut, me } = useSession();
  const online = useNetworkStatus();
  // The SQLite database lives in OPFS: ask the browser not to evict it once a user works on this device.
  useEffect(() => {
    requestPersistence().catch(() => {});
  }, []);
  const { toasts, notify, dismiss } = useToasts();
  const [open, setOpen] = useState(false);
  const items = visibleNav(can);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-2 pb-6">
        <Logo className="h-9 w-9" />
        <div>
          <p className="text-sm font-bold text-slate-900">Swachh Safar</p>
          <p className="text-xs text-slate-500">Inspection management</p>
        </div>
      </div>
      <NavList items={items} active={path} onPick={() => setOpen(false)} />
      <div className="mt-auto rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <p className="truncate text-sm font-semibold">{user.name}</p>
        <p className="text-xs text-slate-500">{ROLE_NAMES[user.role_id]} · {user.emp_id}</p>
        <button type="button" className="btn-link mt-2 inline-flex items-center gap-1" onClick={signOut}><LogoutIcon /> Sign out</button>
      </div>
    </div>
  );

  return (
    <ToastContext.Provider value={notify}>
      <div className="min-h-dvh bg-slate-50">
        <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-4 lg:block">{sidebar}</aside>
        {open && (
          <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)}>
            <aside className="h-full w-72 bg-white p-4" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="mb-2 ml-auto block rounded-lg p-1 text-slate-500" onClick={() => setOpen(false)} aria-label="Close menu"><XIcon className="h-5 w-5" /></button>
              {sidebar}
            </aside>
          </div>
        )}
        <div className="lg:pl-64">
          <header className="sticky top-0 z-20 flex min-h-14 items-center pt-[env(safe-area-inset-top)] gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
            <button type="button" className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
              <MenuIcon className="h-5 w-5" />
            </button>
            <span className="font-semibold text-teal-800 lg:hidden">Swachh Safar</span>
            <div className="ml-auto flex items-center gap-3">
              <QueueIndicator />
              <ConnectionIndicator online={online} />
            </div>
          </header>
          {DEMO_MODE && (
            <p className="bg-fuchsia-700 px-4 py-2 text-center text-xs font-semibold text-white sm:px-6" role="status" data-testid="demo-banner">
              DEMO MODE — sample data only, not real operational records. Changes are not sent to any server.
            </p>
          )}
          <UpdateBanner />
          <InstallBanner />
          {me.offline && <p className="bg-amber-50 px-4 py-2 text-xs text-amber-900 sm:px-6">Signed in offline with your cached profile. Permissions will refresh when you reconnect.</p>}
          <main className="mx-auto max-w-6xl px-4 py-5 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-6 lg:pb-8">{children}</main>
          <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
            {items.slice(0, 5).map(({ path: p, label, Icon }) => {
              const on = p === '/' ? path === '/' : path.startsWith(p);
              return (
                <a key={p} href={`#${p}`} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${on ? 'text-teal-700' : 'text-slate-500'}`}>
                  <Icon className="h-5 w-5" /> <span className="truncate">{label.split(' ')[0]}</span>
                </a>
              );
            })}
          </nav>
        </div>
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    </ToastContext.Provider>
  );
}
