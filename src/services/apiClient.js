// Central client for the FastAPI backend (/api/v1). Every request carries the signed-in user's
// Firebase ID token; errors surface the backend's error code so screens can show it honestly.
export const API_BASE = (import.meta.env?.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  // Network failures and 5xx/429 are worth retrying; 4xx means the request itself is wrong.
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function errorMessage(body, status) {
  const err = body?.error ?? body;
  if (typeof err?.message === 'string') return err.message;
  if (Array.isArray(err?.detail)) return err.detail.map((d) => `${d.loc?.slice(1).join('.')}: ${d.msg}`).join('; ');
  if (typeof err?.detail === 'string') return err.detail;
  return `Request failed (HTTP ${status})`;
}

export function createApiClient({ getToken, base = API_BASE, fetchImpl = (...a) => fetch(...a) }) {
  async function request(method, path, { body, query, raw, headers = {} } = {}) {
    const url = new URL(base + path, typeof location !== 'undefined' ? location.origin : 'http://localhost');
    Object.entries(query ?? {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const token = await getToken();
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch (e) {
      throw new ApiError(0, 'network_error', 'Cannot reach the Swachh Safar server.', e?.message);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = data?.error ?? data;
      if (res.status === 404 && !err?.code) {
        throw new ApiError(404, 'endpoint_unavailable', `Endpoint not available on the server: ${method} ${path}`);
      }
      throw new ApiError(res.status, err?.code ?? `http_${res.status}`, errorMessage(data, res.status), err);
    }
    return data;
  }

  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, query) => request('POST', path, { body, query }),
    patch: (path, body) => request('PATCH', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    del: (path) => request('DELETE', path),
    putRaw: (path, raw, contentType) => request('PUT', path, { raw, headers: { 'Content-Type': contentType } }),
  };
}
