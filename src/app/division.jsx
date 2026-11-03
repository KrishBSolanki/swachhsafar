// The division a manager is currently looking at. Field staff normally have exactly one.
import { useEffect, useState } from 'react';
import { useResource, useSession } from './session.jsx';

const KEY = 'swachh.division';

export function useDivision() {
  const { divisions } = useSession();
  const res = useResource('/divisions');
  const [id, setId] = useState(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const valid = id && divisions.includes(id) ? id : divisions[0] ?? null;
  useEffect(() => {
    try {
      if (valid) localStorage.setItem(KEY, valid);
    } catch { /* storage unavailable */ }
  }, [valid]);
  const list = res.data ?? divisions.map((d) => ({ id: d, name: d.slice(0, 8), code: '' }));
  return { divisionId: valid, setDivisionId: setId, divisions: list, current: list.find((d) => d.id === valid) };
}

export function DivisionPicker({ division }) {
  if (division.divisions.length < 2) return null;
  return (
    <select className="input h-10 w-auto text-sm" value={division.divisionId ?? ''} onChange={(e) => division.setDivisionId(e.target.value)} aria-label="Division">
      {division.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
}
