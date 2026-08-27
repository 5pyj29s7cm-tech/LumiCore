import type { DeviceInfo } from './types';
import { nativeClientIdentitySha256 } from './native_identity';

/**
 * Device shape safe for ordinary authenticated APIs and socket broadcasts.
 * Native process identity is deliberately omitted instead of redacted field by
 * field, so future additions to that structure cannot leak by default.
 */
export type PublicDeviceInfo = Omit<DeviceInfo, 'nativeClientIdentity'>;

export function projectPublicDevice(device: DeviceInfo): PublicDeviceInfo {
  const { nativeClientIdentity: _privateNativeClientIdentity, ...publicDevice } = device;
  return publicDevice;
}

/**
 * Exact native identity is available only to the separately gated local
 * acceptance endpoint.  Keep the surrounding registry projection minimal.
 */
export function projectRestrictedNativeDeviceEvidence(device: DeviceInfo): {
  id: string;
  type: DeviceInfo['type'];
  status: DeviceInfo['status'];
  socketId: string | null;
  nativeClientIdentitySha256: string;
  nativeClientIdentity: NonNullable<DeviceInfo['nativeClientIdentity']>;
} | null {
  if (!device.nativeClientIdentity) return null;
  const identitySha256 = nativeClientIdentitySha256(device.nativeClientIdentity);
  if (!identitySha256) return null;
  return {
    id: device.id,
    type: device.type,
    status: device.status,
    socketId: device.socketId,
    nativeClientIdentitySha256: identitySha256,
    nativeClientIdentity: { ...device.nativeClientIdentity },
  };
}
