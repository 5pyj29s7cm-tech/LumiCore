// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/services/voiceService', () => ({ synthesizeSpeech: vi.fn(), VOICE_PROVIDER_CHANGED_EVENT: 'voice-provider-test' }));
import { synthesizeSpeech } from '../src/services/voiceService';
import { useVoicePreview } from '../src/hooks/useVoicePreview';
const instances: FakeAudio[] = [];
class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
  constructor(public src: string) { instances.push(this); }
}
beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:voice-${instances.length}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.mocked(synthesizeSpeech).mockResolvedValue(new ArrayBuffer(8));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('one audition playback owner', () => {
  it('stops and releases the previous card when another mounted card starts', async () => {
    const first = renderHook(() => useVoicePreview(vi.fn()));
    const second = renderHook(() => useVoicePreview(vi.fn()));
    await act(() => first.result.current.play({ voiceId: 'a' }, 'sample'));
    await act(() => second.result.current.play({ voiceId: 'b' }, 'sample'));
    expect(instances[0].pause).toHaveBeenCalledOnce();
    expect(instances[0].onended).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-0');
    expect(first.result.current.playingId).toBeNull();
    expect(second.result.current.playingId).toBe('b');
    second.unmount(); first.unmount();
    expect(instances[1].pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('aborts pending synthesis on unmount and ignores a provider that resolves late', async () => {
    let resolve!: (value: ArrayBuffer) => void;
    vi.mocked(synthesizeSpeech).mockImplementation(() => new Promise(done => { resolve = done; }));
    const error = vi.fn(); const hook = renderHook(() => useVoicePreview(error));
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.play({ voiceId: 'a' }, 'sample'); });
    const signal = vi.mocked(synthesizeSpeech).mock.calls[0][4]!;
    hook.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { resolve(new ArrayBuffer(8)); await pending; });
    expect(instances).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it('releases remote demo playback when the provider changes', async () => {
    const hook = renderHook(() => useVoicePreview(vi.fn()));
    await act(() => hook.result.current.play({ voiceId: 'demo', provider: 'ark', demoAudio: 'https://invalid.example/demo' }, 'sample'));
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('voice-provider-test')); });
    expect(instances[0].pause).toHaveBeenCalledOnce();
    expect(instances[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(hook.result.current.playingId).toBeNull(); hook.unmount();
  });
});
