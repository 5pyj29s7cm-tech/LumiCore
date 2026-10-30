// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), api: vi.fn(), invoke: vi.fn(), success: vi.fn(), error: vi.fn(), permission: vi.fn(), setSensor: vi.fn(), setPresence: vi.fn(), snapshot: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'synthetic-owner' }, workDomain: 'personal', orgConnection: null }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: (...args: any[]) => f.api(...args) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => f.invoke(...args) }));
vi.mock('sonner', () => ({ toast: { success: f.success, error: f.error } }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string, values: any) => key.split('.')[1] + ':' + values.value0 }));
vi.mock('../src/services/sensorPermissionService', () => ({
  BACKGROUND_FACE_PRESENCE_CHANGED: 'test-face', BACKGROUND_FACE_PRESENCE_ENABLED_KEY: 'test-face-key', SENSOR_ACCESS_CHANGED: 'test-sensor', SENSOR_PERMISSIONS_CHANGED: 'test-permission',
  getSensorPermissionSnapshot: (...args: any[]) => f.snapshot(...args), isBackgroundFacePresenceEnabled: () => false, isSensorEnabled: () => false,
  requestSensorPermission: (...args: any[]) => f.permission(...args), setBackgroundFacePresenceEnabled: (...args: any[]) => f.setPresence(...args), setSensorEnabled: (...args: any[]) => f.setSensor(...args),
}));
import { AutonomousSettingsPanel, DEFAULT_AUTONOMY_GATE } from '../src/components/settings/autonomy';
import { HardwareSettings } from '../src/components/settings/hardware';
const response = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const backgroundToggle = () => screen.getByText('Allow background processing').parentElement!.parentElement!.querySelector('button')!;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', f.fetch); localStorage.clear();
  f.fetch.mockImplementation(async (url: string) => response(url.includes('gate_config') ? { ...DEFAULT_AUTONOMY_GATE, autoProcessEnabled: false } : { tasks: [] }));
  f.invoke.mockRejectedValue(new Error('Synthetic native bridge unavailable')); f.snapshot.mockResolvedValue({ microphone: 'prompt', camera: 'prompt' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('current autonomy settings component', () => {
  it('uses confirmed gate state and sends only the requested patch while locking an in-flight save', async () => {
    const pending = deferred(); f.api.mockReturnValue(pending.promise); render(<AutonomousSettingsPanel t={{ langCode: 'en' }} />);
    await screen.findByText('Synthetic native bridge unavailable'); fireEvent.click(backgroundToggle());
    expect(JSON.parse(f.api.mock.calls[0][1].body)).toEqual({ autoProcessEnabled: true }); expect(backgroundToggle().closest('fieldset')).toHaveProperty('disabled', true);
    await act(async () => pending.resolve(response({ ...DEFAULT_AUTONOMY_GATE, autoProcessEnabled: true })));
    expect(backgroundToggle().closest('fieldset')).toHaveProperty('disabled', false);
    fireEvent.click(backgroundToggle()); expect(JSON.parse(f.api.mock.calls[1][1].body)).toEqual({ autoProcessEnabled: false });
  });
  it('keeps confirmed settings after a rejected save and reports failure', async () => {
    f.api.mockResolvedValue(response({ error: 'denied' }, 403)); render(<AutonomousSettingsPanel t={{ langCode: 'en' }} />); await screen.findByText('Synthetic native bridge unavailable');
    fireEvent.click(backgroundToggle()); await waitFor(() => expect(f.error).toHaveBeenCalledWith('Background settings could not be saved. Please retry.'));
    fireEvent.click(backgroundToggle()); expect(f.api.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([{ autoProcessEnabled: true }, { autoProcessEnabled: true }]);
  });
});
describe('current hardware settings component with synthetic permission owner', () => {
  it('loads permission state without requesting microphone or camera access on mount', async () => {
    render(<HardwareSettings t={{}} />); await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce()); expect(f.permission).not.toHaveBeenCalled(); expect(f.setSensor).not.toHaveBeenCalled();
  });
  it('locks both sensors during permission request and rolls back a denied microphone grant', async () => {
    const pending = deferred(); f.permission.mockReturnValue(pending.promise); render(<HardwareSettings t={{}} />); await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'enable-value0:audio-receptors' }));
    expect(screen.getByRole('button', { name: 'enable-value0:visual-cortex' })).toHaveProperty('disabled', true);
    await act(async () => pending.resolve({ ok: false, state: 'denied', error: 'Synthetic denial' }));
    expect(f.permission).toHaveBeenCalledExactlyOnceWith('microphone'); expect(f.setSensor.mock.calls).toEqual([['microphone', true], ['microphone', false]]);
    expect(screen.getByRole('button', { name: 'enable-value0:audio-receptors' }).getAttribute('aria-pressed')).toBe('false'); expect(f.success).not.toHaveBeenCalled();
  });
  it('does not enable background face detection when camera access is disabled', async () => {
    render(<HardwareSettings t={{}} />); await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce()); fireEvent.click(screen.getByRole('button', { name: 'background-face-presence' }));
    expect(f.error).toHaveBeenCalledWith('enable-camera-access-before-turning'); expect(f.permission).not.toHaveBeenCalled(); expect(f.setPresence).not.toHaveBeenCalled();
  });
});
