// Shows a photo, video, voice recording or attachment of an operational record.
//
// Media captured on this device is read from device storage (OPFS, via the media store) and checked
// against its stored checksum, so it shows offline and before it is uploaded. Anything else comes from
// the server: GET /media/{id}/download, then the file itself (with the user's token when the API serves
// it, or the signed storage URL). Server media is not stored on the device.
import { useEffect, useState } from 'react';
import { useSession } from '../app/session.jsx';
import { API_BASE } from '../services/apiClient.js';
import { Spinner } from './Icons.jsx';

const toBlobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }));

// { url, type, source: 'device' | 'server', revoke } for media `id`, or throws.
export async function loadMedia({ id, store, api, permissions }) {
  const local = await store?.media.read(id).catch(() => null);
  if (local?.bytes && local.intact && permissions?.[local.meta.division_id]) {
    const url = toBlobUrl(local.bytes, local.meta.mime_type);
    return { url, type: local.meta.mime_type, source: 'device', revoke: () => URL.revokeObjectURL(url) };
  }
  const link = await api.get(`/media/${id}/download`);
  const base = new URL(API_BASE, location.origin).pathname.replace(/\/$/, '');
  const target = new URL(link.url, location.origin);
  if (target.origin === location.origin && target.pathname.startsWith(`${base}/`)) {
    const blob = await api.getBlob(target.pathname.slice(base.length) + target.search);
    const url = URL.createObjectURL(blob);
    return { url, type: blob.type, source: 'server', revoke: () => URL.revokeObjectURL(url) };
  }
  return { url: link.url, type: null, source: 'server', revoke: () => {} };
}

// `kind`: 'image' | 'video' | 'audio' | 'file' (how to present it).
export default function MediaPreview({ id, kind = 'image', label = 'Evidence' }) {
  const { store, api, me } = useSession();
  const [state, setState] = useState({ loading: true, media: null, error: null });

  useEffect(() => {
    if (!id) return undefined;
    let current = null;
    let cancelled = false;
    setState({ loading: true, media: null, error: null });
    loadMedia({ id, store, api, permissions: me?.divisions })
      .then((media) => {
        current = media;
        if (cancelled) media.revoke();
        else setState({ loading: false, media, error: null });
      })
      .catch((error) => !cancelled && setState({ loading: false, media: null, error }));
    return () => {
      cancelled = true;
      current?.revoke();
    };
  }, [id, store, api, me?.divisions]);

  if (!id) return null;
  if (state.loading) return <p className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading {label.toLowerCase()}…</p>;
  if (state.error) {
    const offline = state.error.status === 0;
    return (
      <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
        {label}: {offline ? 'stored on the server only — available when online.' : state.error.message}
      </p>
    );
  }
  const { url, source } = state.media;
  const note = <span className="mt-1 block text-xs text-slate-500">{label} · {source === 'device' ? 'stored on this device' : 'from server'}</span>;
  if (kind === 'video') return <figure><video src={url} controls className="max-h-72 w-full rounded-2xl bg-black" />{note}</figure>;
  if (kind === 'audio') return <figure><audio src={url} controls className="w-full" />{note}</figure>;
  if (kind === 'file') return <a className="btn-link" href={url} target="_blank" rel="noreferrer">Open {label.toLowerCase()}{note}</a>;
  return <figure><img src={url} alt={label} className="max-h-72 w-full rounded-2xl object-contain ring-1 ring-slate-200" />{note}</figure>;
}
