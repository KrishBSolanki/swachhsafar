import { useResource, useSession } from '../app/session.jsx';
import { navigate } from '../app/router.js';
import { Badge, DataState, Panel, fmtDate } from './ui.jsx';

// Active journeys the user works on; screens route to `${base}/${journeyId}` on pick.
export default function JourneyPicker({ base, title = 'Select an active journey' }) {
  const { can } = useSession();
  const res = useResource('/journeys', { state: 'active', mine: !can('journeys.read_all'), page_size: 100 });
  return (
    <Panel title={title}>
      <DataState res={res} empty="No active journeys are assigned to you.">
        {(page) => (
          <ul className="grid gap-2 sm:grid-cols-2">
            {page.items.map((j) => (
              <li key={j.id}>
                <button type="button" onClick={() => navigate(`${base}/${j.id}`)}
                  className="w-full rounded-2xl p-4 text-left ring-1 ring-slate-200 transition hover:bg-teal-50/50 hover:ring-teal-300">
                  <div className="flex items-center justify-between"><span className="font-semibold">{j.train_no}</span><Badge tone="green">Active</Badge></div>
                  <p className="text-sm text-slate-600">{j.train_name}</p>
                  <p className="mt-1 text-xs text-slate-500">{fmtDate(j.journey_date)} → {fmtDate(j.end_date)} · {j.coaches.length} coaches</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DataState>
    </Panel>
  );
}
