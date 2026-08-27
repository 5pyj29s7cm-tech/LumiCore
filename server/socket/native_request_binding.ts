import type { Socket } from 'socket.io';
import {
  deviceRegistry,
  nativeClientIdentitiesEqual,
  nativeClientIdentitySha256,
} from '../devices';

export interface SocketNativeRequestBinding {
  nativeDeviceId: string;
  executionSessionId: string;
  nativeClientIdentitySha256: string;
}

/**
 * Resolves provenance only for the exact online desktop registered by this
 * authenticated, proof-bound Tauri socket. A bootstrap claim alone is not
 * enough: product-client evidence begins only after device registration.
 */
export function buildSocketNativeRequestBinding(
  socket: Pick<Socket, 'data' | 'id'>,
): SocketNativeRequestBinding | null {
  const identity = socket.data?.nativeClientIdentity;
  const nativeDeviceId = String(socket.data?.lumiDeviceId || '').trim();
  const executionSessionId = String(socket.data?.executionSessionId || '').trim().toLowerCase();
  const identitySha256 = nativeClientIdentitySha256(identity);
  const authenticatedUserId = String(socket.data?.authenticatedUserId || '').trim();
  const authenticatedOrgId = String(socket.data?.authenticatedOrgId || '').trim();
  const registeredDevices = authenticatedUserId
    ? deviceRegistry.getUserDevices(authenticatedUserId).filter(device => device.id === nativeDeviceId)
    : [];
  const registeredDevice = registeredDevices.length === 1 ? registeredDevices[0] : null;
  if (socket.data?.trustedLocalExecution !== true
    || identity?.clientKind !== 'tauri'
    || !authenticatedUserId
    || !nativeDeviceId
    || !/^[a-f0-9]{64}$/u.test(executionSessionId)
    || !/^[a-f0-9]{64}$/u.test(identitySha256)
    || !registeredDevice
    || registeredDevice.status !== 'online'
    || registeredDevice.type !== 'desktop'
    || registeredDevice.socketId !== socket.id
    || registeredDevice.domain !== (authenticatedOrgId ? 'work' : 'personal')
    || registeredDevice.orgId !== authenticatedOrgId
    || !nativeClientIdentitiesEqual(registeredDevice.nativeClientIdentity, identity)) {
    return null;
  }
  return { nativeDeviceId, executionSessionId, nativeClientIdentitySha256: identitySha256 };
}
