// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSyncCenter } from './DeviceSyncCenter';
import { DesktopDeviceWidget } from './DesktopDeviceWidget';
import { RemoteMCPSettings } from './RemoteMCPSettings';
import type { ExternalDevicesSnapshot } from '../../shared/external_devices';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), on: vi.fn(), off: vi.fn() }));
const account = vi.hoisted(() => ({ user: { uid: 'device-view-user', role: 'admin' } as { uid: string; role: string; orgId?: string } | null,
  workDomain: 'personal' as 'personal' | 'work', orgConnection: null as { orgId: string } | null }));
vi.mock('@/contexts/AppContext', () => ({ useApp: () => account }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('./ClientConnectionStatus', () => ({ ClientConnectionStatus: () => <span>Client transport receipt</span> }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const observedAt = '2026-10-28T04:30:00.000Z';
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function snapshot(): ExternalDevicesSnapshot {
  return {
    observedAt,
    usb: { supported: true, status: 'ok', platform: 'win32', observedAt, errors: [], limitations: [], devices: [{
      instanceId: 'USB\\VID_1234&PID_5678\\fixture-a', instanceEnumerator: 'USB', category: 'ports_class', name: 'Generic serial bridge', className: 'Ports',
      manufacturer: null, status: 'OK', problemCode: 0, cimStatus: 'OK', configManagerErrorCode: 0, service: 'serial', hardwareIds: [], vid: '1234', pid: '5678',
      portName: 'COM41', registryPortName: 'COM41', serialPortName: null, portNameSource: 'device_parameters',
      driver: { provider: 'Example provider', version: '4.2.0', date: null, infName: 'oem41.inf', isSigned: false },
    }] },
    printers: { supported: true, status: 'ok', platform: 'win32', observedAt, errors: [], ports: [], printers: [{
      name: 'Shared label', isDefault: false, workOffline: true, cimPrinterStatus: 3, queueStatus: 'Offline', detectedErrorState: 0,
      portName: 'USB004', driverName: 'Installed queue driver', isLocal: true, isNetwork: false, isShared: false, queueType: 'Local', jobCount: 0, jobs: [], jobsError: null,
    }] },
    lan: { ok: true, status: 'completed', startedAt: observedAt, finishedAt: observedAt, timeoutMs: 2000, interfaces: [], errors: [], limitations: [], truncated: false, candidates: [{
      id: 'ipp-a', kind: 'printer', protocol: 'mdns', serviceType: '_ipp._tcp.local', name: 'Shared label', addresses: ['10.42.0.31'],
      host: 'printer-a.local', port: 631, path: '/ipp/print', txt: { UUID: 'fixture-uuid-a', rp: 'ipp/print' },
      source: { interfaceName: 'Ethernet', localAddress: '10.42.0.5', responderAddress: '10.42.0.9' }, paired: false,
    }] },
  };
}

let external: any;
let statusResponse: any;
beforeEach(() => {
  account.user = { uid: 'device-view-user', role: 'admin' }; account.workDomain = 'personal'; account.orgConnection = null;
  localStorage.clear(); mocks.fetch.mockReset(); mocks.on.mockReset(); mocks.off.mockReset();
  external = snapshot(); statusResponse = { ok: true, status: 'observed', scope: 'control_center_lan', observedAt,
    target: { address: '10.42.0.31', port: 631, resourcePath: '/ipp/print' }, ippStatusCode: 0, state: 'idle', attributes: { 'printer-name': ['Protocol printer'], 'queued-job-count': [0], 'printer-is-accepting-jobs': [false] },
    warnings: [{ code: 'missing_content_type', message: 'Validated complete response without MIME metadata' }], limitations: [] };
  mocks.fetch.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/devices/xiaozhi') return reply({ devices: [], errors: [], listener: { state: 'stopped', localAddress: null, port: null } });
    if (path === '/api/devices/external') return reply(external);
    if (path === '/api/devices/external/printer-status') return reply(statusResponse);
    if (path === '/api/devices') return reply({ devices: [{ id: 'native-a', name: 'Lumi desktop client', type: 'desktop', status: 'online' }], sensoryContext: null });
    if (path === '/api/remote-devices') return reply({ devices: {} });
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const externalReads = () => mocks.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/devices/external');
const statusReads = () => mocks.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/api/devices/external/printer-status');

describe('device views consume external owner receipts', () => {
  it('keeps USB failures in the main list while moving motherboard and other serial records into diagnostics', async () => {
    const serial = external.usb.devices[0];
    external.usb.devices.push({ ...serial, instanceId: 'ACPI\\PNP0501\\fixture', instanceEnumerator: 'ACPI', name: 'Motherboard serial', portName: 'COM1' });
    external.usb.devices.push({ ...serial, instanceId: 'FTDIBUS\\fixture', instanceEnumerator: 'FTDIBUS', name: 'Derived serial record', portName: 'COM42' });
    external.usb.devices.push({ ...serial, instanceId: 'USB\\VID_4321&PID_8765\\unconfigured', category: 'unconfigured_usb', name: 'Unconfigured USB device', portName: null, problemCode: 28, configManagerErrorCode: 28 });
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Unconfigured USB device');
    const usb = screen.getByRole('region', { name: 'USB devices' });
    expect(within(usb).getAllByRole('article')).toHaveLength(2); expect(usb.textContent).not.toContain('Motherboard serial'); expect(usb.textContent).not.toContain('Derived serial record');
    expect(within(usb).getByText(/Needs attention/)).toBeTruthy();
    expect(screen.getByText('Motherboard serial · COM1').closest('details')!.open).toBe(false);
    expect(screen.getByText('Derived serial record · COM42').closest('details')!.open).toBe(false);
  });

  it('keeps every installed queue in closed print details without treating local WSD flags as proof of a virtual device', async () => {
    external.printers.printers.push({ ...external.printers.printers[0], name: 'Virtual document queue', portName: 'PORTPROMPT:', workOffline: false });
    external.printers.printers.push({ ...external.printers.printers[0], name: 'Physical WSD queue', portName: 'WSD-fixture', workOffline: false, isLocal: true, isNetwork: false });
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Generic serial bridge');
    const queues = screen.getByRole('region', { name: 'System print queues' });
    expect(queues.closest('details')!.open).toBe(false); expect(within(queues).getAllByRole('article')).toHaveLength(3);
    expect(within(queues).getByText('Physical WSD queue')).toBeTruthy(); expect(within(queues).getByText('Virtual document queue')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Read printer status/ })).toHaveLength(1);
  });

  it('shows matching IPP/IPPS services once and reads only the original IPP target', async () => {
    external.lan.candidates[0].name = 'Office printer._ipp._tcp.local';
    external.lan.candidates.unshift({ ...external.lan.candidates[0], id: 'secure-service', serviceType: '_ipps._tcp.local', name: 'Office printer._ipps._tcp.local', port: 443 });
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Generic serial bridge');
    const lan = screen.getByRole('region', { name: 'LAN devices' }); expect(within(lan).getAllByRole('article')).toHaveLength(1);
    expect(within(lan).getByRole('heading', { name: 'Office printer' })).toBeTruthy();
    expect(within(lan).getByText('mdns · _ipps._tcp.local').closest('details')!.open).toBe(false);
    expect(within(lan).getByText('mdns · _ipp._tcp.local').closest('details')!.open).toBe(false);
    fireEvent.click(within(lan).getByRole('button', { name: 'Read printer status' })); await screen.findByText('Idle');
    expect(JSON.parse(statusReads()[0][1].body)).toEqual({ address: '10.42.0.31', port: 631, resourcePath: '/ipp/print' });
  });

  it.each(['host', 'path', 'name', 'interface', 'localAddress', 'uuid', 'addresses', 'sameProtocolPort'])('keeps services separate when advertised %s evidence differs', async difference => {
    const ipps = { ...external.lan.candidates[0], id: 'different-service', serviceType: '_ipps._tcp.local', port: 443,
      source: { ...external.lan.candidates[0].source }, txt: { ...external.lan.candidates[0].txt } };
    if (difference === 'host') ipps.host = 'other-printer.local';
    if (difference === 'path') ipps.path = '/ipp/other';
    if (difference === 'name') ipps.name = 'Different logical printer';
    if (difference === 'interface') ipps.source.interfaceName = 'Other Ethernet';
    if (difference === 'localAddress') ipps.source.localAddress = '10.42.0.6';
    if (difference === 'uuid') ipps.txt.UUID = 'conflicting-advertised-uuid';
    if (difference === 'addresses') ipps.addresses = ['10.42.0.32'];
    if (difference === 'sameProtocolPort') { ipps.serviceType = '_ipp._tcp.local'; ipps.port = 8631; }
    external.lan.candidates.push(ipps);
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Generic serial bridge');
    expect(within(screen.getByRole('region', { name: 'LAN devices' })).getAllByRole('article')).toHaveLength(2);
  });

  it('does not fill an unresolved IPP address from a grouped IPPS advertisement', async () => {
    external.lan.candidates[0].addresses = [];
    external.lan.candidates.push({ ...external.lan.candidates[0], id: 'secure-only-address', serviceType: '_ipps._tcp.local', addresses: ['10.42.0.32'], port: 443 });
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Generic serial bridge');
    const lan = screen.getByRole('region', { name: 'LAN devices' }); expect(within(lan).getAllByRole('article')).toHaveLength(1);
    expect(within(lan).queryByRole('button')).toBeNull(); expect(within(lan).getByText(/Address unresolved/)).toBeTruthy(); expect(statusReads()).toHaveLength(0);
  });

  it.each(['idle', 'processing', 'stopped', 'unrecognized'])('renders %s as a user-facing Chinese state and keeps protocol diagnostics closed', async state => {
    statusResponse.state = state;
    render(<DeviceSyncCenter t={{ langCode: 'zh' }} />); fireEvent.click(await screen.findByRole('button', { name: '读取打印机状态' }));
    const translated = { idle: '待机', processing: '正在打印', stopped: '已停止', unrecognized: '状态未知' }[state]!;
    await screen.findByText(translated); expect(screen.getByText('有诊断提示')).toBeTruthy();
    expect(screen.getByText(/missing_content_type:/).closest('details')!.open).toBe(false);
    expect(screen.getByText('暂不接受打印任务')).toBeTruthy(); expect(screen.getByText('排队任务: 0')).toBeTruthy();
    expect(screen.getByText(state).closest('details')!.open).toBe(false);
    if (state === 'unrecognized') expect(screen.getByText(translated).className).not.toContain('text-emerald');
  });

  it('marks an explicit PnP Error status as needing attention even without numeric problem codes', async () => {
    external.usb.devices[0].status = 'Error'; external.usb.devices[0].problemCode = null; external.usb.devices[0].configManagerErrorCode = null;
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Generic serial bridge');
    expect(within(screen.getByRole('region', { name: 'USB devices' })).getByText(/Needs attention/)).toBeTruthy();
  });

  it('uses unknown counts for failed center sources while retaining brief warnings and detailed receipts', async () => {
    external.usb = { ok: false, status: 'unavailable', observedAt, errors: [{ code: 'observation_failed', message: 'USB read unavailable' }] };
    external.lan.ok = false; external.lan.status = 'unavailable'; external.lan.candidates = []; external.lan.errors = [{ code: 'socket_error', message: 'LAN read unavailable' }];
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('USB devices: Observation unavailable · USB read unavailable');
    expect(within(screen.getByRole('region', { name: 'USB devices' })).getByRole('heading').textContent).toContain('—');
    expect(within(screen.getByRole('region', { name: 'LAN devices' })).getByRole('heading').textContent).toContain('—');
  });

  it('shows successful-source warnings as diagnostic notices rather than an unavailable observation', async () => {
    external.lan.errors = [{ code: 'source_notice', message: 'One additional record was not usable' }];
    render(<DeviceSyncCenter t={{}} />);
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toBe('LAN devices: Diagnostic notice · One additional record was not usable');
    expect(screen.getByRole('button', { name: 'Read printer status' })).toBeTruthy();
  });
  it('separates native clients, present USB metadata, LAN advertisements and old queue state without invented control', async () => {
    const lan = external.lan;
    lan.candidates.push({ ...lan.candidates[0], id: 'ipps-a', serviceType: '_ipps._tcp.local', port: 443 });
    lan.candidates.push({ ...lan.candidates[0], id: 'unresolved', name: 'Unresolved service', addresses: [] });
    lan.candidates.push({ ...lan.candidates[0], id: 'television', name: 'Generic television advertisement', kind: 'tv', serviceType: '_androidtvremote2._tcp.local', port: 6466, path: undefined });
    const view = render(<DeviceSyncCenter t={{}} />);
    await screen.findByText('Generic serial bridge'); expect(screen.getByText('Lumi desktop client')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lumi clients' })).toBeTruthy();
    const usb = screen.getByRole('region', { name: 'USB devices' });
    expect(usb.textContent).toContain('Registry PortName: COM41'); expect(usb.textContent).toContain('PnP problem code: 0');
    expect(usb.textContent).toContain('Configuration error code: 0'); expect(usb.textContent).toContain('Example provider · 4.2.0 · oem41.inf · Unsigned');
    expect(usb.textContent).not.toContain('xiaozhi'); expect(within(usb).queryByRole('button')).toBeNull();
    expect(usb.querySelector('details')!.open).toBe(false);
    const queues = screen.getByRole('region', { name: 'System print queues' });
    expect(queues.textContent).toContain('Shared label'); expect(queues.textContent).toContain('USB004'); expect(queues.textContent).toContain('Offline / true');
    expect(within(queues).queryByRole('button')).toBeNull();
    expect(queues.closest('details')!.open).toBe(false);
    expect(screen.getAllByRole('button', { name: /Read printer status/ })).toHaveLength(1);
    expect(screen.getByText('IPPS advertises TLS; this status reader currently supports IPP over HTTP only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /PAIR|connect device/i })).toBeNull();
    expect(view.container.querySelector('[href^="http://10."]')).toBeNull(); expect(statusReads()).toHaveLength(0);
  });

  it('reads only the selected exact IPP target and renders authenticated confirmed attributes and warnings', async () => {
    localStorage.setItem('lumi_auth_token', 'synthetic-user-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-local-proof');
    render(<DeviceSyncCenter t={{}} />); fireEvent.click(await screen.findByRole('button', { name: /Read printer status/ }));
    await screen.findByText('Idle'); expect(statusReads()).toHaveLength(1);
    const [, init] = statusReads()[0]; expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ address: '10.42.0.31', port: 631, resourcePath: '/ipp/print' });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-user-token');
    expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-local-proof');
    expect(screen.getByText('Diagnostic notice')).toBeTruthy();
    expect(screen.getByText(/missing_content_type: Validated/).closest('details')!.open).toBe(false); expect(screen.getByText('Protocol printer')).toBeTruthy();
    expect(screen.getByText('Not accepting jobs')).toBeTruthy(); expect(screen.getByText('Queued jobs: 0')).toBeTruthy();
    expect(screen.getByText('printer-is-accepting-jobs').nextSibling?.textContent).toBe('false');
    expect(screen.getByText('queued-job-count').nextSibling?.textContent).toBe('0');
  });

  it.each(['headers_timeout', 'body_timeout', 'ipp_status'])('retains the %s failure receipt rather than claiming connected or offline', async failure => {
    statusResponse = failure === 'ipp_status'
      ? { ok: false, status: 'query_failed', observedAt, ippStatusCode: 1282, target: statusResponse.target, warnings: [], limitations: [] }
      : { ok: false, status: 'unavailable', observedAt, target: statusResponse.target, phase: failure === 'body_timeout' ? 'body' : 'headers', errorCode: failure, error: 'Timed out while reading the device response', limitations: [] };
    render(<DeviceSyncCenter t={{}} />); fireEvent.click(await screen.findByRole('button', { name: /Read printer status/ }));
    await screen.findByText('Status query failed'); expect(screen.queryByText('Idle')).toBeNull();
    if (failure === 'ipp_status') expect(screen.getByText('1282').closest('details')!.open).toBe(false);
    else { expect(screen.getByRole('alert').textContent).toContain('Timed out'); expect(screen.getByText(new RegExp(failure)).closest('details')!.open).toBe(false); }
  });

  it.each([401, 403])('shows HTTP %s and the actual local admission reason, then allows an explicit retry', async code => {
    const defaultHandler = mocks.fetch.getMockImplementation()!;
    let denied = true;
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname === '/api/devices/external' && denied
      ? Promise.resolve(reply({ error: 'Current local desktop proof is required' }, code)) : defaultHandler(url, init));
    render(<DeviceSyncCenter t={{}} />);
    expect((await screen.findByRole('alert')).textContent).toBe(`HTTP ${code}: Current local desktop proof is required`);
    expect(screen.queryByRole('region', { name: 'USB devices' })).toBeNull();
    denied = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh external devices' }));
    await screen.findByText('Generic serial bridge'); expect(externalReads()).toHaveLength(2);
  });

  it('keeps partial source errors distinct from an empty inventory and keeps unaffected observations', async () => {
    external.usb = { ok: false, status: 'unavailable', observedAt, errors: [{ code: 'observation_failed', message: 'PnP observation failed' }] };
    external.lan.status = 'partial'; external.lan.errors = [{ code: 'socket_error', message: 'One interface did not respond', protocol: 'mdns' }];
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('observation_failed: PnP observation failed');
    const usb = screen.getByRole('region', { name: 'USB devices' });
    expect(usb.textContent).not.toContain('No observations'); expect(screen.getByText('socket_error: One interface did not respond')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'System print queues' }).textContent).toContain('Installed queue driver');
    expect(screen.getByRole('button', { name: /Read printer status/ })).toBeTruthy();
  });

  it('accepts a source failure receipt delivered after a 15-second owner budget without aborting the other observations', async () => {
    vi.useFakeTimers(); const defaultHandler = mocks.fetch.getMockImplementation()!;
    external.usb = { ok: false, status: 'unavailable', observedAt, errors: [{ code: 'observation_failed', message: 'USB owner exhausted its 15-second budget' }] };
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname === '/api/devices/external'
      ? new Promise(resolve => setTimeout(() => resolve(reply(external)), 16000)) : defaultHandler(url, init));
    render(<DeviceSyncCenter t={{}} />); await act(async () => {}); expect(externalReads()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    expect(externalReads()[0][1].signal.aborted).toBe(false);
    expect(screen.getByText('observation_failed: USB owner exhausted its 15-second budget')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Read printer status/ })).toBeTruthy();
  });

  it('shows a real admission failure for the printer status action without manufacturing an IPP state', async () => {
    const defaultHandler = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname.endsWith('/printer-status')
      ? Promise.resolve(reply({ error: 'Current desktop proof is required for printer status' }, 403)) : defaultHandler(url, init));
    render(<DeviceSyncCenter t={{}} />); fireEvent.click(await screen.findByRole('button', { name: /Read printer status/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('HTTP 403: Current desktop proof is required for printer status');
    expect(screen.queryByText(/Printer state:/)).toBeNull();
  });

  it('shares one initial observation between widget and center and never rescans on registry timers or socket events', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    render(<><DesktopDeviceWidget lang="en" socket={mocks as any} onOpen={() => {}} /><DeviceSyncCenter t={{}} /></>);
    await screen.findByText('Generic serial bridge'); expect(externalReads()).toHaveLength(1);
    const widget = screen.getByRole('button', { name: 'View and manage devices' });
    expect(widget.textContent).toContain('USB devices: 1'); expect(widget.textContent).toContain('LAN discovered: 1'); expect(widget.textContent).not.toContain('Print queues:');
    await act(async () => {
      for (const [callback, delay] of intervals.mock.calls) if (delay === 30000) (callback as Function)();
      for (const [event, callback] of mocks.on.mock.calls) if (event === 'devices:update') callback();
    });
    expect(externalReads()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh external devices' }));
    await waitFor(() => expect(externalReads()).toHaveLength(2));
  });

  it('does not report zero devices for unsupported or failed widget sources', async () => {
    external.usb.status = 'unsupported'; external.usb.supported = false; external.usb.devices = [];
    external.printers = { ok: false, status: 'unavailable', observedAt, errors: [{ code: 'observation_failed', message: 'Spooler metadata unavailable' }] };
    render(<DesktopDeviceWidget lang="en" socket={null} onOpen={() => {}} />);
    await screen.findByText('Some observations need attention. Open device center for details.');
    const widget = screen.getByRole('button', { name: 'View and manage devices' });
    expect(widget.textContent).toContain('USB devices: —'); expect(widget.textContent).not.toContain('Print queues:');
    expect(widget.textContent).toContain('LAN discovered: 1');
  });

  it('uses the same USB filter and advertised-service grouping in the compact widget and main list', async () => {
    external.usb.devices.push({ ...external.usb.devices[0], instanceId: 'ACPI\\fixture', instanceEnumerator: 'ACPI', name: 'Motherboard serial', portName: 'COM1' });
    external.lan.candidates.push({ ...external.lan.candidates[0], id: 'secure-pair', serviceType: '_ipps._tcp.local', port: 443 });
    render(<><DesktopDeviceWidget lang="en" socket={null} onOpen={() => {}} /><DeviceSyncCenter t={{}} /></>);
    await screen.findByText('Generic serial bridge'); const widget = screen.getByRole('button', { name: 'View and manage devices' });
    expect(widget.textContent).toContain('USB devices: 1'); expect(widget.textContent).toContain('LAN discovered: 1');
    expect(widget.textContent).not.toContain(observedAt); expect(widget.textContent).not.toContain('Print queues');
    expect(within(screen.getByRole('region', { name: 'USB devices' })).getAllByRole('article')).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'LAN devices' })).getAllByRole('article')).toHaveLength(1);
    expect(externalReads()).toHaveLength(1);
  });

  it('starts one shared LAN observation under the desktop StrictMode lifecycle', async () => {
    render(<React.StrictMode><DesktopDeviceWidget lang="en" socket={null} onOpen={() => {}} /><DeviceSyncCenter t={{}} /></React.StrictMode>);
    await screen.findByText('Generic serial bridge'); expect(externalReads()).toHaveLength(1);
  });

  it('waits for first visibility and does not rescan an existing observation when visibility changes again', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(<DeviceSyncCenter t={{}} />); await act(async () => {}); expect(externalReads()).toHaveLength(0);
    hidden.mockReturnValue(false); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await screen.findByText('Generic serial bridge'); expect(externalReads()).toHaveLength(1);
    hidden.mockReturnValue(true); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    hidden.mockReturnValue(false); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(externalReads()).toHaveLength(1);
  });

  it('clears the old account immediately, aborts its request and ignores a late observation', async () => {
    const held = deferred<any>(); const defaultHandler = mocks.fetch.getMockImplementation()!; let previous = true;
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname === '/api/devices/external' && previous ? held.promise : defaultHandler(url, init));
    const view = render(<DeviceSyncCenter t={{}} />); await waitFor(() => expect(externalReads()).toHaveLength(1)); const oldSignal = externalReads()[0][1].signal;
    previous = false; account.user = { uid: 'new-device-user', role: 'admin' }; external.usb.devices[0].name = 'New account serial receipt';
    view.rerender(<DeviceSyncCenter t={{}} />); expect(oldSignal.aborted).toBe(true);
    await screen.findByText('New account serial receipt');
    const old = snapshot(); (old.usb as any).devices[0].name = 'Old account serial receipt';
    await act(async () => held.resolve(reply(old))); expect(screen.queryByText('Old account serial receipt')).toBeNull();
    account.user = null; view.rerender(<DeviceSyncCenter t={{}} />); expect(view.container.textContent).toBe('');
  });

  it('labels a retained old snapshot when an explicit refresh fails instead of showing an empty success', async () => {
    const defaultHandler = mocks.fetch.getMockImplementation()!;
    render(<DeviceSyncCenter t={{}} />); await screen.findByText('Generic serial bridge');
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname === '/api/devices/external'
      ? Promise.resolve(reply({ error: 'Session expired' }, 401)) : defaultHandler(url, init));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh external devices' }));
    await screen.findByText('HTTP 401: Session expired'); expect(screen.getByText('Generic serial bridge')).toBeTruthy(); expect(screen.getByText(/Previous observation remains visible/)).toBeTruthy();
  });

  it('cancels a pending status request when its account view closes', async () => {
    const held = deferred<any>(); const defaultHandler = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => new URL(url).pathname.endsWith('/printer-status') ? held.promise : defaultHandler(url, init));
    const view = render(<DeviceSyncCenter t={{}} />); fireEvent.click(await screen.findByRole('button', { name: /Read printer status/ }));
    const signal = statusReads()[0][1].signal; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => held.resolve(reply(statusResponse))); expect(screen.queryByText('Idle')).toBeNull();
  });

  it('explains the direction of remote MCP and renders configured WebSocket URLs without a fabricated browser action', async () => {
    mocks.fetch.mockResolvedValue(reply({ devices: { 'External client relay': 'wss://relay.invalid/mcp?token=%5Bconfigured%5D' } }));
    render(<RemoteMCPSettings />); await screen.findByText('External client relay');
    expect(screen.getByRole('heading', { name: 'Expose Lumi via remote MCP' })).toBeTruthy();
    expect(screen.getByText(/does not import the external device's tools/)).toBeTruthy(); expect(screen.queryByRole('link')).toBeNull();
    expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });
});
