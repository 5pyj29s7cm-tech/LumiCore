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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryLocalBackend(url: string, error: unknown): boolean {
  if (!url.startsWith(LOCAL_BACKEND_ORIGIN)) return false;
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
  const attempts = url.startsWith(LOCAL_BACKEND_ORIGIN) ? 10 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, request);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !shouldRetryLocalBackend(url, error)) break;
      await sleep(Math.min(250 + attempt * 350, 1500));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to reach the Lumi local server');
}
