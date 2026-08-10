import { describe, expect, it, vi } from 'vitest';
import {
  applyPreferredVoiceOutputDevice,
  buildPreferredVoiceInputConstraints,
  requestPreferredMicrophoneStream,
  VOICE_INPUT_DEVICE_KEY,
} from '../src/lib/voiceDevicePreferences';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('voice device preferences', () => {
  it('binds the selected microphone as an exact capture target', () => {
    expect(buildPreferredVoiceInputConstraints({ echoCancellation: true }, 'mic-2')).toEqual({
      echoCancellation: true,
      deviceId: { exact: 'mic-2' },
    });
  });

  it('falls back to the system microphone only when the saved device disappeared', async () => {
    const storage = memoryStorage({ [VOICE_INPUT_DEVICE_KEY]: 'missing-mic' });
    const fallbackStream = {} as MediaStream;
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFoundError' }))
      .mockResolvedValueOnce(fallbackStream);

    await expect(requestPreferredMicrophoneStream(
      { noiseSuppression: true },
      { storage, request },
    )).resolves.toBe(fallbackStream);

    expect(request).toHaveBeenNthCalledWith(1, {
      noiseSuppression: true,
      deviceId: { exact: 'missing-mic' },
    });
    expect(request).toHaveBeenNthCalledWith(2, { noiseSuppression: true });
    expect(storage.getItem(VOICE_INPUT_DEVICE_KEY)).toBeNull();
  });

  it('does not hide microphone permission failures behind a fallback', async () => {
    const storage = memoryStorage({ [VOICE_INPUT_DEVICE_KEY]: 'mic-2' });
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const request = vi.fn().mockRejectedValue(denied);

    await expect(requestPreferredMicrophoneStream({}, { storage, request })).rejects.toBe(denied);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('routes speech output through the selected sink when supported', async () => {
    const storage = memoryStorage({ lumi_voice_output_device: 'speaker-2' });
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const context = { setSinkId } as unknown as AudioContext;

    await expect(applyPreferredVoiceOutputDevice(context, storage)).resolves.toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('speaker-2');
  });
});
