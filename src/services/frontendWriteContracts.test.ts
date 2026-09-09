// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from './apiClient';
import { logout } from './authService';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => { localStorage.clear(); invoke.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); delete (window as any).__TAURI_INTERNALS__; vi.resetModules(); });

describe('confirmed frontend writes', () => {
  it('includes desktop proof and rejects a denied save', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token');
    localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    const fetcher = vi.fn().mockResolvedValue(reply({ error: 'denied' }, 403));
    vi.stubGlobal('fetch', fetcher);
    await expect(apiJson('/api/remote-devices', { method: 'PUT' })).rejects.toThrow('denied');
    const headers = new Headers(fetcher.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer synthetic-token');
    expect(headers.get('x-lumi-desktop-session')).toBe('synthetic-proof');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clears both credentials immediately when logout is offline', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-token');
    localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = logout();
    expect(localStorage.getItem('lumi_auth_token')).toBeNull();
    expect(localStorage.getItem('lumi_desktop_session_proof')).toBeNull();
    expect(await result).toEqual({ remoteRevoked: false });
  });

  it('does not persist OS slider values when native control fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const { systemService } = await import('./systemService');
    localStorage.setItem('lumi_volume', '25');
    localStorage.setItem('lumi_brightness', '40');
    invoke.mockRejectedValue(new Error('native unavailable'));
    await expect(systemService.setVolume(90)).rejects.toThrow('native unavailable');
    await expect(systemService.setBrightness(90)).rejects.toThrow('native unavailable');
    expect(localStorage.getItem('lumi_volume')).toBe('25');
    expect(localStorage.getItem('lumi_brightness')).toBe('40');
    await expect(systemService.getVolume()).rejects.toThrow('native unavailable');
    await expect(systemService.getBrightness()).rejects.toThrow('native unavailable');
  });

  it('commits OS slider values only after native completion', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const { systemService } = await import('./systemService');
    let complete!: () => void;
    invoke.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    const pending = systemService.setVolume(30);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(localStorage.getItem('lumi_volume')).toBeNull();
    complete(); await pending;
    expect(localStorage.getItem('lumi_volume')).toBe('30');
  });
});
