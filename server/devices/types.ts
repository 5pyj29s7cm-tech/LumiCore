import type { NativeClientIdentity } from '../../shared/native_client_identity';

export type DeviceType = 'desktop' | 'mobile' | 'ar_glasses' | 'holographic_prototype' | 'web';

export type DeviceStatus = 'online' | 'offline' | 'pairing';
export type DeviceDomain = 'personal' | 'work';

export interface DeviceScope {
  domain: DeviceDomain;
  orgId: string;
}

/** Which sensory modalities a device can provide */
export interface DeviceCapabilities {
  audio: boolean;
  video: boolean;
  spatial: boolean; // 3D position / room awareness
  haptic: boolean;
  holographic: boolean; // can render holographic output
}

export interface DeviceInfo {
  id: string;
  userId: string;
  domain: DeviceDomain;
  orgId: string;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  capabilities: DeviceCapabilities;
  socketId: string | null; // current Socket.IO connection
  ipAddress: string | null;
  osInfo: string | null;
  /** Proof-bound local claim; `osAttested` remains false until independently probed. */
  nativeClientIdentity: NativeClientIdentity | null;
  firstSeen: string;
  lastSeen: string;
  lastPerceptionEvent?: string; // timestamp of last perception data pushed
}
