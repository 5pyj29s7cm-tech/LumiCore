import { SensoryContext } from "../personality/types";
import { deviceRegistry } from "../devices";
import { fuseContext, RawModalityInput } from "../context/fusion";
import type { RuntimeScope } from './scope';
import { runtimeScopeStorageKey } from './scope';

export const sounds = {
  notification: '/sounds/notification.mp3',
  tool_exec: '/sounds/tool_exec.mp3',
};

// Perception events buffer (per user)
export const perceptionEvents: Map<string, RawModalityInput[]> = new Map();
export const MAX_PERCEPTION_EVENTS = 20;

export function getSensory(userId: string, locationTag?: string, scope: RuntimeScope = { domain: 'personal', orgId: '' }): SensoryContext {
  const ds = deviceRegistry.getSensoryContext(userId, scope);
  const recentEvents = perceptionEvents.get(runtimeScopeStorageKey(userId, scope)) || [];

  if (recentEvents.length > 0) {
    const fused = fuseContext(recentEvents, userId, locationTag, scope);
    return fused.sensory;
  }

  return {
    audio: ds.hasAudio,
    visual: ds.hasVideo,
    spatial: ds.hasSpatial,
    haptic: ds.hasHaptic,
    holographic: ds.hasHolographic,
    activeDeviceTypes: ds.activeDeviceTypes,
    deviceCount: ds.deviceCount,
    locationTag,
  };
}
