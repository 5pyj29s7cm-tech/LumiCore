// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), invoke: vi.fn(), keys: vi.fn(), error: vi.fn(), success: vi.fn(), api: vi.fn(), user: { uid: 'one', role: 'admin' }, enroll: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: f.user, workDomain: 'personal', orgConnection: null }) }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: (...a: any[]) => f.fetch(...a), apiJson: (...a: any[]) => f.api(...a) }));
vi.mock('../src/services/settingsKeys', () => ({ getSavedKeyStatus: (...a: any[]) => f.keys(...a) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: any[]) => f.invoke(...a) }));
vi.mock('sonner', () => ({ toast: { error: f.error, success: f.success } }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));
vi.mock('../src/hooks/usePlatform', () => ({ usePlatform: () => ({ platform: 'win32', isElectron: false }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1] }));
vi.mock('../src/hooks/useVoiceprint', () => ({ useVoiceprint: () => ({ startEnrollment: f.enroll, stopListening: vi.fn() }) }));
vi.mock('../src/hooks/useFaceRecognition', () => ({ useFaceRecognition: () => ({ enrollFace: f.enroll }) }));
vi.mock('../src/components/settings/provider_access', () => ({ ApiKeyField: ({ label }: any) => <span>{label}</span> }));
vi.mock('../src/components/settings/official_provider', () => ({ OfficialProviderSettings: () => null, ServiceProviderSettings: () => null }));
vi.mock('../src/components/settings/local_provider', () => ({ LocalProviderSettings: () => null }));
vi.mock('../src/components/org/LegalDataSourcesSettings', () => ({ LegalDataSourcesSettings: () => null }));
vi.mock('../src/components/MCPSettings', () => ({ MCPSettings: () => null }));
vi.mock('../src/components/RemoteMCPSettings', () => ({ RemoteMCPSettings: () => null }));
vi.mock('../src/components/VoiceProviderSwitch', () => ({ VoiceProviderSwitch: () => <span>Provider not configured</span> }));
vi.mock('../src/components/VoiceDeviceSelector', () => ({ VoiceDeviceSelector: () => null }));
vi.mock('../src/components/settings/official_models', () => ({ LumiOfficialCapabilityBadge: () => null }));
vi.mock('../src/components/settings/vision_voice_preferences', () => ({ VoicePreferenceToggle: () => null }));
import { AutonomousSettingsPanel, DEFAULT_AUTONOMY_GATE } from '../src/components/settings/autonomy';
import { BiometricsEnrollPanel } from '../src/components/biometrics/BiometricsEnrollPanel';
import { ApplicationConnections } from '../src/components/settings/connections';
import { AIProvidersPage } from '../src/components/settings/provider_navigation';
import { VoiceServicesPage } from '../src/components/settings/voice_services';
import { SettingsView } from '../src/components/settings/navigation';
const response = (data: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
const native = { close_to_background: false, autostart_enabled: false, autostart_supported: true, platform: 'test' };
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { resolve, promise }; };
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); vi.stubGlobal('fetch', f.fetch); f.user = { uid: 'one', role: 'admin' }; f.fetch.mockImplementation(async url => response(url.includes('gate_config') ? DEFAULT_AUTONOMY_GATE : { tasks: [] })); f.invoke.mockResolvedValue(native); f.keys.mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('persists close-to-background only after the native boolean acknowledgement', async () => {
  const write = deferred(); f.invoke.mockImplementation(command => command === 'set_close_to_background' ? write.promise : Promise.resolve(native));
  render(<AutonomousSettingsPanel t={{ langCode: 'en' }} />); const button = await screen.findByRole('button', { name: 'close-button-hides-to-background' });
  fireEvent.click(button); await waitFor(() => expect(f.invoke).toHaveBeenCalledWith('set_close_to_background', { enabled: true })); expect(localStorage.getItem('lumi_close_to_background')).toBeNull(); expect(screen.getByRole('button', { name: 'close-button-hides-to-background' }).closest('fieldset')).toHaveProperty('disabled', true);
  await act(async () => write.resolve(true)); expect(localStorage.getItem('lumi_close_to_background')).toBe('true');
});
it.each([false, undefined])('rejects mismatched or missing native acknowledgement %s', async receipt => {
  f.invoke.mockImplementation(async command => command === 'set_close_to_background' ? receipt : native); render(<AutonomousSettingsPanel t={{ langCode: 'en' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'close-button-hides-to-background' })); await screen.findByRole('alert'); expect(localStorage.getItem('lumi_close_to_background')).toBeNull(); expect(f.success).not.toHaveBeenCalled();
});
it('times out a native preference write, ignores its late acknowledgement and permits a fresh retry', async () => {
  const write = deferred();
  f.invoke.mockImplementation(command => command === 'set_close_to_background' ? write.promise : Promise.resolve(native));
  vi.useFakeTimers(); render(<AutonomousSettingsPanel t={{ langCode: 'en' }} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'close-button-hides-to-background' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10001); });
  expect(screen.getByRole('alert')).toBeTruthy(); expect(localStorage.getItem('lumi_close_to_background')).toBeNull();
  expect(screen.getByRole('button', { name: 'close-button-hides-to-background' }).closest('fieldset')).toHaveProperty('disabled', false);
  await act(async () => write.resolve(true)); expect(localStorage.getItem('lumi_close_to_background')).toBeNull();
  f.invoke.mockImplementation(async command => command === 'set_close_to_background' ? true : { ...native, close_to_background: true });
  fireEvent.click(screen.getByRole('button', { name: 'close-button-hides-to-background' }));
  await act(async () => {}); expect(localStorage.getItem('lumi_close_to_background')).toBe('true');
});
it.each([response({}, false), response({ voiceprints: 'wrong', faces: [] })])('shows biometric HTTP/schema failures and retries without using hardware', async bad => {
  f.fetch.mockResolvedValueOnce(bad).mockResolvedValueOnce(response({ voiceprints: [{ id: 'v', label: 'Synthetic voice' }], faces: [] })); render(<BiometricsEnrollPanel />);
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('Synthetic voice'); expect(screen.queryByRole('alert')).toBeNull(); expect(f.enroll).not.toHaveBeenCalled();
});
it.each([response({}, false), response({ success: false }), response({})])('does not claim biometric deletion on failed/unconfirmed receipt', async bad => {
  f.fetch.mockResolvedValueOnce(response({ voiceprints: [], faces: [{ id: 'f/a', label: 'Synthetic face' }] })).mockResolvedValueOnce(bad); render(<BiometricsEnrollPanel />);
  const row = (await screen.findByText('Synthetic face')).closest('div.flex.items-center.justify-between')!; fireEvent.click(row.querySelector('button')!);
  await screen.findByRole('alert'); expect(screen.getByText('Synthetic face')).toBeTruthy(); expect(f.success).not.toHaveBeenCalled(); expect(f.fetch.mock.calls.at(-1)![0]).toContain('f%2Fa');
});
it('checks only saved credential presence and keeps remote availability explicitly unverified', async () => {
  f.keys.mockRejectedValueOnce(new Error('unreadable')).mockResolvedValueOnce({ GITHUB_TOKEN: true, NOTION_API_KEY: false }); render(<ApplicationConnections t={{ langCode: 'en' }} />);
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('GitHub: Credential saved — service not verified');
  expect(screen.getByText('Notion: Credential not saved')).toBeTruthy(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.api).not.toHaveBeenCalled();
});
it('renders extension provider labels in Chinese without asserting unavailable service is ready', () => {
  render(<AIProvidersPage t={{ langCode: 'zh' }} providerStatus={{ fixture: { extension: true, available: false, configured: false, model: '' } }} />);
  fireEvent.click(screen.getAllByRole('tab')[2]); expect(screen.getByText('已签名扩展提供商')).toBeTruthy(); expect(screen.getByText('不可用')).toBeTruthy(); expect(screen.queryByText('Signed extension Providers')).toBeNull();
});
it('voice overview uses neutral decoration and directs availability to the real provider status', () => {
  const view = render(<VoiceServicesPage t={{ langCode: 'en' }} />); expect(view.container.querySelector('.bg-emerald-500.animate-pulse')).toBeNull(); expect(screen.getByText(/Capability overview only/)).toBeTruthy(); expect(screen.getByText('Provider not configured')).toBeTruthy();
});
it('settings provider status exposes an inline retry after a failed read', async () => {
  f.api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ providers: {} }); render(<SettingsView t={{ langCode: 'en' }} lang="en" setLang={() => {}} />);
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(screen.queryByRole('alert')).toBeNull()); expect(f.api).toHaveBeenCalledTimes(2);
});
