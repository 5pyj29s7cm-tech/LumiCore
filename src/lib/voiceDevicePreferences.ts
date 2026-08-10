import { requestMicrophoneStream } from '@/services/sensorPermissionService';

export const VOICE_INPUT_DEVICE_KEY = 'lumi_voice_input_device';
export const VOICE_OUTPUT_DEVICE_KEY = 'lumi_voice_output_device';
export const VOICE_DEVICE_PREFERENCE_CHANGED = 'lumi:voice-device-preference-changed';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): WritableStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getPreferredVoiceInputDeviceId(storage: ReadableStorage | null = browserStorage()): string {
  try { return storage?.getItem(VOICE_INPUT_DEVICE_KEY)?.trim() || ''; } catch { return ''; }
}

export function getPreferredVoiceOutputDeviceId(storage: ReadableStorage | null = browserStorage()): string {
  try { return storage?.getItem(VOICE_OUTPUT_DEVICE_KEY)?.trim() || ''; } catch { return ''; }
}

export function setVoiceDevicePreference(
  kind: 'input' | 'output',
  deviceId: string,
  storage: WritableStorage | null = browserStorage(),
): void {
  const key = kind === 'input' ? VOICE_INPUT_DEVICE_KEY : VOICE_OUTPUT_DEVICE_KEY;
  try {
    if (deviceId) storage?.setItem(key, deviceId);
    else storage?.removeItem(key);
  } catch {}
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(VOICE_DEVICE_PREFERENCE_CHANGED, {
      detail: { kind, deviceId },
    }));
  }
}

export function buildPreferredVoiceInputConstraints(
  base: MediaTrackConstraints,
  deviceId: string,
): MediaTrackConstraints {
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base };
}

function isUnavailableDeviceError(error: any): boolean {
  return ['NotFoundError', 'OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(error?.name);
}

export async function requestPreferredMicrophoneStream(
  base: MediaTrackConstraints,
  dependencies: {
    storage?: WritableStorage | null;
    request?: typeof requestMicrophoneStream;
  } = {},
): Promise<MediaStream> {
  const storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
  const request = dependencies.request ?? requestMicrophoneStream;
  const preferredId = getPreferredVoiceInputDeviceId(storage);
  if (!preferredId) return request(base);

  try {
    return await request(buildPreferredVoiceInputConstraints(base, preferredId));
  } catch (error: any) {
    if (!isUnavailableDeviceError(error)) throw error;
    try { storage?.removeItem(VOICE_INPUT_DEVICE_KEY); } catch {}
    return request(base);
  }
}

export async function applyPreferredVoiceOutputDevice(
  context: AudioContext,
  storage: ReadableStorage | null = browserStorage(),
): Promise<boolean> {
  const setSinkId = (context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }).setSinkId;
  if (typeof setSinkId !== 'function') return false;
  try {
    await setSinkId.call(context, getPreferredVoiceOutputDeviceId(storage));
    return true;
  } catch {
    return false;
  }
}
