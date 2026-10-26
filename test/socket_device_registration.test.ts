// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSourceModule } from './source_expression';

let service: any;
const bootstrap = vi.fn();
const recoveredEvent = 'lumi:native-session-recovered';
let native = false;
function setup() {
  const handlers = new Map<string, Function[]>();
  const socket: any = { id: 'connection-a', connected: false, auth: {},
    on: (name: string, handler: Function) => { handlers.set(name, [...(handlers.get(name) || []), handler]); return socket; },
    fire: (name: string, value?: unknown) => { for (const fn of handlers.get(name) || []) fn(value); },
    connect: vi.fn(() => { socket.connected = true; socket.fire('connect'); return socket; }),
    disconnect: () => { socket.connected = false; socket.fire('disconnect', 'test'); return socket; },
  };
  service = loadSourceModule<{ socketService: any }>('src/services/socketService.ts', {
    'socket.io-client': { io: () => socket }, './apiBridge': { getSocketOrigin: () => 'http://synthetic.invalid' },
    './authService': { getStoredToken: () => 'synthetic', getDesktopSessionProof: () => 'proof', isNativeDesktopRuntime: () => native, canRecoverNativeSession: () => native, NATIVE_SESSION_RECOVERED_EVENT: recoveredEvent, bootstrap },
  }).socketService;
  service.connect(); socket.connect();
  return socket;
}
beforeEach(() => { vi.useFakeTimers(); bootstrap.mockReset(); native = false; localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { service?.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('requires an accepted receipt for the current connection and clears it on disconnect', () => {
  const socket = setup(); expect(service.getDeviceRegistration().status).toBe('pending');
  socket.fire('device:registered', { socketId: 'old-connection', deviceId: 'device-a', executable: true });
  expect(service.getDeviceRegistration().status).toBe('pending');
  socket.fire('device:registered', { socketId: socket.id, deviceId: 'device-a', executable: true });
  expect(service.getDeviceRegistration()).toEqual({ status: 'registered', socketId: socket.id, deviceId: 'device-a', executable: true });
  socket.disconnect(); expect(service.getDeviceRegistration()).toEqual({ status: 'disconnected' });
  socket.id = 'connection-b'; socket.connect(); expect(service.getDeviceRegistration()).toEqual({ status: 'pending', socketId: 'connection-b' });
});
it.each(['NATIVE_DESKTOP_REGISTRATION_REQUIRED', 'DESKTOP_SESSION_PROOF_REQUIRED', 'NATIVE_CLIENT_IDENTITY_MISMATCH', 'NATIVE_CLIENT_IDENTITY_NOT_ALLOWED'])('publishes rejection %s and ignores stale errors', code => {
  const socket = setup(), listener = vi.fn(); const unsubscribe = service.subscribeDeviceRegistration(listener);
  socket.fire('device:registration_error', { socketId: 'old-connection', code }); expect(listener).not.toHaveBeenCalled();
  socket.fire('device:registration_error', { socketId: socket.id, code }); expect(service.getDeviceRegistration()).toEqual({ status: 'rejected', socketId: socket.id, code }); expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe(); service.rejectDeviceRegistration(socket.id, 'REGISTRATION_FAILED'); expect(listener).toHaveBeenCalledTimes(1);
});
it('reports missing backend confirmation instead of remaining pending indefinitely', async () => {
  const socket = setup(); await vi.advanceTimersByTimeAsync(8_000);
  expect(service.getDeviceRegistration()).toEqual({ status: 'rejected', socketId: socket.id, code: 'REGISTRATION_TIMEOUT' });
});
it('deduplicates native proof renewal and reconnects through the existing auth owner', async () => {
  native = true; let finish!: (value: any) => void; bootstrap.mockReturnValue(new Promise(resolve => finish = resolve));
  const socket = setup(); socket.fire('device:registration_error', { socketId: socket.id, code: 'DESKTOP_SESSION_PROOF_REQUIRED' });
  expect(service.getDeviceRegistration().status).toBe('rejected');
  socket.fire('device:registration_error', { socketId: socket.id, code: 'DESKTOP_SESSION_PROOF_REQUIRED' }); expect(bootstrap).toHaveBeenCalledTimes(1);
  finish({ success: true, desktopSessionProof: 'renewed' }); await vi.advanceTimersByTimeAsync(0);
  expect(service.getDeviceRegistration().status).toBe('pending');
});

it('recovers missing authentication and proof expiry through one native owner and refreshes context once', async () => {
  native = true; let finish!: (value: any) => void; bootstrap.mockReturnValue(new Promise(resolve => finish = resolve));
  const listener = vi.fn(); window.addEventListener(recoveredEvent, listener); const socket = setup();
  socket.connected = false; socket.active = false;
  socket.fire('connect_error', { message: 'Authentication required', data: { code: 'AUTHENTICATION_REQUIRED' } });
  socket.fire('connect_error', { message: 'Proof expired', data: { code: 'DESKTOP_SESSION_PROOF_REQUIRED' } });
  expect(bootstrap).toHaveBeenCalledTimes(1); expect(socket.connect).toHaveBeenCalledTimes(1);
  finish({ success: true, desktopSessionProof: 'renewed' }); await vi.advanceTimersByTimeAsync(0);
  expect(socket.connect).toHaveBeenCalledTimes(2); expect(listener).toHaveBeenCalledTimes(1); expect(service.getDeviceRegistration().status).toBe('pending');
  window.removeEventListener(recoveredEvent, listener);
});
it('retries a transient native authentication recovery on the next watchdog tick', async () => {
  native = true; bootstrap.mockResolvedValueOnce({ success: false, error: 'Verified backend temporarily unavailable' }).mockResolvedValueOnce({ success: true, desktopSessionProof: 'renewed' });
  const fetcher = vi.fn().mockResolvedValue({ status: 200 }); vi.stubGlobal('fetch', fetcher); const socket = setup();
  socket.connected = false; socket.active = false;
  socket.fire('connect_error', { message: 'Authentication required', data: { code: 'AUTHENTICATION_REQUIRED' } }); await vi.advanceTimersByTimeAsync(0);
  expect(bootstrap).toHaveBeenCalledTimes(1); expect(socket.connected).toBe(false); expect(socket.connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000); expect(bootstrap).toHaveBeenCalledTimes(2); expect(socket.connect).toHaveBeenCalledTimes(2); expect(socket.connected).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it('handles resolved health-check 401 through native bootstrap and stops permanent 403 retries', async () => {
  native = true; bootstrap.mockResolvedValue({ success: true, desktopSessionProof: 'renewed' });
  const fetcher = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValue({ status: 403 }); vi.stubGlobal('fetch', fetcher); const socket = setup();
  await vi.advanceTimersByTimeAsync(30_000); expect(bootstrap).toHaveBeenCalledTimes(1); expect(socket.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000); expect(fetcher).toHaveBeenCalledTimes(2); expect(bootstrap).toHaveBeenCalledTimes(1);
  socket.disconnect(); await vi.advanceTimersByTimeAsync(120_000); document.dispatchEvent(new Event('visibilitychange'));
  expect(fetcher).toHaveBeenCalledTimes(2); expect(bootstrap).toHaveBeenCalledTimes(1); expect(socket.connect).toHaveBeenCalledTimes(2);
});
it('does not silently log in or force rejected socket reconnections outside native runtime', async () => {
  const fetcher = vi.fn().mockResolvedValue({ status: 401 }); vi.stubGlobal('fetch', fetcher); const socket = setup(); socket.disconnect(); socket.active = false;
  socket.fire('connect_error', { message: 'Authentication required', data: { code: 'AUTHENTICATION_REQUIRED' } });
  await vi.advanceTimersByTimeAsync(120_000); document.dispatchEvent(new Event('visibilitychange'));
  expect(bootstrap).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(socket.connect).toHaveBeenCalledTimes(1); expect(socket.connected).toBe(false);
});
it('does not reconnect or emit a recovered event after the socket owner has been disposed', async () => {
  native = true; let finish!: (value: any) => void; bootstrap.mockReturnValue(new Promise(resolve => finish = resolve)); const socket = setup();
  const listener = vi.fn(); window.addEventListener(recoveredEvent, listener);
  socket.fire('connect_error', { message: 'Authentication required', data: { code: 'AUTHENTICATION_REQUIRED' } }); service.disconnect();
  finish({ success: true, desktopSessionProof: 'renewed' }); await vi.advanceTimersByTimeAsync(0);
  expect(socket.connect).toHaveBeenCalledTimes(1); expect(listener).not.toHaveBeenCalled(); expect(service.getDeviceRegistration().status).toBe('disconnected'); window.removeEventListener(recoveredEvent, listener);
});

it('ignores a late health-check rejection after its watchdog owner was disposed', async () => {
  native = true; let finish!: (value: any) => void; vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(resolve => finish = resolve))); const socket = setup();
  await vi.advanceTimersByTimeAsync(30_000); service.disconnect(); finish({ status: 401 }); await vi.advanceTimersByTimeAsync(0);
  expect(bootstrap).not.toHaveBeenCalled(); expect(socket.connect).toHaveBeenCalledTimes(1); expect(service.getDeviceRegistration().status).toBe('disconnected');
});

it('continues a failed device-proof refresh through the same watchdog owner', async () => {
  native = true; bootstrap.mockResolvedValueOnce({ success: false, error: 'Verified backend temporarily unavailable' }).mockResolvedValueOnce({ success: true, desktopSessionProof: 'renewed' });
  const fetcher = vi.fn().mockResolvedValue({ status: 200 }); vi.stubGlobal('fetch', fetcher); const socket = setup();
  socket.fire('device:registration_error', { socketId: socket.id, code: 'DESKTOP_SESSION_PROOF_REQUIRED' }); await vi.advanceTimersByTimeAsync(0);
  expect(bootstrap).toHaveBeenCalledTimes(1); expect(service.getDeviceRegistration().status).toBe('rejected');
  await vi.advanceTimersByTimeAsync(30_000); expect(bootstrap).toHaveBeenCalledTimes(2); expect(socket.connect).toHaveBeenCalledTimes(2); expect(service.getDeviceRegistration().status).toBe('pending'); expect(fetcher).not.toHaveBeenCalled();
});
