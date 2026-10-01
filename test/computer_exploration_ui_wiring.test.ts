// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SystemExplorer } from '../src/components/SystemExplorer';
const fixture = vi.hoisted(() => ({ api: vi.fn(), sensors: vi.fn(), uid: 'first', authorized: true }));
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); fixture.api.mockReset(); fixture.sensors.mockReset(); });

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

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
