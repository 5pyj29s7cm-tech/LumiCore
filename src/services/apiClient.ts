import { getBackendOrigin } from './apiBridge';

const LOCAL_BACKEND_ORIGIN = 'http://127.0.0.1:3000';

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${getBackendOrigin()}${normalized}`;
}

function withAuthHeaders(headers?: HeadersInit): HeadersInit {
  const next = new Headers(headers);
  try {
    const token = localStorage.getItem('lumi_auth_token');
    if (token && !next.has('Authorization')) {
      next.set('Authorization', `Bearer ${token}`);
    }
    const desktopSessionProof = localStorage.getItem('lumi_desktop_session_proof');
    if (desktopSessionProof && !next.has('x-lumi-desktop-session')) {
      next.set('x-lumi-desktop-session', desktopSessionProof);
    }
  } catch {}
  return next;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function isLocalBackend(url: string): boolean {
  try { return new URL(url).origin === LOCAL_BACKEND_ORIGIN; } catch { return false; }
}

function shouldRetryLocalBackend(url: string, error: unknown): boolean {
  if (!isLocalBackend(url)) return false;
  const message = error instanceof Error ? error.message : String(error || '');
  return /failed to fetch|networkerror|load failed|fetch/i.test(message);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiUrl(path);
  const request: RequestInit = {
    credentials: 'include',
    ...init,
    headers: withAuthHeaders(init.headers),
  };
  // A failed response does not prove that a write failed. Retrying POST/PUT/
  // DELETE can repeat a completed action, so only safe reads retry startup.
  const method = String(request.method || 'GET').toUpperCase();
  const attempts = isLocalBackend(url) && ['GET', 'HEAD'].includes(method) ? 10 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      throwIfAborted(request.signal);
      return await fetch(url, request);
    } catch (error) {
      lastError = error;
      throwIfAborted(request.signal);
      if (attempt >= attempts - 1 || !shouldRetryLocalBackend(url, error)) break;
      await sleep(Math.min(250 + attempt * 350, 1500), request.signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to reach the Lumi local server');
}

/** A confirmed API result; rejected writes must never become local success. */
export async function apiJson<T = Record<string, any>>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok || data?.ok === false || data?.success === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data as T;
}
