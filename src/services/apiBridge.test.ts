import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackendOrigin, getSocketOrigin, installApiBridge } from './apiBridge';
import { apiFetch } from './apiClient';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function runtime(url: string, native = true) {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  const win = {
    location: new URL(url),
    fetch,
    ...(native ? { __TAURI_INTERNALS__: {} } : {}),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => ({
      lumi_auth_token: 'test-account-token',
      lumi_desktop_session_proof: 'test-session-proof',
    })[name] ?? null,
  });
  return { win, fetch };
}

describe('backend origin isolation', () => {
  it.each(['http://127.0.0.1:3016', 'http://localhost:3016', 'http://[::1]:3016'])(
    'keeps the native development UI, API and sockets on %s', origin => {
      runtime(origin);
      expect(getBackendOrigin()).toBe(origin);
      installApiBridge();
      expect(getBackendOrigin()).toBe(origin);
      expect(getSocketOrigin()).toBe(origin);
    },
  );

  it.each(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])(
    'uses the bundled backend for packaged URL %s', url => {
      runtime(url);
      installApiBridge();
      expect(getBackendOrigin()).toBe('http://127.0.0.1:3000');
    },
  );

  it('preserves browser deployment origin after bridge installation', () => {
    runtime('https://client.example.test', false);
    installApiBridge();
    expect(getBackendOrigin()).toBe('https://client.example.test');
  });

  it('routes a settings save and legacy relative requests to the lawyer backend', async () => {
    const { win, fetch } = runtime('http://127.0.0.1:3016');
    installApiBridge();
    vi.stubGlobal('fetch', win.fetch);
    await apiFetch('/api/settings/keys', { method: 'POST', body: '{}' });
    await win.fetch('/api/settings/keys');
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe('http://127.0.0.1:3016/api/settings/keys');
      expect(options.credentials).toBe('include');
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-account-token');
      expect(new Headers(options.headers).get('x-lumi-desktop-session')).toBe('test-session-proof');
    }
  });

  it.each(['http://127.0.0.1:3000', 'http://127.0.0.1:30160', 'https://external.example.test'])(
    'does not attach the lawyer session to a different origin: %s', origin => {
      const { fetch } = runtime('http://127.0.0.1:3016');
      vi.stubGlobal('fetch', fetch);
      return apiFetch(`${origin}/api/health`).then(() => {
        const [, options] = fetch.mock.calls[0];
        expect(new Headers(options.headers).has('Authorization')).toBe(false);
        expect(new Headers(options.headers).has('x-lumi-desktop-session')).toBe(false);
        expect(options.credentials).toBe('same-origin');
      });
    },
  );

  it('retries startup reads on the active variant port', async () => {
    vi.useFakeTimers();
    const { fetch } = runtime('http://127.0.0.1:3016');
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    const pending = apiFetch('/api/health');
    await vi.advanceTimersByTimeAsync(250);
    expect((await pending).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
