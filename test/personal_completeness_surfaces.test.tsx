// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ api: vi.fn(), catalog: vi.fn(), speech: vi.fn(), design: vi.fn(), uid: 'a', domain: 'personal' }));
vi.mock('../src/services/apiClient', () => ({ apiJson: f.api }));
vi.mock('../src/services/voiceService', () => ({ listVoices: f.catalog, synthesizeSpeech: f.speech, designVoice: f.design, VOICE_PROVIDER_CHANGED_EVENT: 'voice-test-change' }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: f.uid, role: 'user' }, workDomain: f.domain }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: 'en' }) }));
vi.mock('../src/components/VoicePicker', () => ({ VoicePicker: () => null }));
vi.mock('../src/components/VoiceForge', () => ({ VoiceForge: () => null }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { Spotlight } from '../src/components/desktop/launcher';
import { MeshSyncSelector } from '../src/components/MeshSyncSelector';
import { ContactsPanel } from '../src/components/ContactsPanel';
import { DesktopPersonalizationSoundPanel } from '../src/components/DesktopPersonalizationSoundPanel';
const catalog = { provider: 'fixture', configured: true, capabilities: { clone: false, design: false }, cloned: [], premade: [] };
beforeEach(() => { vi.clearAllMocks(); f.uid = 'a'; f.domain = 'personal'; f.api.mockReset(); f.catalog.mockReset().mockResolvedValue(catalog); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const apps = [{ id: 'a', label: 'Alpha', color: '', icon: <span /> }, { id: 'b', label: 'Beta', color: '', icon: <span /> }];
it('personal-completeness launcher arrows, search reset, Enter and Escape operate only the selected result', () => {
  const select = vi.fn(), close = vi.fn(); render(<Spotlight isOpen apps={apps} t={{}} onSelect={select} onClose={close} />);
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' }); expect(select).toHaveBeenLastCalledWith('b');
  fireEvent.keyDown(input, { key: 'ArrowUp' }); fireEvent.keyDown(input, { key: 'Enter' }); expect(select).toHaveBeenLastCalledWith('a');
  fireEvent.change(input, { target: { value: 'Beta' } }); fireEvent.keyDown(input, { key: 'Enter' }); expect(select).toHaveBeenLastCalledWith('b');
  fireEvent.change(input, { target: { value: 'none' } }); fireEvent.keyDown(input, { key: 'Enter' }); expect(select).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(input, { key: 'Escape' }); expect(close).toHaveBeenCalledTimes(4);
});
it('personal-completeness launcher Enter defaults to first and ignores IME composition', () => {
  const select = vi.fn(); render(<Spotlight isOpen apps={apps} t={{}} onSelect={select} onClose={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true }); expect(select).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); expect(select).toHaveBeenCalledExactlyOnceWith('a');
});
it('personal-completeness nexus identifies animation speed and exposes controlled selection', () => {
  render(<MeshSyncSelector t={{ langCode: 'en', meshSyncRate: 'Mesh Sync' }} syncRate={1} onSyncRateChange={vi.fn()} />);
  expect(screen.getByText('Animation speed')).toBeTruthy(); expect(screen.queryByText('Mesh Sync')).toBeNull();
  expect(screen.getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('true');
});
it('personal-completeness contacts page at the server, reset search, and confirm deletion without replay', async () => {
  let removed = false;
  f.api.mockImplementation(async (url: string, init: any) => {
    if (init?.method === 'DELETE') { removed = true; return { success: true }; }
    const params = new URL(url, 'https://fixture').searchParams;
    return { contacts: removed ? [] : [{ id: 'a', name: params.get('search') || (params.get('offset') === '25' ? 'Second page' : 'Alice') }], total: removed ? 0 : 26 };
  });
  render(<ContactsPanel />); await screen.findByText('Alice');
  expect(f.api.mock.calls[0][0]).toContain('limit=25&offset=0');
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); await screen.findByText('Second page');
  fireEvent.change(screen.getByPlaceholderText('contacts-panel.search-contacts.fcf6775e68'), { target: { value: 'Needle' } }); await screen.findByText('Needle');
  expect(f.api.mock.calls.at(-1)![0]).toContain('offset=0&search=Needle');
  fireEvent.click(screen.getByTitle('reminder-panel.delete.5b875326d1'));
  expect(screen.getByRole('alertdialog')).toBeTruthy(); expect(f.api.mock.calls.filter(([, i]) => i.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByTitle('reminder-panel.delete.5b875326d1')); fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }));
  await waitFor(() => expect(screen.queryByText('Needle')).toBeNull()); expect(f.api.mock.calls.filter(([, i]) => i.method === 'DELETE')).toHaveLength(1);
});
it('personal-completeness contact delete requires a separate confirmation even on the first page', async () => {
  f.api.mockResolvedValue({ contacts: [{ id: 'a', name: 'Alice' }], total: 1 });
  render(<ContactsPanel />); await screen.findByText('Alice');
  fireEvent.click(screen.getByTitle('reminder-panel.delete.5b875326d1'));
  expect(f.api.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull(); expect(f.api).toHaveBeenCalledTimes(1);
});
it('personal-completeness confirmed contact write with failed readback retries GET without replaying the write', async () => {
  f.api.mockResolvedValueOnce({ contacts: [], total: 0 });
  render(<ContactsPanel />); await screen.findByText('contacts-panel.no-contacts-yet.69426093b0');
  fireEvent.click(screen.getByRole('button', { name: 'contacts-panel.add.cd6f2f52ff' }));
  fireEvent.change(screen.getByPlaceholderText('contacts-panel.name.f5479c3217'), { target: { value: 'Saved contact' } });
  f.api.mockResolvedValueOnce({ id: 'new', name: 'Saved contact' }).mockRejectedValueOnce(Error('readback offline'));
  fireEvent.click(screen.getByRole('button', { name: 'contacts-panel.save.ec8e6d5819' }));
  await screen.findByRole('alert');
  expect(screen.queryByPlaceholderText('contacts-panel.name.f5479c3217')).toBeNull();
  f.api.mockResolvedValueOnce({ contacts: [{ id: 'new', name: 'Saved contact' }], total: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'knowledge-base.retry.9db2a8180b' }));
  await screen.findByText('Saved contact'); expect(f.api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('personal-completeness catalog failure has a read-only retry and never invokes voice work', async () => {
  f.catalog.mockRejectedValueOnce(Error('offline'));
  render(<DesktopPersonalizationSoundPanel t={{ langCode: 'en' }} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Configuration is unknown');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(f.catalog).toHaveBeenCalledTimes(2); expect(f.speech).not.toHaveBeenCalled(); expect(f.design).not.toHaveBeenCalled();
});
it('personal-completeness stale catalog cannot cross account or work scope', async () => {
  let finish!: (value: any) => void; f.catalog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<DesktopPersonalizationSoundPanel t={{ langCode: 'en' }} />);
  f.uid = 'b'; f.domain = 'work'; view.rerender(<DesktopPersonalizationSoundPanel t={{ langCode: 'en' }} />);
  await waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(2));
  await act(async () => finish({ ...catalog, provider: 'ark', cloned: [{ name: 'Private old voice', voiceId: 'old' }] }));
  expect(screen.queryByText('Private old voice')).toBeNull();
});
it('personal-completeness hung catalog releases loading with an aborted signal and no voice work', async () => {
  vi.useFakeTimers();
  f.catalog.mockImplementation(() => new Promise(() => {}));
  render(<DesktopPersonalizationSoundPanel t={{ langCode: 'en' }} />);
  const signal = f.catalog.mock.calls[0][1];
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
  expect(signal.aborted).toBe(true); expect(screen.getByRole('alert')).toBeTruthy();
  expect(f.speech).not.toHaveBeenCalled(); expect(f.design).not.toHaveBeenCalled();
});
