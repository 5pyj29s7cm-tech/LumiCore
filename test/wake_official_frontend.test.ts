// @vitest-environment jsdom
import { loadSourceModule } from './source_expression';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchApi = vi.fn();
const microphone = vi.fn();
const closeContext = vi.fn();
const picovoiceCreate = vi.fn();
let picovoiceDetected: ((detection: any) => void) | undefined;
const processors: any[] = [];
const streams: Array<{ getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> }> = [];
const imports: Record<string, any> = {
  react: React,
  '@/services/apiClient': { apiFetch: fetchApi },
  '@/services/sensorPermissionService': { requestMicrophoneStream: microphone, releaseSensorStream: (_kind: string, stream: MediaStream) => stream.getTracks().forEach(track => track.stop()) },
  '@/i18n/runtime': { translate: (key: string) => key },
  '@/lib/audioContextLifecycle': { closeAudioContext: closeContext },
  '@/services/voiceService': { VOICE_PROVIDER_CHANGED_EVENT: 'lumi:voice-provider-changed' },
  '@picovoice/porcupine-web': { Porcupine: { create: picovoiceCreate }, BuiltInKeyword: { Jarvis: 'synthetic-Jarvis' } },
};
const { useWakeWord } = loadSourceModule<typeof import('../src/hooks/useWakeWord')>('src/hooks/useWakeWord.ts', imports);

function socket(id: string) {
  const callbacks = new Map<string, Set<(...args: any[]) => void>>();
  return { id, connected: true, emit: vi.fn(),
    on: (name: string, callback: (...args: any[]) => void) => { const set = callbacks.get(name) || new Set(); set.add(callback); callbacks.set(name, set); },
    off: (name: string, callback: (...args: any[]) => void) => callbacks.get(name)?.delete(callback),
    receive: (name: string, ...args: any[]) => [...(callbacks.get(name) || [])].forEach(callback => callback(...args)),
    listeners: (name: string) => [...(callbacks.get(name) || [])],
  };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); streams.length = 0; processors.length = 0; picovoiceDetected = undefined;
  picovoiceCreate.mockImplementation(async (_key, _keyword, detected) => { picovoiceDetected = detected; return { sampleRate: 16000, frameLength: 512, process: vi.fn(), release: vi.fn() }; });
  fetchApi.mockResolvedValue({ ok: true, json: async () => ({ pref: { stt: 'relay', sttModel: 'aliyun/selected-asr' }, active: { streamingStt: 'relay' } }) });
  microphone.mockImplementation(async () => { const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] }; streams.push(stream); return stream; });
  vi.stubGlobal('AudioContext', class {
    destination = {};
    createMediaStreamSource() { return { connect: vi.fn() }; }
    createScriptProcessor() { const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }; processors.push(processor); return processor; }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function ready(peer: ReturnType<typeof socket>) {
  await act(async () => { peer.receive('wake:started'); });
}

describe('official wake capture', () => {
  it('starts with only the selected official STT capability and waits for server readiness', async () => {
    const peer = socket('official-only'); const startCall = vi.fn();
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef: { current: startCall } }));
    await waitFor(() => expect(peer.emit).toHaveBeenCalledWith('wake:start'));
    expect(fetchApi).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(hook.result.current.isListening).toBe(false);
    await ready(peer); expect(hook.result.current.isListening).toBe(true);
    act(() => peer.receive('wake:detected', { keyword: 'Lumi', timestamp: 'synthetic-time' })); expect(startCall).toHaveBeenCalledOnce();
    hook.unmount(); expect(streams[0].getTracks()[0].stop).toHaveBeenCalledOnce();
  });

  it.each(['server', 'picovoice'])('calls the latest standard entry without reopening %s wake capture after voice and scope changes', async backend => {
    const peer = socket('latest-' + backend), previousStart = vi.fn(), latestStart = vi.fn(), interrupt = vi.fn();
    let ownerAllowed = true, callActive = false;
    const startCallRef = { current: previousStart };
    const oldSettings = { voiceId: 'synthetic-old-voice', personalityId: 'lumi', agentId: 'lumi', startCallOptions: { domain: 'personal' as 'personal' | 'work', orgId: '' } };
    const hook = renderHook(({ settings }) => useWakeWord({ socket: peer as any, enabled: true, startCallRef, canAcceptWake: () => ownerAllowed, isCallActive: () => callActive, onInterrupt: interrupt, accessKey: backend === 'picovoice' ? 'synthetic-local-wake-key' : undefined, ...settings }), { initialProps: { settings: oldSettings } });
    if (backend === 'server') {
      await waitFor(() => expect(peer.emit).toHaveBeenCalledWith('wake:start'));
      await ready(peer);
    } else await waitFor(() => expect(hook.result.current.isListening).toBe(true));
    const detected = backend === 'server' ? peer.listeners('wake:detected')[0] : picovoiceDetected!;
    startCallRef.current = latestStart;
    hook.rerender({ settings: { ...oldSettings, voiceId: 'synthetic-current-voice', startCallOptions: { domain: 'work', orgId: 'synthetic-current-org' } } });
    act(() => detected({ keyword: 'Lumi', timestamp: 'same-capture-current-entry' }));
    expect(previousStart).not.toHaveBeenCalled(); expect(latestStart).toHaveBeenCalledExactlyOnceWith();
    ownerAllowed = false; act(() => detected({ keyword: 'Lumi', timestamp: 'owner-denied' }));
    ownerAllowed = true; callActive = true; act(() => detected({ keyword: 'Lumi', timestamp: 'interrupt-current-call' }));
    expect(latestStart).toHaveBeenCalledOnce(); expect(interrupt).toHaveBeenCalledOnce();
    expect(microphone).toHaveBeenCalledOnce(); expect(streams[0].getTracks()[0].stop).not.toHaveBeenCalled();
    if (backend === 'picovoice') expect(picovoiceCreate).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it.each(['Official wake-word STT provider is not configured.', 'Unauthorized 401', 'Forbidden 403'])('does not open a microphone or retry a permanent provider error: %s', async message => {
    vi.useFakeTimers();
    const peer = socket('unavailable');
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef: { current: vi.fn() } }));
    await act(async () => {});
    expect(peer.emit).toHaveBeenCalledWith('wake:start');
    act(() => peer.receive('wake:error', { message }));
    expect(hook.result.current.error).toBe(message.includes('not configured') ? 'wakeServiceMissing' : 'wakeServiceUnavailable');
    expect(microphone).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(peer.emit.mock.calls.filter(call => call[0] === 'wake:start')).toHaveLength(1);
    expect(hook.result.current.isListening).toBe(false);
  });

  it('recovers after temporary health failure without caching an unhealthy snapshot as missing configuration', async () => {
    vi.useFakeTimers();
    fetchApi.mockResolvedValue({ ok: true, json: async () => ({ pref: { stt: 'relay' }, active: { streamingStt: null } }) });
    const peer = socket('health-recovery');
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef: { current: vi.fn() } }));
    await act(async () => {});
    expect(peer.emit).toHaveBeenCalledWith('wake:start');
    act(() => peer.receive('wake:error', { message: 'Official wake-word STT provider health circuit is open.' }));
    expect(microphone).not.toHaveBeenCalled();
    expect(hook.result.current.isListening).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(peer.emit.mock.calls.filter(call => call[0] === 'wake:start')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(peer.emit.mock.calls.filter(call => call[0] === 'wake:start')).toHaveLength(2);
    await ready(peer);
    expect(hook.result.current.isListening).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(microphone).toHaveBeenCalledOnce();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('ignores duplicate readiness and releases a microphone that resolves after the user stops', async () => {
    let finish!: (stream: any) => void;
    const stream = { getTracks: () => [{ stop: vi.fn() }] }; const stop = vi.fn(); stream.getTracks = () => [{ stop }];
    microphone.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const peer = socket('late-capture');
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef: { current: vi.fn() } }));
    await waitFor(() => expect(peer.emit).toHaveBeenCalledWith('wake:start'));
    const delayedReady = peer.listeners('wake:started')[0];
    act(() => { delayedReady(); delayedReady(); });
    expect(microphone).toHaveBeenCalledOnce(); expect(hook.result.current.isListening).toBe(false);
    hook.unmount();
    await act(async () => { finish(stream); });
    expect(stop).toHaveBeenCalledOnce(); expect(processors).toHaveLength(0);
    await act(async () => { await delayedReady(); }); expect(microphone).toHaveBeenCalledOnce();
  });

  it('never requests capture for readiness arriving after disconnect', async () => {
    const peer = socket('late-ready');
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef: { current: vi.fn() } }));
    await waitFor(() => expect(peer.emit).toHaveBeenCalledWith('wake:start'));
    const delayedReady = peer.listeners('wake:started')[0];
    act(() => { peer.connected = false; peer.receive('disconnect'); delayedReady(); });
    expect(microphone).not.toHaveBeenCalled(); expect(hook.result.current.isListening).toBe(false);
    hook.unmount();
  });

  it('stops its provider if microphone permission is refused after readiness', async () => {
    vi.useFakeTimers();
    microphone.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    const peer = socket('denied-microphone'); const startCallRef = { current: vi.fn() };
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef }));
    await act(async () => {});
    expect(microphone).not.toHaveBeenCalled();
    await ready(peer);
    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.error).toMatch(/Microphone permission denied/);
    expect(peer.listeners('wake:started')).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(peer.emit.mock.calls.filter(call => call[0] === 'wake:start')).toHaveLength(1);
  });

  it('replaces the captured session when voice settings change and rejects late old audio', async () => {
    const peer = socket('settings-change'); const startCall = vi.fn(); const startCallRef = { current: startCall };
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef }));
    await waitFor(() => expect(peer.emit).toHaveBeenCalledWith('wake:start'));
    await ready(peer);
    const oldProcessor = processors[0]; const oldDetected = peer.listeners('wake:detected')[0];
    act(() => window.dispatchEvent(new Event('lumi:voice-provider-changed')));
    await waitFor(() => expect(peer.emit.mock.calls.filter(call => call[0] === 'wake:start')).toHaveLength(2));
    expect(microphone).toHaveBeenCalledOnce();
    await ready(peer);
    expect(microphone).toHaveBeenCalledTimes(2);
    expect(streams[0].getTracks()[0].stop).toHaveBeenCalledOnce();
    peer.emit.mockClear();
    act(() => { oldProcessor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([1]) } }); oldDetected({ keyword: 'Lumi', timestamp: 'late' }); });
    expect(peer.emit).not.toHaveBeenCalledWith('wake:audio', expect.anything()); expect(startCall).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('releases capture and listeners immediately on disconnect', async () => {
    const peer = socket('disconnect'); const startCallRef = { current: vi.fn() };
    const hook = renderHook(() => useWakeWord({ socket: peer as any, enabled: true, startCallRef }));
    await waitFor(() => expect(peer.emit).toHaveBeenCalledWith('wake:start')); await ready(peer);
    act(() => { peer.connected = false; peer.receive('disconnect'); });
    expect(streams[0].getTracks()[0].stop).toHaveBeenCalledOnce();
    expect(peer.listeners('wake:detected')).toHaveLength(0); expect(hook.result.current.isListening).toBe(false);
    hook.unmount();
  });

  it('retires the old socket capture before starting on a replacement socket', async () => {
    const oldPeer = socket('old-socket'); const newPeer = socket('new-socket'); const startCallRef = { current: vi.fn() };
    const hook = renderHook(({ peer }) => useWakeWord({ socket: peer as any, enabled: true, startCallRef }), { initialProps: { peer: oldPeer } });
    await waitFor(() => expect(oldPeer.emit).toHaveBeenCalledWith('wake:start')); await ready(oldPeer);
    const oldDetected = oldPeer.listeners('wake:detected')[0];
    hook.rerender({ peer: newPeer });
    await waitFor(() => expect(newPeer.emit).toHaveBeenCalledWith('wake:start'));
    expect(oldPeer.listeners('wake:detected')).toHaveLength(0);
    expect(streams[0].getTracks()[0].stop).toHaveBeenCalledOnce();
    act(() => oldDetected({ keyword: 'Lumi', timestamp: 'late socket result' }));
    expect(startCallRef.current).not.toHaveBeenCalled(); hook.unmount();
  });
});
