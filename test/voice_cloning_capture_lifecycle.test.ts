// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
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
  const source = fs.readFileSync(path.join(process.cwd(), 'src/hooks/useWakeWord.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  const imports: Record<string, any> = {
    react: React,
    '@/services/sensorPermissionService': sensors,
    '@/services/apiClient': { apiFetch: async () => ({ ok: true, json: async () => ({ QWEN_API_KEY: true }) }) },
    '@/i18n/runtime': { translate: (key: string) => key },
    '@/lib/audioContextLifecycle': { closeAudioContext: vi.fn() },
    '@/services/voiceService': { VOICE_PROVIDER_CHANGED_EVENT: 'lumi:voice-provider-changed' },
  };
  new Function('require', 'module', 'exports', js)((name: string) => {
    if (!(name in imports)) throw new Error(`Unexpected hook dependency: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports as typeof import('../src/hooks/useWakeWord');
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

it('releases a late wake-word grant after unmount without opening a server wake session', async () => {
  let grant!: (stream: MediaStream) => void;
  vi.mocked(requestMicrophoneStream).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const audio = vi.fn(); vi.stubGlobal('AudioContext', audio);
  const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] } as any;
  const socket = { id: 'synthetic', connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn() } as any;
  const hook = renderHook(() => useWakeWord({ socket, enabled: false, startCallRef: { current: vi.fn() } }));
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.enable(); });
  await act(async () => { await hook.result.current.enable(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(requestMicrophoneStream).toHaveBeenCalledOnce();
  hook.unmount();
  await act(async () => { grant(stream); await pending; });
  expect(stop).toHaveBeenCalledOnce(); expect(audio).not.toHaveBeenCalled();
  expect(socket.emit.mock.calls.some((call: any[]) => call[0] === 'wake:start')).toBe(false);
});
