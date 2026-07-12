import { readDB, writeDB } from '../../db_layer';
import { DeviceInfo, DeviceType, DeviceCapabilities, DeviceScope } from './types';

function normalizeDeviceScope(scope?: Partial<DeviceScope>): DeviceScope {
  const orgId = String(scope?.orgId || '').trim();
  return scope?.domain === 'work' && orgId
    ? { domain: 'work', orgId }
    : { domain: 'personal', orgId: '' };
}

function deviceMatchesScope(device: DeviceInfo, scope?: Partial<DeviceScope>): boolean {
  if (!scope) return true;
  const normalized = normalizeDeviceScope(scope);
  return device.domain === normalized.domain && device.orgId === normalized.orgId;
}

class DeviceRegistry {
  private devices: Map<string, DeviceInfo> = new Map();
  private broadcastCb: ((event: string, data: any) => void) | null = null;

  setBroadcast(cb: (event: string, data: any) => void): void {
    this.broadcastCb = cb;
  }

  register(
    userId: string,
    socketId: string,
    info: { name?: string; type?: DeviceType; capabilities?: Partial<DeviceCapabilities>; ipAddress?: string; osInfo?: string; deviceFingerprint?: string; domain?: DeviceScope['domain']; orgId?: string },
  ): DeviceInfo {
    const now = new Date().toISOString();
    const scope = normalizeDeviceScope(info);

    // Use persistent fingerprint from client as dedup key, falling back to socketId
    const fingerprint = info.deviceFingerprint || socketId;
    const scopeId = scope.domain === 'work' ? `org_${scope.orgId}` : 'personal';
    const id = `dev_${userId}_${scopeId}_${fingerprint}`;

    // 1) Exact match — same device reconnected
    const existing = this.devices.get(id);
    if (existing) {
      existing.status = 'online';
      existing.lastSeen = now;
      existing.socketId = socketId;
      existing.domain = scope.domain;
      existing.orgId = scope.orgId;
      if (info.ipAddress) existing.ipAddress = info.ipAddress;
      if (info.osInfo) existing.osInfo = info.osInfo;
      if (info.name) existing.name = info.name;
      this.broadcastCb?.('devices:update', existing);
      return existing;
    }

    // 2) Merge by name+type — same physical device with different key
    // (happens when old clients without fingerprint reconnect with new socketId)
    const deviceName = info.name || 'Unknown Device';
    const deviceType = info.type || 'desktop';
    for (const [key, dev] of this.devices) {
      if (dev.userId === userId && deviceMatchesScope(dev, scope) && dev.name === deviceName && dev.type === deviceType) {
        // Reuse this entry, update id to new fingerprint
        this.devices.delete(key);
        dev.id = id;
        dev.status = 'online';
        dev.lastSeen = now;
        dev.socketId = socketId;
        if (info.ipAddress) dev.ipAddress = info.ipAddress;
        if (info.osInfo) dev.osInfo = info.osInfo;
        this.devices.set(id, dev);
        this.broadcastCb?.('devices:update', dev);
        return dev;
      }
    }

    const device: DeviceInfo = {
      id,
      userId,
      domain: scope.domain,
      orgId: scope.orgId,
      name: deviceName,
      type: deviceType,
      status: 'online',
      capabilities: {
        audio: info.capabilities?.audio ?? true,
        video: info.capabilities?.video ?? false,
        spatial: info.capabilities?.spatial ?? false,
        haptic: info.capabilities?.haptic ?? false,
        holographic: info.capabilities?.holographic ?? false,
      },
      socketId,
      ipAddress: info.ipAddress || null,
      osInfo: info.osInfo || null,
      firstSeen: now,
      lastSeen: now,
    };

    this.devices.set(id, device);
    this.broadcastCb?.('devices:update', device);
    console.log(`[Devices] Registered: ${device.name} (${device.type}) for user ${userId}`);
    return device;
  }

  disconnect(socketId: string): void {
    for (const [id, device] of this.devices) {
      if (device.socketId === socketId) {
        device.status = 'offline';
        device.socketId = null;
        device.lastSeen = new Date().toISOString();
        this.broadcastCb?.('devices:update', device);
        console.log(`[Devices] Disconnected: ${device.name}`);
        return;
      }
    }
  }

  getUserDevices(userId: string, scope?: Partial<DeviceScope>): DeviceInfo[] {
    return Array.from(this.devices.values()).filter(d => d.userId === userId && deviceMatchesScope(d, scope));
  }

  getAll(): DeviceInfo[] {
    return Array.from(this.devices.values());
  }

  /** Get cross-device context for personality */
  getActiveDevices(userId: string, scope?: Partial<DeviceScope>): DeviceInfo[] {
    return this.getUserDevices(userId, scope).filter(d => d.status === 'online');
  }

  /** Build sensory context from all active devices */
  getSensoryContext(userId: string, scope?: Partial<DeviceScope>): {
    hasAudio: boolean;
    hasVideo: boolean;
    hasSpatial: boolean;
    hasHaptic: boolean;
    hasHolographic: boolean;
    activeDeviceTypes: DeviceType[];
    deviceCount: number;
  } {
    const active = this.getActiveDevices(userId, scope);
    return {
      hasAudio: active.some(d => d.capabilities.audio),
      hasVideo: active.some(d => d.capabilities.video),
      hasSpatial: active.some(d => d.capabilities.spatial),
      hasHaptic: active.some(d => d.capabilities.haptic),
      hasHolographic: active.some(d => d.capabilities.holographic),
      activeDeviceTypes: [...new Set(active.map(d => d.type))],
      deviceCount: active.length,
    };
  }

  /** Register a remote MCP device (not tied to a socket.io connection) */
  registerMcpDevice(name: string, userId: string, capabilities: Partial<DeviceCapabilities>): DeviceInfo {
    const id = `mcp_${name}`;
    const now = new Date().toISOString();
    const existing = this.devices.get(id);
    if (existing) {
      existing.status = 'online';
      existing.lastSeen = now;
      this.broadcastCb?.('devices:update', existing);
      return existing;
    }

    const device: DeviceInfo = {
      id,
      userId,
      domain: 'personal',
      orgId: '',
      name,
      type: 'web',
      status: 'online',
      capabilities: {
        audio: capabilities.audio ?? true,
        video: capabilities.video ?? false,
        spatial: capabilities.spatial ?? false,
        haptic: capabilities.haptic ?? false,
        holographic: capabilities.holographic ?? false,
      },
      socketId: null,
      ipAddress: null,
      osInfo: 'MCP Remote',
      firstSeen: now,
      lastSeen: now,
    };

    this.devices.set(id, device);
    this.broadcastCb?.('devices:update', device);
    console.log(`[Devices] MCP device registered: ${name}`);
    return device;
  }

  /** Mark an MCP device as offline */
  unregisterMcpDevice(name: string): void {
    const id = `mcp_${name}`;
    const device = this.devices.get(id);
    if (device) {
      device.status = 'offline';
      device.lastSeen = new Date().toISOString();
      this.broadcastCb?.('devices:update', device);
      console.log(`[Devices] MCP device offline: ${name}`);
    }
  }

  /** Get MCP devices (visible to all users) */
  getMcpDevices(): DeviceInfo[] {
    return Array.from(this.devices.values()).filter(d => d.id.startsWith('mcp_'));
  }
}

export const deviceRegistry = new DeviceRegistry();
