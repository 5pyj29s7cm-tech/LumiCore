export type SensorKind = 'microphone' | 'camera';
export type SensorPermissionState = PermissionState | 'unknown' | 'unavailable';
export type DesktopAutomationState = 'available' | 'unavailable' | 'unknown';

export interface SensorPermissionSnapshot {
  microphone: SensorPermissionState;
  camera: SensorPermissionState;
  notifications: SensorPermissionState;
  desktopAutomation?: DesktopAutomationState;
  wakeWordEnabled?: boolean;
  sensorPrimerSeen?: boolean;
  biometricsPrimerSeen?: boolean;
  updatedAt: number;
}

interface SnapshotOptions {
  desktopAutomation?: DesktopAutomationState;
  wakeWordEnabled?: boolean;
  sensorPrimerSeen?: boolean;
  biometricsPrimerSeen?: boolean;
}

export const SENSOR_PERMISSIONS_CHANGED = 'lumi:sensor-permissions-changed';
export const SENSOR_ACCESS_CHANGED = 'lumi:sensor-access-changed';
export const BACKGROUND_FACE_PRESENCE_CHANGED = 'lumi:background-face-presence-changed';
export const BACKGROUND_FACE_PRESENCE_ENABLED_KEY = 'lumi_background_face_presence_enabled';

const SENSOR_ENABLED_KEYS: Record<SensorKind, string> = {
  microphone: 'lumi_mic_enabled',
  camera: 'lumi_camera_enabled',
};

const activeStreams: Record<SensorKind, Set<MediaStream>> = {
  microphone: new Set(),
  camera: new Set(),
};
const activeStreamReleases = new WeakMap<MediaStream, () => void>();
const accessRevision: Record<SensorKind, number> = { microphone: 0, camera: 0 };

function hasNavigator() {
  return typeof navigator !== 'undefined';
}

function hasWindow() {
  return typeof window !== 'undefined';
}

export function isBackgroundFacePresenceEnabled(
  storage?: Pick<Storage, 'getItem'> | null,
): boolean {
  const source = storage ?? (hasWindow() ? window.localStorage : null);
  if (!source) return false;
  try {
    return source.getItem(BACKGROUND_FACE_PRESENCE_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setBackgroundFacePresenceEnabled(enabled: boolean) {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(BACKGROUND_FACE_PRESENCE_ENABLED_KEY, String(enabled));
  } catch {}
  window.dispatchEvent(new CustomEvent(BACKGROUND_FACE_PRESENCE_CHANGED, {
    detail: { enabled, updatedAt: Date.now() },
  }));
}

function readSensorEnabled(kind: SensorKind) {
  if (!hasWindow()) return true;
  try {
    return window.localStorage.getItem(SENSOR_ENABLED_KEYS[kind]) !== 'false';
  } catch {
    return true;
  }
}

function stopActiveStreams(kind: SensorKind) {
  for (const stream of [...activeStreams[kind]]) releaseSensorStream(kind, stream);
}

function trackActiveStream(kind: SensorKind, stream: MediaStream) {
  activeStreams[kind].add(stream);
  const tracks = stream.getTracks();
  const wrappedStops = new Map<MediaStreamTrack, {
    original: MediaStreamTrack['stop'];
    wrapped: MediaStreamTrack['stop'];
  }>();
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    activeStreams[kind].delete(stream);
    activeStreamReleases.delete(stream);
    stream.removeEventListener?.('inactive', release);
    for (const track of tracks) {
      track.removeEventListener?.('ended', releaseIfInactive);
      const methods = wrappedStops.get(track);
      if (methods && track.stop === methods.wrapped) {
        try {
          track.stop = methods.original;
        } catch {}
      }
    }
  };

  function releaseIfInactive() {
    if (tracks.every(track => track.readyState === 'ended')) release();
  }

  activeStreamReleases.set(stream, release);
  stream.addEventListener?.('inactive', release);
  tracks.forEach(track => {
    track.addEventListener?.('ended', releaseIfInactive);
    const original = track.stop;
    const wrapped = (() => {
      try {
        original.call(track);
      } finally {
        // MediaStreamTrack.stop() changes readyState but does not reliably fire
        // "ended", so release our strong Set reference synchronously.
        releaseIfInactive();
      }
    }) as MediaStreamTrack['stop'];
    try {
      track.stop = wrapped;
      wrappedStops.set(track, { original, wrapped });
    } catch {}
  });
}

export function releaseSensorStream(kind: SensorKind, stream: MediaStream | null | undefined) {
  if (!stream) return;
  activeStreamReleases.get(stream)?.();
  activeStreams[kind].delete(stream);
  stream.getTracks().forEach(track => track.stop());
}

export function isSensorEnabled(kind: SensorKind): boolean {
  return readSensorEnabled(kind);
}

export function setSensorEnabled(kind: SensorKind, enabled: boolean) {
  if (hasWindow()) {
    try {
      window.localStorage.setItem(SENSOR_ENABLED_KEYS[kind], String(enabled));
    } catch {}
  }

  if (!enabled) {
    // A pending browser permission dialog is not an active stream yet. Its
    // eventual result must stay revoked even if the switch is enabled again.
    accessRevision[kind] += 1;
    stopActiveStreams(kind);
  }
  broadcastSensorAccessChange({ [kind]: enabled });
}

export function broadcastSensorAccessChange(detail?: Partial<Record<SensorKind, boolean>>) {
  if (!hasWindow()) return;
  window.dispatchEvent(new CustomEvent(SENSOR_ACCESS_CHANGED, {
    detail: {
      ...detail,
      updatedAt: Date.now(),
    },
  }));
}

function getFallbackPermissionState(name: SensorKind | 'notifications'): SensorPermissionState {
  if (!hasNavigator()) return 'unavailable';
  if ((name === 'microphone' || name === 'camera') && !navigator.mediaDevices?.getUserMedia) return 'unavailable';
  return 'unknown';
}

export async function queryPermission(name: SensorKind | 'notifications'): Promise<SensorPermissionState> {
  if (!hasNavigator()) return 'unavailable';
  if ((name === 'microphone' || name === 'camera') && !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable';
  }

  try {
    if (!navigator.permissions?.query) return getFallbackPermissionState(name);
    const status = await navigator.permissions.query({ name } as PermissionDescriptor);
    return status.state || 'unknown';
  } catch {
    return getFallbackPermissionState(name);
  }
}

export async function getSensorPermissionSnapshot(options: SnapshotOptions = {}): Promise<SensorPermissionSnapshot> {
  const [microphone, camera, notifications] = await Promise.all([
    queryPermission('microphone'),
    queryPermission('camera'),
    queryPermission('notifications'),
  ]);

  return {
    microphone,
    camera,
    notifications,
    desktopAutomation: options.desktopAutomation,
    wakeWordEnabled: options.wakeWordEnabled,
    sensorPrimerSeen: options.sensorPrimerSeen,
    biometricsPrimerSeen: options.biometricsPrimerSeen,
    updatedAt: Date.now(),
  };
}

export function broadcastSensorPermissionChange(detail?: Partial<SensorPermissionSnapshot>) {
  if (!hasWindow()) return;
  window.dispatchEvent(new CustomEvent(SENSOR_PERMISSIONS_CHANGED, {
    detail: {
      ...detail,
      updatedAt: Date.now(),
    },
  }));
}

export async function requestSensorPermission(kind: SensorKind): Promise<{
  ok: boolean;
  state: SensorPermissionState;
  error?: string;
}> {
  setSensorEnabled(kind, true);

  if (!hasNavigator() || !navigator.mediaDevices?.getUserMedia) {
    const state: SensorPermissionState = 'unavailable';
    broadcastSensorPermissionChange({ [kind]: state } as Partial<SensorPermissionSnapshot>);
    return { ok: false, state, error: 'Media devices are unavailable in this runtime.' };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'microphone',
      video: kind === 'camera',
    });
    stream.getTracks().forEach(track => track.stop());
    const state = await queryPermission(kind);
    const nextState = state === 'unknown' ? 'granted' : state;
    broadcastSensorPermissionChange({ [kind]: nextState } as Partial<SensorPermissionSnapshot>);
    return { ok: nextState === 'granted', state: nextState };
  } catch (err: any) {
    const state = await queryPermission(kind);
    const nextState = state === 'unknown' ? 'denied' : state;
    broadcastSensorPermissionChange({ [kind]: nextState } as Partial<SensorPermissionSnapshot>);
    return {
      ok: false,
      state: nextState,
      error: err?.message || `Failed to request ${kind} permission.`,
    };
  }
}

async function requestSensorStream(kind: SensorKind, constraints: MediaStreamConstraints, signal?: AbortSignal): Promise<MediaStream> {
  const label = kind === 'microphone' ? 'Microphone' : 'Camera';
  signal?.throwIfAborted();
  if (!isSensorEnabled(kind)) throw new Error(`${label} is disabled in Lumi settings.`);
  if (!hasNavigator() || !navigator.mediaDevices?.getUserMedia) {
    broadcastSensorPermissionChange({ [kind]: 'unavailable' });
    throw new Error(`${label} is unavailable in this runtime.`);
  }
  const revision = accessRevision[kind];
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (signal?.aborted || revision !== accessRevision[kind] || !isSensorEnabled(kind)) {
      releaseSensorStream(kind, stream);
      throw new DOMException(`${label} request was cancelled.`, 'AbortError');
    }
    trackActiveStream(kind, stream);
    broadcastSensorPermissionChange({ [kind]: 'granted' });
    return stream;
  } catch (err) {
    // Cancellation is an application choice, not an OS permission denial.
    if ((err as Error)?.name !== 'AbortError') {
      const state = await queryPermission(kind);
      broadcastSensorPermissionChange({ [kind]: state === 'unknown' ? 'denied' : state });
    }
    throw err;
  }
}

export function requestMicrophoneStream(audio: MediaStreamConstraints['audio'] = true, signal?: AbortSignal): Promise<MediaStream> {
  return requestSensorStream('microphone', { audio, video: false }, signal);
}

export function requestCameraStream(video: MediaStreamConstraints['video'] = true, signal?: AbortSignal): Promise<MediaStream> {
  return requestSensorStream('camera', { video, audio: false }, signal);
}
