// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ api: vi.fn(), success: vi.fn(), error: vi.fn(), uid: 'one' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: f.uid, role: 'admin' }, workDomain: 'personal' }) }));
vi.mock('../src/services/apiClient', () => ({ apiJson: (...a: any[]) => f.api(...a), apiFetch: vi.fn() }));
vi.mock('../src/services/settingsKeys', () => ({ getSavedKeyStatus: async () => ({}) }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('../src/hooks/usePlatform', () => ({ usePlatform: () => ({ isDesktop: false, isTauri: false }) }));
vi.mock('../src/services/sensorPermissionService', () => ({ getSensorPermissionSnapshot: async () => ({}), SENSOR_PERMISSIONS_CHANGED: 'permissions' }));
vi.mock('../src/hooks/useRuntimeStatus', () => ({ useRuntimeStatus: () => ({}) }));
vi.mock('../src/hooks/useLumiScene', () => ({ useLumiScene: () => ({}) }));
vi.mock('../src/components/RuntimeEvidencePanel', () => ({ RuntimeEvidencePanel: () => null }));
vi.mock('../src/components/LumiScenePanel', () => ({ LumiScenePanel: () => null }));
vi.mock('sonner', () => ({ toast: { success: f.success, error: f.error } }));
import { useSkillCenterState } from '../src/components/skill_center/useSkillCenterState';
import { SystemExplorer } from '../src/components/SystemExplorer';
import { useRecoverableRead } from '../src/hooks/useRecoverableRead';
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { resolve, promise }; };
function data(url: string) {
  if (url === '/api/skills') return { skills: [{ name: 'synthetic', description: 'Fixture skill', toolCount: 1, enabled: false, connected: false }] };
  if (url.includes('/marketplace/categories') || url.includes('/marketplace/skills') || url.includes('/interactions')) return [];
  if (url.endsWith('/history')) return { snapshots: [] };
  if (url.endsWith('/profession')) return { profiles: [] };
  if (url.endsWith('/providers')) return { providers: {} };
  return { authorized: false };
}
beforeEach(() => { vi.resetAllMocks(); f.uid = 'one'; f.api.mockImplementation(async url => data(url)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('publish rejection remains visible in state and retry requires a matching publication receipt', async () => {
  const hook = renderHook(() => useSkillCenterState({ t: {}, lang: 'en' })); await waitFor(() => expect(hook.result.current.installedSkills).toHaveLength(1));
  f.api.mockImplementation(async (url, init) => url.endsWith('/publish') ? { success: false } : data(url));
  await act(async () => hook.result.current.handlePublish('synthetic')); expect(f.success).not.toHaveBeenCalled(); expect(hook.result.current.publishState.error).toBeTruthy();
  f.api.mockImplementation(async url => url.endsWith('/publish') ? { success: true, skill: { name: 'synthetic' }, executable: false } : data(url));
  await act(async () => hook.result.current.handlePublish('synthetic')); expect(hook.result.current.publishState.error).toBe(''); expect(f.success).toHaveBeenCalledWith(expect.stringContaining('metadata'));
});
it('publishing serializes duplicate clicks and does not approve a wrong skill receipt', async () => {
  const hook = renderHook(() => useSkillCenterState({ t: {}, lang: 'en' })); await waitFor(() => expect(hook.result.current.installedSkills).toHaveLength(1));
  const pending = deferred(); f.api.mockImplementation(url => url.endsWith('/publish') ? pending.promise : Promise.resolve(data(url)));
  let first!: Promise<void>; act(() => { first = hook.result.current.handlePublish('synthetic'); void hook.result.current.handlePublish('synthetic'); }); expect(f.api.mock.calls.filter(([url]) => url.endsWith('/publish'))).toHaveLength(1);
  await act(async () => { pending.resolve({ success: true, skill: { name: 'other' } }); await first; }); expect(hook.result.current.publishState.error).toBeTruthy(); expect(f.success).not.toHaveBeenCalled();
});
it('failed adaptation report exposes read-only retry and never starts an inspection', async () => {
  f.api.mockImplementation(async url => { if (url === '/api/explore/status') throw new Error('offline'); return data(url); });
  render(<SystemExplorer t={{ langCode: 'en', computerAdaptation: 'Adaptation report' }} />); await screen.findByRole('alert');
  f.api.mockImplementation(async url => data(url)); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Adaptation report'); expect(screen.queryByRole('alert')).toBeNull(); expect(f.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it('read ownership aborts stale account work and prevents its late value replacing the new account', async () => {
  const old = deferred(), load = vi.fn((signal: AbortSignal) => load.mock.calls.length === 1 ? old.promise : Promise.resolve('new'));
  const hook = renderHook(({ owner }) => useRecoverableRead(owner, load), { initialProps: { owner: 'one' } }); const signal = load.mock.calls[0][0];
  hook.rerender({ owner: 'two' }); await waitFor(() => expect(hook.result.current.data).toBe('new')); expect(signal.aborted).toBe(true);
  await act(async () => old.resolve('old')); expect(hook.result.current.data).toBe('new');
});
it('pending read times out to error and explicit retry recovers without accepting a late response', async () => {
  vi.useFakeTimers(); vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new Error('deadline')), ms); return c.signal; });
  const load = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  const hook = renderHook(() => useRecoverableRead('one', load, 100)); await act(async () => { vi.advanceTimersByTime(100); }); expect(hook.result.current.loading).toBe(false); expect(hook.result.current.error).toBeTruthy();
  load.mockResolvedValueOnce('recovered'); await act(async () => hook.result.current.refresh()); expect(hook.result.current.error).toBe(''); expect(hook.result.current.data).toBe('recovered');
});
