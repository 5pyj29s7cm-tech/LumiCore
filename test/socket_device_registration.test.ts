// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSourceModule } from './source_expression';

let service: any;
const bootstrap = vi.fn();
let native = false;
function setup() {
  const handlers = new Map<string, Function[]>();
  const socket: any = { id: 'connection-a', connected: false, auth: {},
    on: (name: string, handler: Function) => { handlers.set(name, [...(handlers.get(name) || []), handler]); return socket; },
    fire: (name: string, value?: unknown) => { for (const fn of handlers.get(name) || []) fn(value); },
    connect: () => { socket.connected = true; socket.fire('connect'); return socket; },
    disconnect: () => { socket.connected = false; socket.fire('disconnect', 'test'); return socket; },
  };
  service = loadSourceModule<{ socketService: any }>('src/services/socketService.ts', {
    'socket.io-client': { io: () => socket }, './apiBridge': { getSocketOrigin: () => 'http://synthetic.invalid' },
    './authService': { getStoredToken: () => 'synthetic', getDesktopSessionProof: () => 'proof', isNativeDesktopRuntime: () => native, bootstrap },
  }).socketService;
  service.connect(); socket.connect();
  return socket;
}
beforeEach(() => { vi.useFakeTimers(); bootstrap.mockReset(); native = false; localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { service?.disconnect(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
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
