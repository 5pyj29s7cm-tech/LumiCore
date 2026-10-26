// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { vi.resetModules(); invoke.mockReset(); localStorage.clear(); (window as any).__TAURI_INTERNALS__ = {}; });
afterEach(() => { delete (window as any).__TAURI_INTERNALS__; vi.unstubAllGlobals(); });
it('shares one native bootstrap and replaces credentials only after its successful receipt', async () => {
  const auth = await import('./authService'), pending = deferred<any>();
  localStorage.setItem('lumi_auth_token', 'existing-account'); localStorage.setItem('lumi_desktop_session_proof', 'existing-proof');
  invoke.mockReturnValue(pending.promise);
  const first = auth.bootstrap(), second = auth.bootstrap(); expect(second).toBe(first);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith('bootstrap_local_identity', { existingToken: 'existing-account' });
  expect(auth.getStoredToken()).toBe('existing-account'); expect(auth.getDesktopSessionProof()).toBe('existing-proof');
  pending.resolve({ success: true, token: 'renewed-account', desktopSessionProof: 'renewed-proof' });
  await first; expect(auth.getStoredToken()).toBe('renewed-account'); expect(auth.getDesktopSessionProof()).toBe('renewed-proof');
});
it('preserves credentials on rejected or failed bootstrap and permits a later recovery', async () => {
  const auth = await import('./authService'); localStorage.setItem('lumi_auth_token', 'existing-account'); localStorage.setItem('lumi_desktop_session_proof', 'existing-proof');
  invoke.mockRejectedValueOnce(new Error('Verified backend temporarily unavailable')).mockResolvedValueOnce({ success: false, error: 'Native identity denied', token: 'must-not-store', desktopSessionProof: 'must-not-store' }).mockResolvedValueOnce({ success: true, token: 'renewed-account', desktopSessionProof: 'renewed-proof' });
  expect(await auth.bootstrap()).toEqual({ success: false, error: 'Verified backend temporarily unavailable' });
  expect(await auth.bootstrap()).toMatchObject({ success: false, error: 'Native identity denied' });
  expect(auth.getStoredToken()).toBe('existing-account'); expect(auth.getDesktopSessionProof()).toBe('existing-proof');
  expect(await auth.bootstrap()).toMatchObject({ success: true }); expect(invoke).toHaveBeenCalledTimes(3);
});
it('discards an old native receipt after the current token changes', async () => {
  const auth = await import('./authService'), pending = deferred<any>(); localStorage.setItem('lumi_auth_token', 'account-a'); localStorage.setItem('lumi_desktop_session_proof', 'proof-a'); invoke.mockReturnValue(pending.promise);
  const refreshing = auth.bootstrap(); await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  localStorage.setItem('lumi_auth_token', 'account-b'); localStorage.setItem('lumi_desktop_session_proof', 'proof-b');
  pending.resolve({ success: true, token: 'stale-account-a', desktopSessionProof: 'stale-proof-a' });
  expect(await refreshing).toMatchObject({ success: false }); expect(auth.getStoredToken()).toBe('account-b'); expect(auth.getDesktopSessionProof()).toBe('proof-b');
});
it('explicit logout invalidates a pending receipt and stops background recovery until interactive login', async () => {
  const auth = await import('./authService'), pending = deferred<any>(); localStorage.setItem('lumi_auth_token', 'account-a'); localStorage.setItem('lumi_desktop_session_proof', 'proof-a'); invoke.mockReturnValueOnce(pending.promise);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, token: 'login-account-b' }) }); vi.stubGlobal('fetch', fetcher);
  const refreshing = auth.bootstrap(); await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1)); await auth.logout();
  pending.resolve({ success: true, token: 'stale-account-a', desktopSessionProof: 'stale-proof-a' }); await refreshing;
  expect(auth.getStoredToken()).toBeNull(); expect(auth.getDesktopSessionProof()).toBeNull(); expect(auth.canRecoverNativeSession()).toBe(false);
  expect(await auth.bootstrap()).toMatchObject({ success: false }); expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValueOnce({ success: true, token: 'verified-account-b', desktopSessionProof: 'verified-proof-b' });
  expect(await auth.login('B', 'synthetic-password')).toMatchObject({ success: true });
  expect(invoke).toHaveBeenLastCalledWith('bootstrap_local_identity', { existingToken: 'login-account-b' }); expect(auth.getStoredToken()).toBe('verified-account-b'); expect(auth.canRecoverNativeSession()).toBe(true);
});
it('does not invoke native bootstrap in a browser or replay a business write on authentication failure', async () => {
  const auth = await import('./authService'); delete (window as any).__TAURI_INTERNALS__;
  expect(await auth.bootstrap()).toMatchObject({ success: false }); expect(invoke).not.toHaveBeenCalled();
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Authentication required' }) }); vi.stubGlobal('fetch', fetcher);
  const { apiJson } = await import('./apiClient'); await expect(apiJson('/api/legal-tools/asset-trace', { method: 'POST', body: '{}' })).rejects.toThrow('Authentication required');
  expect(fetcher).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
});
