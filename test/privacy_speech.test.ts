import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), socket: vi.fn(), runtime: vi.fn(),
  localTranscribe: vi.fn(), localAvailable: false, runtimeReady: false,
  preference: { stt: 'relay', tts: 'relay' },
}));
vi.mock('ws', () => ({ WebSocket: mocks.socket, default: mocks.socket }));
vi.mock('../server/config/keys', () => ({ getKey: () => 'synthetic-test-key', loadKeys: () => ({}) }));
vi.mock('../server/config/voice_preference', () => ({ getVoicePreference: () => mocks.preference }));
vi.mock('../server/relay/config', () => ({ relayConfigured: () => true }));
vi.mock('../server/stt/providers/local-whisper', () => ({
  isLocalWhisperAvailable: () => mocks.localAvailable, transcribe: mocks.localTranscribe,
}));
vi.mock('../server/tts/gptsovits_runtime', () => ({
  ensureGptSovitsRuntime: mocks.runtime,
  isGptSovitsRuntimeInstalled: () => false,
  isGptSovitsRuntimeReady: () => mocks.runtimeReady,
  markGptSovitsActivity: vi.fn(),
}));
vi.mock('../server/socket/voice', () => ({ isEchoText: () => false, isTtsPlaying: () => false }));

import * as stt from '../server/stt/adapter';
import * as qwen from '../server/stt/providers/qwen';
import * as arkStream from '../server/stt/providers/ark_stream';
import * as officialStt from '../server/stt/providers/official';
import * as whisper from '../server/stt/providers/whisper';
import * as arkStt from '../server/stt/providers/ark';
import * as dashscope from '../server/stt/providers/dashscope-file';
import { createWakeDetector } from '../server/stt/wake_detector';
import { registerWakeHandlers } from '../server/socket/wake';
import * as tts from '../server/tts/adapter';
import * as cosyvoice from '../server/tts/providers/cosyvoice';
import * as arkTts from '../server/tts/providers/ark';
import * as relayTts from '../server/tts/providers/relay';
import * as localCosyvoice from '../server/tts/providers/local_cosyvoice';
import * as gptsovits from '../server/tts/providers/gptsovits';
import { escalateIfUncertain, verifyFaceCloud, verifyVoiceprintCloud } from '../server/biometrics/cloud_verify';
import { resetCircuit } from '../server/cloud/circuit_breaker';

beforeEach(() => {
  vi.clearAllMocks();
  resetCircuit();
  vi.stubEnv('LUMI_PRIVACY', 'strict');
  for (const name of ['LOCAL_COSYVOICE_API_URL', 'COSYVOICE_LOCAL_API_URL', 'LOCAL_COSYVOICE_ENABLED',
    'LOCAL_COSYVOICE_TTS_PATH', 'COSYVOICE_LOCAL_TTS_PATH', 'GPTSOVITS_API_URL', 'GPTSOVITS_ENABLED']) vi.stubEnv(name, '');
  mocks.localAvailable = false;
  mocks.runtimeReady = false;
  mocks.preference = { stt: 'relay', tts: 'relay' };
  mocks.fetch.mockReset().mockRejectedValue(new Error('Unexpected network call'));
  mocks.runtime.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('WebSocket', mocks.socket);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('strict speech transport boundaries', () => {
  it.each(['qwen', 'ark', 'relay'] as const)('blocks %s realtime and batch adapter routes without a transport', async provider => {
    expect(() => stt.createStreamingSession({ provider })).toThrow('[Privacy]');
    const injectedFactory = vi.fn();
    expect(() => stt.createResilientStreamingSession({ provider }, { createSession: injectedFactory })).toThrow('[Privacy]');
    await expect(stt.transcribe(Buffer.from('private audio'), { provider })).rejects.toThrow('[Privacy]');
    expect(injectedFactory).not.toHaveBeenCalled();
    expect(mocks.socket).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blocks direct cloud STT imports, probes, and wake creation before connection or upload', async () => {
    expect(() => qwen.createStream()).toThrow('[Privacy]');
    expect(() => arkStream.createStream()).toThrow('[Privacy]');
    expect(() => officialStt.createStream()).toThrow('[Privacy]');
    expect(() => createWakeDetector('synthetic-key')).toThrow('[Privacy]');
    await expect(arkStream.probeDoubaoStreamingConnection()).rejects.toThrow('[Privacy]');
    for (const provider of [whisper, arkStt, dashscope, officialStt]) {
      await expect(provider.transcribe(Buffer.from('private audio'))).rejects.toThrow('[Privacy]');
    }
    expect(mocks.socket).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(stt.isRecoverableStreamingSTTError(new Error('[Privacy] Strict mode'))).toBe(false);
  });

  it('reports wake disabled through its socket error without crashing or claiming it started', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const socket = { id: 'privacy-test', on: (event: string, fn: (...args: any[]) => any) => handlers.set(event, fn), emit: vi.fn() };
    registerWakeHandlers(socket as any, () => 'synthetic-user');
    await expect(handlers.get('wake:start')!()).resolves.toBeUndefined();
    handlers.get('wake:audio')!(Buffer.from('private microphone'));
    expect(socket.emit).toHaveBeenCalledWith('wake:error', { message: expect.stringContaining('[Privacy]') });
    expect(socket.emit).not.toHaveBeenCalledWith('wake:started');
    expect(mocks.socket).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('selects only installed local batch STT and never replaces missing local STT with cloud', async () => {
    expect(stt.getActiveSTTProvider()).toBeNull();
    expect(stt.getActiveStreamingSTTProvider()).toBeNull();
    await expect(stt.transcribe(Buffer.from('audio'), { provider: 'local-whisper' })).rejects.toThrow('No STT provider');
    mocks.localAvailable = true;
    const result = { text: 'local transcript', isFinal: true };
    mocks.localTranscribe.mockResolvedValueOnce(result);
    expect(stt.getActiveSTTProvider()).toBe('local-whisper');
    await expect(stt.transcribe(Buffer.from('audio'), { provider: 'local-whisper' })).resolves.toEqual(result);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['cosyvoice', 'ark', 'relay'] as const)('blocks explicit %s TTS with no cloud fallback', async provider => {
    await expect(tts.synthesizeSpeech('private reply', { provider, voiceId: 'default', allowFallback: true })).rejects.toThrow('[Privacy]');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it('blocks direct cloud synthesis, cloning, design and biometric fallback', async () => {
    for (const provider of [cosyvoice, arkTts, relayTts]) {
      await expect(provider.synthesizeSpeech('private reply')).rejects.toThrow('[Privacy]');
    }
    const sample = { name: 'synthetic', sampleUrls: ['does-not-exist.wav'] };
    await expect(cosyvoice.cloneVoice(sample.sampleUrls, sample.name)).rejects.toThrow('[Privacy]');
    await expect(cosyvoice.designVoice('private prompt', 'synthetic')).rejects.toThrow('[Privacy]');
    await expect(arkTts.cloneVoice(sample)).rejects.toThrow('[Privacy]');
    await expect(arkTts.getVoiceCloneStatus('private-speaker-id')).rejects.toThrow('[Privacy]');
    await expect(tts.cloneVoice(sample, 'cosyvoice')).rejects.toThrow('[Privacy]');
    await expect(tts.designVoice('private prompt', 'synthetic')).rejects.toThrow('[Privacy]');
    await expect(tts.getVoiceCloneStatus('private-speaker-id', 'ark')).rejects.toThrow('[Privacy]');
    await expect(verifyFaceCloud('synthetic-face', 'synthetic-face')).rejects.toThrow('[Privacy]');
    await expect(verifyVoiceprintCloud('synthetic-audio', 'synthetic-id')).rejects.toThrow('[Privacy]');
    const escalation = vi.fn();
    await expect(escalateIfUncertain(0.6, 0.8, escalation)).resolves.toEqual({ matched: true, confidence: 0.6, source: 'local' });
    expect(escalation).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('auto TTS stays unavailable with only cloud configured or a cold local runtime', () => {
    expect(tts.getActiveProvider()).toBeNull();
    expect(tts.getFallbackProvider('local-cosyvoice')).toBeNull();
    vi.stubEnv('GPTSOVITS_ENABLED', 'true');
    expect(tts.getActiveProvider()).toBeNull();
    expect(tts.getFallbackProvider('local-cosyvoice')).toBeNull();
    mocks.runtimeReady = true;
    expect(tts.getActiveProvider()).toBe('gptsovits');
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});

describe('strict local TTS endpoint enforcement', () => {
  it.each(['https://remote.example', 'http://127.0.0.1.remote.example', 'http://user:password@localhost:50000', 'http://192.168.1.2'])('rejects a local provider configured as %s before runtime or fetch', async endpoint => {
    vi.stubEnv('LOCAL_COSYVOICE_API_URL', endpoint);
    vi.stubEnv('GPTSOVITS_API_URL', endpoint);
    expect(localCosyvoice.isConfigured()).toBe(false);
    expect(gptsovits.isConfigured()).toBe(false);
    await expect(localCosyvoice.synthesizeSpeech('private reply')).rejects.toThrow('[Privacy]');
    await expect(gptsovits.synthesizeSpeech('private reply')).rejects.toThrow('[Privacy]');
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('permits loopback synthesis and prohibits fetch redirects', async () => {
    vi.stubEnv('LOCAL_COSYVOICE_API_URL', 'http://127.0.0.1:50000');
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(localCosyvoice.synthesizeSpeech('local reply')).resolves.toMatchObject({ format: 'audio/wav' });
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:50000/inference_sft', expect.objectContaining({ redirect: 'error' }));
  });

  it('blocks a local server returning a remote audio URL and never falls back to cloud', async () => {
    vi.stubEnv('LOCAL_COSYVOICE_API_URL', 'http://localhost:50000');
    vi.stubEnv('LOCAL_COSYVOICE_TTS_PATH', '/tts');
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ audio_url: 'https://remote.example/private-audio' }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(tts.synthesizeSpeech('private reply', { provider: 'local-cosyvoice', voiceId: 'default' })).rejects.toThrow('[Privacy]');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('also disables redirects on secondary local audio downloads', async () => {
    vi.stubEnv('LOCAL_COSYVOICE_API_URL', 'http://localhost:50000');
    vi.stubEnv('LOCAL_COSYVOICE_TTS_PATH', '/tts');
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ audio_url: 'http://localhost:50000/audio.wav' }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } }));
    await localCosyvoice.synthesizeSpeech('local reply');
    expect(mocks.fetch).toHaveBeenNthCalledWith(2, 'http://localhost:50000/audio.wav', expect.objectContaining({ redirect: 'error' }));
  });

  it('passes the redirect restriction and text to a permitted GPT-SoVITS endpoint', async () => {
    vi.stubEnv('GPTSOVITS_API_URL', 'http://[::1]:9880');
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await expect(gptsovits.synthesizeSpeech('local reply')).resolves.toMatchObject({ format: 'audio/wav' });
    expect(mocks.fetch).toHaveBeenCalledWith('http://[::1]:9880/tts', expect.objectContaining({ redirect: 'error', body: expect.stringContaining('local reply') }));
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it('does not bootstrap the default GPT-SoVITS runtime even through a direct provider call', async () => {
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await gptsovits.synthesizeSpeech('local reply');
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:9880/tts', expect.objectContaining({ redirect: 'error' }));
    expect(mocks.runtime).not.toHaveBeenCalled();
  });
});
