// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SystemExplorer } from '../src/components/SystemExplorer';
import { extractSourceExpression } from './source_expression';
const fixture = vi.hoisted(() => ({ api: vi.fn(), sensors: vi.fn(), native: vi.fn(), uid: 'first', authorized: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.native }));
vi.mock('../src/services/apiClient', async () => ({ apiJson: (await import('./source_expression')).extractSourceExpression('src/services/apiClient.ts', 'apiJson', { apiFetch: fixture.api }) }));
vi.mock('../src/services/sensorPermissionService', () => ({ getSensorPermissionSnapshot: fixture.sensors, SENSOR_PERMISSIONS_CHANGED: 'sensors-changed' }));
vi.mock('../src/hooks/usePlatform', () => ({ usePlatform: () => ({ isDesktop: false, isTauri: false }) }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.uid, role: 'admin' }, workDomain: 'personal' }) }));
vi.mock('../src/hooks/useRuntimeStatus', () => ({ useRuntimeStatus: () => ({}) }));
vi.mock('../src/hooks/useLumiScene', () => ({ useLumiScene: () => ({}) }));
vi.mock('../src/components/RuntimeEvidencePanel', () => ({ RuntimeEvidencePanel: () => null }));
vi.mock('../src/components/LumiScenePanel', () => ({ LumiScenePanel: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { toast } from 'sonner';
const page = (langCode = 'en') => React.createElement(SystemExplorer, { t: { langCode } });
const snapshot = (hostname: string) => ({ id: hostname, hardware: { hostname }, type: 'daily_scan' });
const reply = (data: any, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => data });
const defaultReply = (url: string) => reply(url.endsWith('/status') ? { authorized: fixture.authorized, latest: snapshot(fixture.uid) } : url.endsWith('/history') ? { snapshots: [snapshot('history-only')] } : {});
function pending() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { fixture.uid = 'first'; fixture.authorized = true; fixture.api.mockImplementation(async (url: string) => defaultReply(url)); fixture.sensors.mockResolvedValue({ microphone: 'granted' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); fixture.api.mockReset(); fixture.sensors.mockReset(); fixture.native.mockReset(); });

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

const telemetry = { computerScope: 'lumi_server_host', cpu: 24, cpuModel: 'Synthetic CPU', logicalCpus: 8, physicalCpus: null, cpus: 8,
  ram: { used: 6, total: 16, percent: 37.5 }, gpu: null, platform: 'test-os', release: 'release', arch: 'x64', hostname: 'server-machine', uptime: 200 };
const nativeInfo = { cpu_model: 'Native CPU', logical_cpus: 12, cpus: 6, platform: 'native-os', release: 'native-release', arch: 'arm64' };
const nativeLive = { cpu_percent: 0, memory_used_gb: 4, memory_total_gb: 32, memory_percent: 12.5, gpu_vendor: 'Native GPU', gpu_utilization: 0, hostname: 'native-machine', uptime_seconds: 0 };
async function telemetryService(host = 'web') {
  if (host !== 'web') vi.stubGlobal(host === 'tauri' ? '__TAURI_INTERNALS__' : 'lumiElectron', {});
  vi.resetModules(); return (await import('../src/services/systemService')).systemService;
}

it.each(['web', 'electron'])('%s telemetry propagates read errors and malformed samples instead of zero statistics', async host => {
  const service = await telemetryService(host), signal = new AbortController().signal;
  for (const response of [reply({ error: 'Stats denied' }, false), reply({}), reply({ ...telemetry, cpu: NaN })]) {
    fixture.api.mockResolvedValueOnce(response); await expect(service.getSystemStats(signal)).rejects.toThrow();
  }
  fixture.api.mockResolvedValueOnce(reply(telemetry)); expect(await service.getSystemStats(signal)).toEqual(telemetry);
  expect(fixture.api).toHaveBeenCalledTimes(4); expect(fixture.api.mock.calls.every(([, init]) => init.signal === signal)).toBe(true);
});

it('keeps native samples together and falls back to a complete server snapshot without mixing machines', async () => {
  const service = await telemetryService('tauri'), signal = new AbortController().signal;
  fixture.native.mockImplementation(async command => command === 'get_system_info' ? nativeInfo : nativeLive);
  const first = await service.getSystemStats(signal); expect(first).toMatchObject({ computerScope: 'native_client', hostname: 'native-machine', cpu: 0, cpuModel: 'Native CPU', uptime: 0, physicalCpus: 6, ram: { total: 32 }, gpu: { name: 'Native GPU', util: 0 } });
  await service.getSystemStats(signal); expect(fixture.native.mock.calls.filter(([name]) => name === 'get_system_info')).toHaveLength(1); expect(fixture.api).not.toHaveBeenCalled();
  fixture.native.mockRejectedValueOnce(new Error('Native read failed')); fixture.api.mockResolvedValueOnce(reply(telemetry)); expect(await service.getSystemStats(signal)).toEqual(telemetry);
  fixture.native.mockResolvedValue({}); fixture.api.mockResolvedValueOnce(reply({ error: 'Backend unavailable' }, false)); await expect(service.getSystemStats(signal)).rejects.toThrow('Backend unavailable');
});

it('ends a stalled native wait on cancellation without a fallback read or leaked abort listener', async () => {
  const service = await telemetryService('tauri'), deferred = pending(), owner = new AbortController();
  const add = vi.spyOn(owner.signal, 'addEventListener'), remove = vi.spyOn(owner.signal, 'removeEventListener');
  fixture.native.mockImplementation(command => command === 'get_system_info' ? Promise.resolve(nativeInfo) : deferred.promise);
  const result = service.getSystemStats(owner.signal); await vi.waitFor(() => expect(fixture.native).toHaveBeenCalledTimes(2));
  owner.abort(new Error('Telemetry deadline')); await expect(result).rejects.toThrow('Telemetry deadline'); expect(fixture.api).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]); deferred.resolve(nativeLive);
});

async function monitor() {
  const deps: any = { React, Suspense: React.Suspense, useState: React.useState, useEffect: React.useEffect, AbortController, AbortSignal, setTimeout, clearTimeout,
    useApp: () => ({ user: fixture.uid ? { uid: fixture.uid, role: 'admin' } : null }), systemService: await telemetryService(), uiMessage: (key: string) => key.split('.')[1],
    SystemExplorer: () => React.createElement('div', {}, 'Computer exploration remains available'), LazyPanelFallback: () => null, Cpu: () => null, Monitor: () => null,
    motion: { div: ({ children, style }: any) => React.createElement('div', { 'data-testid': style?.minWidth ? 'sample' : undefined }, children) } };
  deps.KernelMonitorView = extractSourceExpression('src/components/desktop/kernel_monitor.tsx', 'KernelMonitorView', deps);
  return extractSourceExpression('src/components/desktop/kernel_monitor.tsx', 'KernelMonitorApp', deps);
}

it('monitor serializes slow reads, removes failed samples and recovers without displaying false idle data', async () => {
  vi.useFakeTimers(); const Panel = await monitor(), first = pending(); fixture.api.mockReturnValueOnce(first.promise); const view = render(React.createElement(Panel, { t: {} }));
  expect(screen.getByRole('status').textContent).toBe('Loading'); expect(screen.queryByText(/IDLE/)).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(fixture.api).toHaveBeenCalledOnce();
  await act(async () => first.resolve(reply({ error: 'Telemetry offline' }, false))); expect(screen.getByRole('alert').textContent).toBe('Telemetry offline'); expect(screen.queryByText(/IDLE/)).toBeNull();
  fixture.api.mockResolvedValue(reply(telemetry)); await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText(/server-machine/).textContent).toContain('lumi-server-host'); expect(screen.getAllByTestId('sample')).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(screen.getAllByTestId('sample')).toHaveLength(2);
  fixture.api.mockResolvedValue(reply({ ...telemetry, hostname: 'replacement-machine' })); await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(screen.getAllByTestId('sample')).toHaveLength(1);
  fixture.api.mockResolvedValue(reply({ error: 'Read lost' }, false)); await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole('alert').textContent).toBe('Read lost'); expect(screen.queryByText(/server-machine/)).toBeNull(); expect(screen.queryAllByTestId('sample')).toHaveLength(0);
  expect(screen.getByText('Computer exploration remains available')).toBeTruthy(); view.unmount(); const calls = fixture.api.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(fixture.api).toHaveBeenCalledTimes(calls);
});

it('monitor isolates account changes and ignores late results after unmount', async () => {
  const Panel = await monitor(), old = pending(); fixture.api.mockReturnValueOnce(old.promise); const view = render(React.createElement(Panel, { t: {} })); const signal = fixture.api.mock.calls[0][1].signal;
  fixture.uid = 'next'; fixture.api.mockResolvedValue(reply(telemetry)); view.rerender(React.createElement(Panel, { t: {} })); await screen.findByText(/server-machine/); expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(reply({ ...telemetry, hostname: 'old-machine' }))); expect(screen.queryByText(/old-machine/)).toBeNull();
  fixture.uid = ''; view.rerender(React.createElement(Panel, { t: {} })); expect(screen.queryByText(/server-machine/)).toBeNull(); expect(fixture.api.mock.calls.at(-1)![1].signal.aborted).toBe(true);
});

describe('computer exploration UI wiring', () => {
  it('offers explicit allow and decline actions in System Explorer', () => {
    const explorer = source('src/components/SystemExplorer.tsx');

    expect(explorer).toContain('body: JSON.stringify({ granted: scan })');
    expect(explorer).toContain('updateExploration(true)');
    expect(explorer).toContain('updateExploration(false)');
    expect(explorer).toContain('consentCopy.allowLocalScan');
    expect(explorer).toContain('consentCopy.notNow');
  });

  it('routes evidence-backed onboarding and profile questions into a real chat submission', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const explorer = source('src/components/SystemExplorer.tsx');

    expect(desktop).toContain('const askComputerProfileQuestion = useCallback');
    expect(desktop).toContain("openCommandCenter('office')");
    expect(desktop).toContain("new CustomEvent('lumi:replace-command-input'");
    expect(desktop).toContain("new CustomEvent('lumi:submit-command-input')");
    expect(desktop).toContain('onAsk={askComputerProfileQuestion}');
    expect(desktop).toContain('<KernelMonitorApp t={t} onAsk={askComputerProfileQuestion} />');
    expect(explorer).toContain('(latest.capabilityProfile.firstQuestions || []).slice(0, 6)');
    expect(explorer).toContain('onClick={() => onAsk?.(prompt)}');
  });
});

it('keeps scan results authoritative across language refresh and preserves separate history', async () => {
  const scan = pending();
  fixture.api.mockImplementation((url: string) => url.endsWith('/scan') ? scan.promise : Promise.resolve(defaultReply(url)));
  const view = render(page()); await screen.findByText('first');
  expect(screen.queryByText('history-only')).toBeNull();
  const button = screen.getByRole('button', { name: /refresh report/i });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  view.rerender(page('zh'));
  expect(fixture.api.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(1);
  expect(fixture.api.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
  await act(async () => { scan.resolve(reply({ snapshot: snapshot('new-scan') })); });
  expect(await screen.findByText('new-scan')).toBeTruthy();
  expect(toast.success).toHaveBeenCalledTimes(1);
});

it('rejects late report data and closes an old account before its consent can start a scan', async () => {
  fixture.authorized = false;
  const grant = pending(), older = pending();
  fixture.api.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/consent') ? grant.promise : Promise.resolve(defaultReply(url)));
  const view = render(page()); await screen.findByText('first');
  fireEvent.click(screen.getByRole('button', { name: 'Allow local adaptation scan' }));
  const signal = fixture.api.mock.calls.find(([url]) => url.endsWith('/consent'))![1].signal;
  fixture.uid = 'second'; view.rerender(page());
  expect(screen.queryByText('first')).toBeNull(); await screen.findByText('second');
  await act(async () => { grant.resolve(reply({ authorized: true, consent: { status: 'granted' } })); });
  expect(signal.aborted).toBe(true);
  expect(fixture.api.mock.calls.some(([url]) => url.endsWith('/scan'))).toBe(false);
  fixture.api.mockImplementationOnce(() => older.promise); view.rerender(page('zh'));
  await waitFor(() => expect(fixture.api.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(3));
  view.rerender(page()); await screen.findByText('second');
  await act(async () => { older.resolve(reply({ latest: snapshot('stale-account') })); });
  expect(screen.queryByText('stale-account')).toBeNull();
  expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled();
});

it('sends the explicit consent choice, stops on rejection, and rejects an empty scan result', async () => {
  fixture.authorized = false;
  fixture.api.mockImplementation(async (url: string, init?: RequestInit) => url.endsWith('/consent')
    ? JSON.parse(String(init?.body)).granted ? reply({ error: 'consent rejected' }, false) : reply({ authorized: false }) : defaultReply(url));
  render(React.createElement(React.StrictMode, {}, page())); await screen.findByText('first');
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  await screen.findByText('Current choice: not allowed');
  fireEvent.click(screen.getByRole('button', { name: 'Allow local adaptation scan' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('consent rejected'));
  expect(fixture.api.mock.calls.filter(([url]) => url.endsWith('/consent')).map(([, init]) => JSON.parse(init.body).granted)).toEqual([false, true]);
  expect(fixture.api.mock.calls.some(([url]) => url.endsWith('/scan'))).toBe(false);
  fixture.api.mockImplementation(async (url: string) => url.endsWith('/consent') ? reply({ authorized: true }) : defaultReply(url));
  fireEvent.click(screen.getByRole('button', { name: 'Allow local adaptation scan' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The computer scan returned no result.'));
  expect(toast.success).toHaveBeenCalledTimes(1);
});

it('updates visible sensor status without stale responses or events after unmount', async () => {
  const older = pending(), afterClose = pending();
  fixture.sensors.mockReturnValueOnce(older.promise);
  fixture.api.mockImplementation(async (url: string) => url.startsWith('/api/files') ? reply({ error: 'unavailable' }, false) : defaultReply(url));
  const view = render(page()); await screen.findByText('first');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const microphone = () => screen.getByText('Microphone').parentElement!.textContent;
  await waitFor(() => expect(microphone()).toMatch(/granted/i));
  await act(async () => { older.resolve({ microphone: 'denied' }); });
  expect(microphone()).toMatch(/granted/i);
  fixture.sensors.mockReturnValueOnce(afterClose.promise);
  act(() => window.dispatchEvent(new Event('sensors-changed'))); view.unmount();
  const calls = fixture.sensors.mock.calls.length;
  await act(async () => { afterClose.resolve({ microphone: 'denied' }); window.dispatchEvent(new Event('sensors-changed')); });
  expect(fixture.sensors).toHaveBeenCalledTimes(calls); expect(toast.error).not.toHaveBeenCalled();
});
