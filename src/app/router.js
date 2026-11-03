// Minimal hash router: works offline from the service-worker shell with no server rewrites.
import { useEffect, useState } from 'react';

const current = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];

export function navigate(to) {
  location.hash = to;
}

export function useRoute() {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const on = () => setPath(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return { path, parts: path.split('/').filter(Boolean) };
}
