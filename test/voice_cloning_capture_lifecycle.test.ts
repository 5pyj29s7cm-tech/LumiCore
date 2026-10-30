// @vitest-environment jsdom
import { loadSourceModule } from './source_expression';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/services/voiceService', () => ({
  uploadSamples: vi.fn(), cloneVoice: vi.fn(), getVoiceCloneStatus: vi.fn(),
  listVoices: vi.fn().mockResolvedValue({ cloned: [], premade: [], capabilities: { clone: false } }),
  VOICE_PROVIDER_CHANGED_EVENT: 'test-voice-provider',
}));
vi.mock('../src/services/sensorPermissionService', () => ({ requestMicrophoneStream: vi.fn(), releaseSensorStream: vi.fn((_kind, stream) => stream.getTracks().forEach((track: any) => track.stop())) }));
vi.mock('../src/lib/audioContextLifecycle', () => ({ closeAudioContext: vi.fn() }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ QWEN_API_KEY: true }) }) }));
import * as sensors from '../src/services/sensorPermissionService';
import { requestMicrophoneStream } from '../src/services/sensorPermissionService';
import { useVoiceCloning } from '../src/hooks/useVoiceCloning';
import { useVoiceprint } from '../src/hooks/useVoiceprint';
// Exercise the real hook with injected boundaries. This checkout deliberately
// has no optional Picovoice package; the Qwen capture path does not require it.
function loadWakeHook(): typeof import('../src/hooks/useWakeWord') {
  return loadSourceModule('src/hooks/useWakeWord.ts', {
    react: React,
    '@/services/sensorPermissionService': sensors,
    '@/services/apiClient': { apiFetch: async () => ({ ok: true, json: async () => ({ QWEN_API_KEY: true }) }) },
    '@/i18n/runtime': { translate: (key: string) => key },
    '@/lib/audioContextLifecycle': { closeAudioContext: vi.fn() },
    '@/services/voiceService': { VOICE_PROVIDER_CHANGED_EVENT: 'lumi:voice-provider-changed' },
  });
}
const { useWakeWord } = loadWakeHook();
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('does not create a recorder after its pending microphone request loses its owner', async () => {
  let grant!: (stream: MediaStream) => void;
  vi.mocked(requestMicrophoneStream).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const recorder = vi.fn(); vi.stubGlobal('MediaRecorder', recorder);
  const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] } as any;
  const hook = renderHook(() => useVoiceCloning());
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.startRecording(); });
  const signal = vi.mocked(requestMicrophoneStream).mock.calls[0][1]!;
  hook.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => { grant(stream); await pending; });
  expect(stop).toHaveBeenCalledOnce(); expect(recorder).not.toHaveBeenCalled();
});

it('releases a late voiceprint grant after stop without creating audio processing', async () => {
  let grant!: (stream: MediaStream) => void;
  vi.mocked(requestMicrophoneStream).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const audio = vi.fn(); vi.stubGlobal('AudioContext', audio);
  const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] } as any;
  const hook = renderHook(() => useVoiceprint());
  let pending!: Promise<boolean>;
  act(() => { pending = hook.result.current.startListening(); });
  act(() => hook.result.current.stopListening());
  await act(async () => { grant(stream); expect(await pending).toBe(false); });
  expect(stop).toHaveBeenCalledOnce(); expect(audio).not.toHaveBeenCalled(); hook.unmount();
});

it('releases a late wake-word grant after enabled server readiness and unmount without starting audio processing', async () => {
  let grant!: (stream: MediaStream) => void;
  vi.mocked(requestMicrophoneStream).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const audio = vi.fn(); vi.stubGlobal('AudioContext', audio);
  const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] } as any;
  const listeners = new Map<string, (...args: any[]) => any>();
  const socket = { id: 'synthetic', connected: true,
    on: vi.fn((event: string, handler: (...args: any[]) => any) => listeners.set(event, handler)),
    off: vi.fn((event: string, handler: (...args: any[]) => any) => { if (listeners.get(event) === handler) listeners.delete(event); }), emit: vi.fn() } as any;
  const startCall = vi.fn();
  const hook = renderHook(() => useWakeWord({ socket, enabled: true, startCallRef: { current: startCall } }));
  await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('wake:start'));
  expect(requestMicrophoneStream).not.toHaveBeenCalled();
  const ready = listeners.get('wake:started')!;
  let pending!: Promise<void>;
  act(() => { pending = ready(); void ready(); });
  expect(requestMicrophoneStream).toHaveBeenCalledOnce();
  const signal = vi.mocked(requestMicrophoneStream).mock.calls[0][1]!;
  hook.unmount();
  expect(signal.aborted).toBe(true); expect(listeners.has('wake:started')).toBe(false);
  await act(async () => { grant(stream); await pending; });
  expect(stop).toHaveBeenCalledOnce(); expect(audio).not.toHaveBeenCalled();
  expect(socket.emit.mock.calls.filter((call: any[]) => call[0] === 'wake:start')).toHaveLength(1);
  expect(socket.emit).toHaveBeenCalledWith('wake:stop');
  expect(socket.emit.mock.calls.some((call: any[]) => call[0] === 'wake:audio')).toBe(false);
  await act(async () => { await ready(); });
  expect(requestMicrophoneStream).toHaveBeenCalledOnce(); expect(startCall).not.toHaveBeenCalled();
});
