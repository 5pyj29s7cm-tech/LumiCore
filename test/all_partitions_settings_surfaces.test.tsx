// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ app: {} as any, json: vi.fn(), api: vi.fn(), fetch: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => f.app }));
vi.mock('../src/services/apiClient', () => ({ apiJson: (...a: any[]) => f.json(...a), apiFetch: (...a: any[]) => f.api(...a) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ ncTitle: 'Notifications', markAllRead: 'Mark all read', clearAll: 'Clear all', ncEmpty: 'No notifications' }), useLocale: () => 'en' }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1] }));
vi.mock('sonner', () => ({ toast: { success: f.success, error: f.error, info: vi.fn() } }));
vi.mock('../src/hooks/usePlatform', () => ({ usePlatform: () => ({ platform: 'win32', isElectron: false }) }));
vi.mock('../src/components/biometrics/BiometricsEnrollPanel', () => ({ BiometricsEnrollPanel: () => null }));
vi.mock('../src/components/PrivacyModeSettings', () => ({ PrivacyModeSettings: () => null }));
vi.mock('../src/components/settings/autonomy', () => ({ AutonomousSettingsPanel: () => null }));
vi.mock('../src/components/settings/voice_services', () => ({ VoiceForge: () => null, VoiceServicesPage: () => null }));
vi.mock('../src/components/settings/provider_navigation', () => ({ AIProvidersPage: () => null }));
vi.mock('../src/components/settings/reasoning', () => ({ ReasoningRoleSettings: () => null }));
vi.mock('../src/components/settings/connections', () => ({ ExternalConnectionsPage: () => null, ToolRuntimeConnections: () => null }));
vi.mock('../src/components/settings/world_models', () => ({ WorldModelsPage: () => null }));
vi.mock('../src/components/settings/generation', () => ({ GenerativeModelsPage: () => null }));
vi.mock('../src/components/settings/retrieval', () => ({ RetrievalModelSettings: () => null }));
vi.mock('../src/components/settings/hardware', () => ({ HardwareSettings: () => null }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: any) => children, motion: new Proxy({}, { get: (_, tag: string) => ({ children, initial, animate, exit, transition, whileHover, whileTap, layout, ...props }: any) => React.createElement(tag, props, children) }) }));
import { NotificationCenter } from '../src/components/NotificationCenter';
import { ReminderPanel } from '../src/components/ReminderPanel';
import { TokenDashboard } from '../src/components/TokenDashboard';
import { Profile } from '../src/components/Profile';
import { SettingsView } from '../src/components/settings/navigation';
const reply = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const reminder = (id = 'fixture/a') => ({ id, content: 'Synthetic reminder', status: 'pending', dueAt: null });
const usage = (total = 123) => ({ byProvider: { openai: { totalTokens: total, calls: 2 } }, daily: [{ date: '2026-10-30', totalTokens: total }], grandTotal: total, recordCount: 2 });
beforeEach(() => {
  vi.clearAllMocks(); f.json.mockReset(); f.api.mockReset(); f.fetch.mockReset();
  f.app = { user: { uid: 'synthetic-user', role: 'user', username: 'Fixture user' }, workDomain: 'personal', orgConnection: null, notifications: [], notificationsBusy: false, markAllNotificationsRead: vi.fn(), clearNotifications: vi.fn(), appearanceMode: 'dark', resolvedAppearanceMode: 'dark', setAppearanceMode: vi.fn(), logout: vi.fn(), switchDomain: vi.fn() };
  f.api.mockResolvedValue(reply({ status: 'ok', process: { uptimeSec: 3660 }, database: { interactions: 5 } }));
  vi.stubGlobal('fetch', f.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('current notification center component', () => {
  it('orders records newest first and delegates read/clear exactly once', () => {
    f.app.notifications = [{ id: 'old', title: 'Older event', message: 'old', timestamp: 1, read: false }, { id: 'new', title: 'Newest event', message: 'new', timestamp: 2, read: true }];
    render(<NotificationCenter />);
    const events = screen.getAllByRole('button').filter(item => item.getAttribute('tabindex') === '0');
    expect(events.map(item => item.textContent)).toEqual([expect.stringContaining('Newest event'), expect.stringContaining('Older event')]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' })); fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(f.app.markAllNotificationsRead).toHaveBeenCalledOnce(); expect(f.app.clearNotifications).toHaveBeenCalledOnce();
  });
  it('blocks repeated bulk actions while context reports pending persistence', () => {
    f.app.notifications = [{ id: 'a', title: 'Fixture', timestamp: 1 }]; f.app.notificationsBusy = true; render(<NotificationCenter />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' })); expect(f.app.clearNotifications).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toHaveProperty('disabled', true);
  });
  it('hands the selected notification to chat through keyboard activation and dismisses it locally', () => {
    const onChatMessage = vi.fn(), item = { id: 'a', title: 'Open fixture', timestamp: 1, message: 'fixture' }; f.app.notifications = [item];
    render(<NotificationCenter onChatMessage={onChatMessage} />); fireEvent.keyDown(screen.getByRole('button', { name: /Open fixture/ }), { key: 'Enter' });
    expect(onChatMessage).toHaveBeenCalledExactlyOnceWith(item); expect(screen.getByText('No notifications')).toBeTruthy();
  });
});

describe('current reminder collection component', () => {
  it('shows initial failure, blocks unconfirmed writes and retries the actual collection hook', async () => {
    f.json.mockRejectedValueOnce(new Error('reminder unavailable')).mockResolvedValueOnce([reminder()]); render(<ReminderPanel t={{ langCode: 'en' }} />);
    await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('reminder unavailable'); expect(screen.getByPlaceholderText('reminder-content').closest('fieldset')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'retry' })); await screen.findByText('Synthetic reminder');
  });
  it('keeps an unsaved draft after rejection and clears it only after the confirmed row', async () => {
    f.json.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('save rejected')).mockResolvedValueOnce({ ...reminder(), content: 'A draft' }); render(<ReminderPanel t={{ langCode: 'en' }} />);
    await screen.findByText('no-pending-reminders'); const input = screen.getByPlaceholderText('reminder-content'); fireEvent.change(input, { target: { value: ' A draft ' } });
    fireEvent.click(screen.getByRole('button', { name: 'add' })); await screen.findByText('save rejected'); expect(input).toHaveProperty('value', ' A draft '); expect(f.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'add' })); await screen.findByText('A draft'); expect(input).toHaveProperty('value', '');
    expect(JSON.parse(f.json.mock.calls[2][1].body)).toEqual({ content: 'A draft', dueAt: null });
  });
  it('does not remove an item without a confirmed delete receipt', async () => {
    f.json.mockResolvedValueOnce([reminder()]).mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true }); render(<ReminderPanel t={{ langCode: 'en' }} />); await screen.findByText('Synthetic reminder');
    fireEvent.click(screen.getByTitle('delete')); await screen.findByText('Deletion was not confirmed'); expect(screen.getByText('Synthetic reminder')).toBeTruthy();
    fireEvent.click(screen.getByTitle('delete')); await screen.findByText('no-pending-reminders'); expect(f.json.mock.calls.at(-1)?.[0]).toBe('/api/reminders/fixture%2Fa');
  });
  it('isolates late collection results when the account changes', async () => {
    const old = deferred(); f.json.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]); const view = render(<ReminderPanel />), signal = f.json.mock.calls[0][1].signal;
    f.app.user = { uid: 'new-user', role: 'user' }; view.rerender(<ReminderPanel />); await screen.findByText('no-pending-reminders');
    await act(async () => old.resolve([reminder()])); expect(signal.aborted).toBe(true); expect(screen.queryByText('Synthetic reminder')).toBeNull();
  });
});

describe('current usage dashboard component', () => {
  it('does not present a malformed response as zero usage and recovers by refresh', async () => {
    f.json.mockResolvedValueOnce({ grandTotal: 0 }).mockResolvedValueOnce(usage()); render(<TokenDashboard />); await screen.findByRole('alert'); expect(screen.queryByText('no-usage-data-yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'refresh' })); expect((await screen.findAllByText('123')).length).toBeGreaterThan(0); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('applies the selected time window and discards a late previous response', async () => {
    const old = deferred(); f.json.mockReturnValueOnce(old.promise).mockResolvedValueOnce(usage(456)); render(<TokenDashboard />); const signal = f.json.mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole('button', { name: '7d' })); await screen.findAllByText('456'); await act(async () => old.resolve(usage(999)));
    expect(signal.aborted).toBe(true); expect(screen.queryByText('999')).toBeNull(); expect(f.json.mock.calls[1][0]).toBe('/api/llm/usage?days=7');
  });
  it('clears previous-account usage while the new account request is pending', async () => {
    const pending = deferred(); f.json.mockResolvedValueOnce(usage(321)).mockReturnValueOnce(pending.promise); const view = render(<TokenDashboard />); await screen.findAllByText('321');
    f.app.user = { uid: 'other-user', role: 'user' }; view.rerender(<TokenDashboard />); expect(screen.queryByText('321')).toBeNull();
    await act(async () => pending.resolve(usage(654))); await screen.findAllByText('654');
  });
});

const profileCopy = { currentPassword: 'Current password', newPassword: 'New password', updatePassword: 'Update password', passwordChanged: 'Password changed', passwordError: 'Password failed' };
describe('current account profile component', () => {
  it('falls back from forbidden details to public health without inventing private metrics', async () => {
    f.api.mockResolvedValueOnce(reply({}, 403)).mockResolvedValueOnce(reply({ status: 'degraded' })); render(<Profile t={profileCopy} />);
    await screen.findAllByText('Degraded'); expect(f.api.mock.calls.map(([url]) => url)).toEqual(['/api/health?details=1', '/api/health']); expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });
  it.each([true, false])('reports the actual password receipt and preserves rejected input (success=%s)', async success => {
    const pending = deferred(); f.fetch.mockReturnValue(pending.promise); const view = render(<Profile t={profileCopy} />); await screen.findByText('1h 1m');
    const fields = view.container.querySelectorAll('input[type=password]'); fireEvent.change(fields[0], { target: { value: 'old-fixture' } }); fireEvent.change(fields[1], { target: { value: 'new-fixture' } });
    fireEvent.submit(view.container.querySelector('form')!); expect(screen.getByRole('button', { name: '...' })).toHaveProperty('disabled', true);
    await act(async () => pending.resolve(reply(success ? {} : { error: 'Denied fixture' }, success ? 200 : 403)));
    await screen.findByText(success ? 'Password changed' : 'Denied fixture'); expect(fields[1]).toHaveProperty('value', success ? '' : 'new-fixture');
    expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({ currentPassword: 'old-fixture', newPassword: 'new-fixture' });
  });
});

describe('current general settings component', () => {
  it('delegates language and all appearance modes to their canonical owners', async () => {
    f.json.mockResolvedValue({ providers: {} }); const setLang = vi.fn(); render(<SettingsView t={{ englishUS: 'English', chinese: 'Chinese' }} lang="en" setLang={setLang} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chinese' })); fireEvent.click(screen.getByRole('button', { name: 'English' })); expect(setLang.mock.calls).toEqual([['zh'], ['en']]);
    for (const label of ['day bright-shell', 'night classic-dark', 'system now-night']) fireEvent.click(screen.getByRole('button', { name: label }));
    expect(f.app.setAppearanceMode.mock.calls).toEqual([['light'], ['dark'], ['system']]); await waitFor(() => expect(f.json).toHaveBeenCalledOnce());
  });
  it('reports provider-load failure and retries after credential-change notification', async () => {
    f.json.mockRejectedValueOnce(new Error('providers fixture failure')).mockResolvedValueOnce({ providers: {} }); render(<SettingsView t={{ englishUS: 'English', chinese: 'Chinese' }} lang="en" setLang={vi.fn()} />);
    await waitFor(() => expect(f.error).toHaveBeenCalledWith('providers fixture failure'));
    await act(async () => window.dispatchEvent(new Event('lumi:keys-changed'))); expect(f.json).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Chinese' })).toBeTruthy();
  });
});
