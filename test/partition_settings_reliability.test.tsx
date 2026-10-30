// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), write: vi.fn(), invoke: vi.fn(), error: vi.fn(), user: { uid: 'fixture-a' } as { uid: string; role?: string } | null, workDomain: 'personal', orgConnection: null as { orgId: string; orgRole?: string } | null }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => f }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: (...args: any[]) => f.write(...args) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => f.invoke(...args) }));
vi.mock('sonner', () => ({ toast: { error: f.error, success: vi.fn() } }));
vi.mock('motion/react', () => ({ motion: {
  div: ({ children, initial, animate, transition, ...props }: any) => <div {...props}>{children}</div>,
  button: ({ children, initial, animate, transition, ...props }: any) => <button {...props}>{children}</button>,
} }));
import { AutonomousSettingsPanel } from '../src/components/settings/autonomy';
import { FoundersSanctuary } from '../src/components/FoundersSanctuary';
import { foundersSanctuaryCopy } from '../src/i18n/locales/foundersSanctuary';
import { zhCatalog } from '../src/i18n/locales/catalog_zh';
const reply = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
const gate = { autoProcessEnabled: false, requireIdle: true };
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const toggle = () => screen.getByRole('button', { name: 'Allow background processing' });
const panel = () => <AutonomousSettingsPanel t={{ langCode: 'en' }} />;
const ready = async () => waitFor(() => expect(toggle().closest('fieldset')).toHaveProperty('disabled', false));
beforeEach(() => {
  vi.resetAllMocks(); f.user = { uid: 'fixture-a' }; f.workDomain = 'personal'; f.orgConnection = null;
  f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { tasks: [] }));
  f.invoke.mockRejectedValue(new Error('Synthetic bridge unavailable')); vi.stubGlobal('fetch', f.fetch);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('confirmed background configuration', () => {
  it('locks unknown initial state and cannot write until the read confirms actual values', async () => {
    const pending = deferred(); f.fetch.mockImplementation(async (url: string) => url.includes('gate_config') ? pending.promise : reply({ tasks: [] }));
    render(panel()); expect(toggle().closest('fieldset')).toHaveProperty('disabled', true);
    fireEvent.click(toggle()); expect(f.write).not.toHaveBeenCalled(); expect(screen.getByText('Loading background settings…')).toBeTruthy();
    await act(async () => pending.resolve(reply(gate))); await ready(); expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it.each([reply({ error: 'Denied' }, 403), reply({}), reply({ autoProcessEnabled: 'false', requireIdle: true })])('surfaces unsuccessful or malformed reads, then retries before editing %#', async bad => {
    f.fetch.mockImplementation(async (url: string) => url.includes('gate_config') ? bad : reply({ tasks: [] })); render(panel());
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('could not be loaded'); expect(toggle().closest('fieldset')).toHaveProperty('disabled', true);
    f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { tasks: [] }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })); await ready(); expect(screen.queryByRole('alert')).toBeNull();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('reports a rejected read and leaves unknown controls locked', async () => {
    f.fetch.mockImplementation(async (url: string) => { if (url.includes('gate_config')) throw new Error('Offline'); return reply({ tasks: [] }); });
    render(panel()); await screen.findByRole('alert'); expect(toggle().closest('fieldset')).toHaveProperty('disabled', true);
  });

  it('turns a pending read timeout into a retryable error and then recovers', async () => {
    vi.useFakeTimers();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms); return controller.signal;
    });
    f.fetch.mockImplementation((url: string, init: RequestInit) => url.includes('gate_config') ? new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))) : Promise.resolve(reply({ tasks: [] })));
    render(panel()); await act(async () => {}); expect(toggle().closest('fieldset')).toHaveProperty('disabled', true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(deadline).toHaveBeenCalledWith(10_000); const alert = screen.getByRole('alert'); expect(alert.textContent).toContain('could not be loaded');
    f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { tasks: [] }));
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(toggle().closest('fieldset')).toHaveProperty('disabled', false); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('serializes rapid writes, sends only the patch and publishes the confirmed response', async () => {
    const pending = deferred(); f.write.mockReturnValue(pending.promise); render(panel()); await ready();
    act(() => { fireEvent.click(toggle()); fireEvent.click(toggle()); }); expect(f.write).toHaveBeenCalledOnce();
    expect(JSON.parse(f.write.mock.calls[0][1].body)).toEqual({ autoProcessEnabled: true }); expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await act(async () => pending.resolve(reply({ ...gate, autoProcessEnabled: true })));
    await screen.findByText('Background settings saved.'); expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it.each([reply({ error: 'Denied' }, 403), reply({ success: true }), reply(gate)])('keeps the confirmed state when a write receipt is failed, missing or disagrees %#', async response => {
    f.write.mockResolvedValue(response); render(panel()); await ready(); fireEvent.click(toggle());
    await screen.findByRole('alert'); expect(toggle().getAttribute('aria-pressed')).toBe('false'); expect(screen.queryByText('Background settings saved.')).toBeNull();
    f.write.mockResolvedValue(reply({ ...gate, autoProcessEnabled: true })); fireEvent.click(toggle()); await screen.findByText('Background settings saved.');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('clears old account state immediately and ignores a late initial read', async () => {
    const old = deferred(), next = deferred(); f.fetch.mockImplementation(async (url: string) => url.includes('gate_config') ? old.promise : reply({ tasks: [] }));
    const view = render(panel()); const oldSignal = f.fetch.mock.calls[0][1].signal;
    f.user = { uid: 'fixture-b' }; f.fetch.mockImplementation(async (url: string) => url.includes('gate_config') ? next.promise : reply({ tasks: [] })); view.rerender(panel());
    await act(async () => old.resolve(reply({ ...gate, autoProcessEnabled: true }))); expect(oldSignal.aborted).toBe(true); expect(toggle().closest('fieldset')).toHaveProperty('disabled', true);
    await act(async () => next.resolve(reply(gate))); await ready(); expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('cancels obsolete writes across scope changes without publishing their receipt or error', async () => {
    const old = deferred(); f.write.mockReturnValue(old.promise); const view = render(panel()); await ready(); fireEvent.click(toggle()); const signal = f.write.mock.calls[0][1].signal;
    f.workDomain = 'work'; f.orgConnection = { orgId: 'fixture-org' }; view.rerender(panel()); await ready();
    await act(async () => old.resolve(reply({ ...gate, autoProcessEnabled: true }))); expect(signal.aborted).toBe(true); expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Background settings saved.')).toBeNull(); expect(f.error).not.toHaveBeenCalled();
  });

  it('invalidates confirmed controls when the same account loses its role', async () => {
    f.user = { uid: 'fixture-a', role: 'admin' }; const view = render(panel()); await ready();
    f.user = { uid: 'fixture-a', role: 'user' }; f.fetch.mockResolvedValue(reply({ error: 'Denied' }, 403)); view.rerender(panel());
    expect(toggle().closest('fieldset')).toHaveProperty('disabled', true); await screen.findAllByRole('alert'); expect(f.write).not.toHaveBeenCalled();
  });

  it('does not fetch protected configuration after logout or accept a late saved result after unmount', async () => {
    const old = deferred(); f.write.mockReturnValue(old.promise); const view = render(panel()); await ready(); fireEvent.click(toggle()); const signal = f.write.mock.calls[0][1].signal;
    view.unmount(); await act(async () => old.resolve(reply({ error: 'late' }, 500))); expect(signal.aborted).toBe(true); expect(f.error).not.toHaveBeenCalled();
    f.user = null; f.fetch.mockClear(); render(panel()); await screen.findAllByRole('alert'); expect(f.fetch).not.toHaveBeenCalled(); expect(toggle().closest('fieldset')).toHaveProperty('disabled', true);
  });
});

describe('scheduled routine receipt handling without running tasks', () => {
  const task = { id: 'synthetic/id', enabled: false, cron: '0 * * * *' };
  const tasksReady = async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: /Scheduled routines/i }));
    return screen.findByRole('button', { name: task.id });
  };
  it('distinguishes read denial from an empty list and retries the list', async () => {
    f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { error: 'Denied' }, url.includes('gate_config') ? 200 : 403)); render(panel());
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('routines could not be loaded');
    f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { tasks: [] })); fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: /Scheduled routines/i })); await screen.findByText('No scheduled routines are registered.'); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('serializes a routine toggle, encodes its ID and updates only the confirmed task', async () => {
    const pending = deferred(); f.write.mockReturnValue(pending.promise); f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { tasks: [task] })); render(panel());
    const button = await tasksReady(); act(() => { fireEvent.click(button); fireEvent.click(button); }); expect(f.write).toHaveBeenCalledOnce();
    expect(f.write.mock.calls[0][0]).toBe('/api/scheduler/tasks/synthetic%2Fid/toggle'); expect(button.getAttribute('aria-pressed')).toBe('false');
    await act(async () => pending.resolve(reply({ id: task.id, enabled: true }))); await screen.findByText('Routine setting saved.'); expect(button.getAttribute('aria-pressed')).toBe('true');
  });
  it.each([reply({ error: 'Denied' }, 403), reply({ id: 'wrong-id', enabled: true }), reply({ id: task.id })])('retains the routine after a failed or invalid mutation receipt %#', async result => {
    f.write.mockResolvedValue(result); f.fetch.mockImplementation(async (url: string) => reply(url.includes('gate_config') ? gate : { tasks: [task] })); render(panel());
    const button = await tasksReady(); fireEvent.click(button); const alert = await screen.findByRole('alert'); expect(button.getAttribute('aria-pressed')).toBe('false'); expect(button).toHaveProperty('disabled', true);
    expect(screen.queryByText('Routine setting saved.')).toBeNull();
    fireEvent.click(button); expect(f.write).toHaveBeenCalledOnce();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: task.id })).toHaveProperty('disabled', false));
    expect(f.write).toHaveBeenCalledOnce();
  });
});

describe('founder concept details are local explanatory content', () => {
  it.each(['en', 'zh'] as const)('opens every concept, explains limits and closes it in %s without external actions', locale => {
    const copy = foundersSanctuaryCopy(locale), open = vi.spyOn(window, 'open').mockReturnValue(null), onBack = vi.fn();
    render(<FoundersSanctuary t={locale === 'zh' ? zhCatalog : { langCode: locale }} onBack={onBack} />);
    expect(screen.queryByText('VERIFIED')).toBeNull(); expect(screen.queryByText('ENCRYPTED')).toBeNull(); expect(screen.queryByText('STABLE')).toBeNull();
    for (let index = 0; index < copy.concepts.length; index++) {
      const buttons = screen.getAllByRole('button', { name: copy.open }); fireEvent.click(buttons[index]);
      const region = screen.getByRole('region', { name: copy.concepts[index].title });
      expect(within(region).getByText(copy.concepts[index].current)).toBeTruthy(); expect(within(region).getByText(copy.concepts[index].next)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy.close }).getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: copy.close })); expect(screen.queryByRole('region')).toBeNull();
    }
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(onBack).not.toHaveBeenCalled();
  });
  it('keeps one selected detail and follows a locale change without claiming legacy status labels', () => {
    const view = render(<FoundersSanctuary t={{ langCode: 'en', blueprintStatusVerified: 'VERIFIED' }} onBack={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Read concept' })[0]); fireEvent.click(screen.getAllByRole('button', { name: 'Read concept' })[0]);
    expect(screen.getAllByRole('region')).toHaveLength(1); expect(screen.getByRole('region', { name: 'Zero-Knowledge Mesh' })).toBeTruthy();
    view.rerender(<FoundersSanctuary t={zhCatalog} onBack={vi.fn()} />); expect(screen.getByRole('region', { name: '零知识网格' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Archive' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Read concept' })).toBeNull(); expect(screen.queryByText('VERIFIED')).toBeNull();
  });
});
