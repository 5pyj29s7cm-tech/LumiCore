// Multimodal context fusion layer
// Assembles input from different sensory channels into a unified context for the LLM.

import { SensoryContext } from '../personality/types';
import { deviceRegistry } from '../devices';
import type { DeviceScope } from '../devices';

export interface RawModalityInput {
  modality: 'audio' | 'visual' | 'spatial' | 'haptic';
  deviceId: string;
  timestamp: string;
  data: any;
}

export interface FusedContext {
  sensory: SensoryContext;
  /** Structured description of the multimodal scene */
  sceneDescription: string;
  /** Timestamp of the most recent sensor update */
  lastUpdate: string;
}

/**
 * Fuse raw modality inputs into a unified context.
 *
 * This is the core "assembly" step — instead of sending raw sensor data
 * to the LLM, we first structure it into sensory context + scene description.
 * The LLM receives a clean, high-level picture of what's happening.
 */
export function fuseContext(
  inputs: RawModalityInput[],
  userId: string,
  locationTag?: string,
  scope?: DeviceScope,
): FusedContext {
  const now = new Date().toISOString();

  // Build sensory context from actual device capabilities
  const deviceSensory = deviceRegistry.getSensoryContext(userId, scope);

  // Override with actual active inputs
  const sensory: SensoryContext = {
    audio: deviceSensory.hasAudio || inputs.some(i => i.modality === 'audio'),
    visual: deviceSensory.hasVideo || inputs.some(i => i.modality === 'visual'),
    spatial: deviceSensory.hasSpatial || inputs.some(i => i.modality === 'spatial'),
    haptic: deviceSensory.hasHaptic || inputs.some(i => i.modality === 'haptic'),
    holographic: deviceSensory.hasHolographic,
    activeDeviceTypes: deviceSensory.activeDeviceTypes,
    deviceCount: deviceSensory.deviceCount || 1,
    locationTag,
  };

  // Build scene description from visual/spatial inputs
  const sceneParts: string[] = [];

  const visualInputs = inputs.filter(i => i.modality === 'visual');
  if (visualInputs.length > 0 && visualInputs[0].data?.description) {
    sensory.visualScene = visualInputs[0].data.description;
    sceneParts.push(`Visual: ${visualInputs[0].data.description}`);
  }

  const spatialInputs = inputs.filter(i => i.modality === 'spatial');
  if (spatialInputs.length > 0 && spatialInputs[0].data?.roomLayout) {
    sceneParts.push(`Spatial: ${spatialInputs[0].data.roomLayout}`);
  }

  const audioInputs = inputs.filter(i => i.modality === 'audio');
  if (audioInputs.length > 0) {
    // Audio data is typically the user's speech, which is handled separately
    // Here we just note the audio context
    if (audioInputs[0].data?.backgroundNoise) {
      sceneParts.push(`Ambient: ${audioInputs[0].data.backgroundNoise}`);
    }
  }

  return {
    sensory,
    sceneDescription: sceneParts.length > 0 ? sceneParts.join(' | ') : 'No multimodal input',
    lastUpdate: now,
  };
}
