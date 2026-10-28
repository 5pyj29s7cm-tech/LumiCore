// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XiaozhiLocalDevices } from './XiaozhiLocalDevices';
import type { XiaozhiServiceSnapshot } from '../../server/devices/xiaozhi_service';

const fetchMock = vi.fn();
const base = '/api/devices/xiaozhi';
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const configuration = { id: 'binding-a', expiresAt: '2026-10-28T09:05:00.000Z', otaUrl: 'http://10.42.0.5:17840/api/devices/xiaozhi/bootstrap/binding-a?token=synthetic-private-token' };
function snapshot(withDevice = false): XiaozhiServiceSnapshot {
  return { devices: withDevice ? [{ id: 'binding-a', ownerUid: 'owner-a', deviceId: '02:00:00:00:00:42', clientId: null,
    localAddress: '10.42.0.5', state: 'pending', connected: false, observedAt: '2026-10-28T09:00:00.000Z',
    pairingExpiresAt: configuration.expiresAt, pairedAt: null, audioSupported: false,
    toolState: 'disconnected', toolCount: 0, registeredToolNames: [], toolError: null }] : [],
  errors: [], listener: { state: withDevice ? 'listening' : 'stopped', localAddress: withDevice ? '10.42.0.5' : null, port: withDevice ? 17840 : null } };
}
let current: XiaozhiServiceSnapshot;
const reads = (path = base) => fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === path);
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('lumi_auth_token', 'synthetic-auth'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-desktop-proof');
  fetchMock.mockReset(); current = snapshot();
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === base) return reply(current);
    if (path === base + '/interfaces') return reply({ interfaces: [{ name: 'Ethernet', address: '10.42.0.5', netmask: '255.255.255.0' }] });
    if (path === base + '/pairings') { current = snapshot(true); return reply({ ...configuration, mcpUrl: 'ws://127.0.0.1/private-bridge?token=never-display' }, 201); }
    if (path.endsWith('/configuration')) return reply(configuration);
    if (init.method === 'DELETE') { current = snapshot(); return reply({ ok: true }); }
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const renderOwner = (scope = 'owner-a') => render(<XiaozhiLocalDevices scope={scope} lang="en" />);
async function openForm() { fireEvent.click(await screen.findByRole('button', { name: 'Connect a local Xiaozhi device' })); await screen.findByRole('combobox', { name: 'Local LAN interface' }); }

describe('local Xiaozhi management uses actual scoped gateway receipts', () => {
  it('starts with one compact connection entry and defers interface enumeration until the form opens', async () => {
    const view = renderOwner(); await screen.findByRole('button', { name: 'Connect a local Xiaozhi device' });
    expect(screen.queryByRole('textbox')).toBeNull(); expect(reads(base + '/interfaces')).toHaveLength(0);
    expect(view.container.querySelectorAll('button')).toHaveLength(1);
    const request = reads()[0][1]; expect(new Headers(request.headers).get('Authorization')).toBe('Bearer synthetic-auth');
    expect(new Headers(request.headers).get('x-lumi-desktop-session')).toBe('synthetic-desktop-proof');
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).pathname.startsWith(base))).toBe(true);
  });

  it('creates only the explicit identity/interface pairing and keeps private configuration in the expanded view alone', async () => {
    const view = renderOwner(); await openForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Known device ID' }), { target: { value: '02:00:00:00:00:42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate configuration address' }));
    const ota = await screen.findByRole('textbox', { name: 'Device OTA server URL' }); expect((ota as HTMLTextAreaElement).value).toBe(configuration.otaUrl);
    const create = reads(base + '/pairings')[0][1]; expect(create.method).toBe('POST');
    expect(JSON.parse(create.body)).toEqual({ deviceId: '02:00:00:00:00:42', localAddress: '10.42.0.5' });
    expect(view.container.textContent).toContain('Back up the current ota_url');
    expect(view.container.textContent).toContain('only MCP device tools'); expect(view.container.textContent).toContain('Wake or press');
    expect(view.container.textContent).not.toContain('never-display'); expect(screen.queryByRole('link')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('synthetic-private-token');
    fireEvent.click(screen.getByRole('button', { name: 'Close configuration' })); expect(screen.queryByDisplayValue(configuration.otaUrl)).toBeNull();
  });

  it.each(['initializing', 'error', 'registered'] as const)('separates an actual device connection from the %s tool state', async toolState => {
    current = snapshot(true); Object.assign(current.devices[0], { connected: true, toolState, toolCount: 1, registeredToolNames: ['synthetic_read_status'], toolError: toolState === 'error' ? 'Catalogue rejected by device' : null });
    renderOwner(); await screen.findByRole('heading', { name: '02:00:00:00:00:42' });
    const row = screen.getByRole('article'); expect(within(row).getByText('Device connected')).toBeTruthy();
    expect(Boolean(within(row).queryByText('Available in chat'))).toBe(toolState === 'registered');
    if (toolState === 'error') expect(within(row).getByText('Tool connection failed')).toBeTruthy();
    expect(row.textContent).not.toContain('Catalogue rejected by device');
  });

  it('never presents a stale registered state as usable when the device is disconnected', async () => {
    current = snapshot(true); current.devices[0].toolState = 'registered'; renderOwner();
    await screen.findByText('Device disconnected'); expect(screen.queryByText('Available in chat')).toBeNull();
  });

  it('keeps a connected, successfully registered empty tool catalogue unavailable in chat', async () => {
    current = snapshot(true); Object.assign(current.devices[0], { connected: true, toolState: 'registered', toolCount: 0, registeredToolNames: [] });
    renderOwner(); await screen.findByText('Device connected');
    expect(screen.queryByText('Available in chat')).toBeNull(); expect(screen.getByText('Not available in chat')).toBeTruthy();
  });

  it('preserves snapshot and listener failures instead of manufacturing an empty list', async () => {
    current.errors = [{ code: 'restore_failed', message: 'Private binding repository could not be opened' }]; current.listener.state = 'error';
    renderOwner(); await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('Private binding repository could not be opened');
    expect(screen.getByRole('heading', { name: 'Local Xiaozhi devices' })).toBeTruthy();
  });

  it('shows the actual admission error and stops automatic authentication retries', async () => {
    vi.useFakeTimers(); fetchMock.mockResolvedValue(reply({ error: 'A valid local control-center session is required.' }, 403));
    renderOwner(); await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('HTTP 403: A valid local control-center session is required.');
    expect(screen.queryByRole('button', { name: 'Connect a local Xiaozhi device' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(reads()).toHaveLength(1);
  });

  it('polls only the lightweight snapshot, pauses while hidden and aborts the active observation', async () => {
    vi.useFakeTimers(); const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    renderOwner(); await act(async () => {}); expect(reads()).toHaveLength(1);
    const held = deferred<any>(); fetchMock.mockReturnValueOnce(held.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(reads()).toHaveLength(2);
    const signal = reads()[1][1].signal;
    hidden.mockReturnValue(true); act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); held.resolve(reply(snapshot(true))); }); expect(reads()).toHaveLength(2);
    expect(screen.queryByText('02:00:00:00:00:42')).toBeNull();
    hidden.mockReturnValue(false); act(() => document.dispatchEvent(new Event('visibilitychange'))); await act(async () => {});
    expect(reads()).toHaveLength(3); expect(reads(base + '/interfaces')).toHaveLength(0);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).pathname === base)).toBe(true);
  });

  it('waits for visibility and avoids a duplicate initial snapshot during StrictMode replay', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(<React.StrictMode><XiaozhiLocalDevices scope="owner-a" lang="en" /></React.StrictMode>); await act(async () => {}); expect(reads()).toHaveLength(0);
    hidden.mockReturnValue(false); act(() => document.dispatchEvent(new Event('visibilitychange')));
    await screen.findByRole('button', { name: 'Connect a local Xiaozhi device' }); expect(reads()).toHaveLength(1);
  });

  it('starts one snapshot on an initially visible StrictMode mount', async () => {
    render(<React.StrictMode><XiaozhiLocalDevices scope="owner-a" lang="en" /></React.StrictMode>);
    await screen.findByRole('button', { name: 'Connect a local Xiaozhi device' }); expect(reads()).toHaveLength(1);
  });

  it('clears old private configuration immediately on owner change and ignores an aborted prior owner response', async () => {
    current = snapshot(true); const view = renderOwner(); fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    await screen.findByDisplayValue(configuration.otaUrl);
    const held = deferred<any>(); const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname.endsWith('/configuration') ? held.promise : handler(url, init));
    fireEvent.click(screen.getByRole('button', { name: 'Close configuration' })); fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    await waitFor(() => expect(reads(base + '/pairings/binding-a/configuration')).toHaveLength(2));
    const signal = reads(base + '/pairings/binding-a/configuration')[1][1].signal; current = snapshot();
    view.rerender(<XiaozhiLocalDevices scope="owner-b" lang="en" />); expect(signal.aborted).toBe(true);
    expect(screen.queryByText('02:00:00:00:00:42')).toBeNull(); expect(screen.queryByDisplayValue(configuration.otaUrl)).toBeNull();
    await act(async () => held.resolve(reply(configuration))); await screen.findByRole('button', { name: 'Connect a local Xiaozhi device' });
    expect(screen.queryByDisplayValue(configuration.otaUrl)).toBeNull();
  });

  it('reports interface and configuration errors within their panels without making up a usable address', async () => {
    const handler = fetchMock.getMockImplementation()!; fetchMock.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname.endsWith('/interfaces')
      ? Promise.resolve(reply({ error: 'Physical interface inventory is unavailable' }, 503)) : handler(url, init));
    renderOwner(); fireEvent.click(await screen.findByRole('button', { name: 'Connect a local Xiaozhi device' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Physical interface inventory is unavailable');
    expect((screen.getByRole('button', { name: 'Generate configuration address' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByDisplayValue(configuration.otaUrl)).toBeNull();
  });

  it('does not claim a failed revoke succeeded or automatically replay the deletion', async () => {
    current = snapshot(true); const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init: RequestInit) => init.method === 'DELETE' ? Promise.resolve(reply({ error: 'Binding persistence failed' }, 503)) : handler(url, init));
    renderOwner(); fireEvent.click(await screen.findByRole('button', { name: 'Configure' })); await screen.findByDisplayValue(configuration.otaUrl);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke local access' })); await screen.findByText('HTTP 503: Binding persistence failed');
    expect(screen.getByRole('heading', { name: '02:00:00:00:00:42' })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
  });

  it('aborts a pending pairing and removes snapshot polling when its view closes', async () => {
    vi.useFakeTimers(); const view = renderOwner(); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Connect a local Xiaozhi device' })); await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'Known device ID' }), { target: { value: '02:00:00:00:00:42' } });
    const held = deferred<any>(); const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init: RequestInit) => init.method === 'POST' ? held.promise : handler(url, init));
    fireEvent.click(screen.getByRole('button', { name: 'Generate configuration address' })); const signal = reads(base + '/pairings')[0][1].signal;
    const count = fetchMock.mock.calls.length; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { held.resolve(reply(configuration, 201)); await vi.advanceTimersByTimeAsync(15000); }); expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(screen.queryByDisplayValue(configuration.otaUrl)).toBeNull();
  });
});
