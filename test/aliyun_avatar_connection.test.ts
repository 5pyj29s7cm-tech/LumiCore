// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { createAliyunAvatarConnection, floatToPortraitPcm } from '../src/lib/aliyunAvatarConnection';
const mocks = vi.hoisted(() => ({ create: vi.fn(), ready: vi.fn(), cancel: vi.fn(), heartbeat: vi.fn(), init: vi.fn(), sdk: null as any, frames: null as any,
  speechReady: null as any, state: null as any, error: null as any }));
vi.mock('../src/services/aliyunAvatarService', () => ({ aliyunAvatarService: mocks }));
vi.mock('lm-avatar-chat-sdk/cloud', () => ({ createCloudAvatar: (config: any) => { mocks.init(config); return mocks.sdk; }, TYVoiceChatMode: { tap2talk: 'tap2talk' }, TYVoiceChatState: { Responding: 'Responding' } }));
let connection: ReturnType<typeof createAliyunAvatarConnection>, playback: Mock<(value: boolean) => void>, failed: Mock<() => void>;
beforeEach(() => {
  vi.clearAllMocks(); playback = vi.fn(); failed = vi.fn();
  mocks.create.mockResolvedValue({ callSessionId: 'call', portraitSessionId: 'local-id', sessionId: 'remote-id', rtc: { token: 'ephemeral' } });
  mocks.ready.mockResolvedValue({ ok: true }); mocks.cancel.mockResolvedValue({ ok: true }); mocks.heartbeat.mockResolvedValue({ ok: true });
  mocks.sdk = { start: vi.fn(async () => { queueMicrotask(() => { mocks.frames(); mocks.speechReady(); }); }), exit: vi.fn(),
    onFirstFrameReceived: (fn: any) => { mocks.frames = fn; }, onReadyToSpeech: (fn: any) => { mocks.speechReady = fn; },
    onStateChanged: (fn: any) => { mocks.state = fn; }, onErrorReceived: (fn: any) => { mocks.error = fn; }, pushAudioData: vi.fn() };
  vi.stubGlobal('OfflineAudioContext', class {
    destination = {}; createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
    async decodeAudioData() { return { duration: 0.02 }; }
    async startRendering() { return { getChannelData: () => new Float32Array([0, 0.5, -1]) }; }
  });
  connection = createAliyunAvatarConnection({ avatarId: 'person', onStream: vi.fn(), onSurface: surface => { if (surface) document.body.append(surface); }, onPlayback: playback, onFailure: failed });
});
afterEach(async () => { await connection.closeAndWait().catch(() => {}); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ''; });
it('uses audio-only SDK with the same output sample rate as the PCM conversion', async () => {
  await connection.connect('call');
  expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({ ignoreAudioInput: true, sessionId: 'remote-id' }));
  expect(mocks.sdk.start).toHaveBeenCalledWith({ mode: 'tap2talk', outboundSampleRate: 24000, keepAlive: true });
  const speak = connection.playAudio({ audioBase64: 'YWJj', format: 'mp3' }, 'speech');
  await vi.waitFor(() => expect(mocks.sdk.pushAudioData).toHaveBeenCalled());
  expect(mocks.sdk.pushAudioData).toHaveBeenCalledWith(new Int16Array([0, 16384, -32768]), true);
  let done = false; void speak.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  mocks.state('Responding'); expect(playback).toHaveBeenLastCalledWith(true); mocks.state('StandBy'); await speak;
  expect(playback).toHaveBeenLastCalledWith(false);
  await expect(connection.playAudio({ audioBase64: 'YWJj', format: 'mp3' }, 'speech')).rejects.toThrow();
});
it('cancels queued audio on close and removes SDK output', async () => {
  await connection.connect('call'); const speak = connection.playAudio({ audioBase64: 'YWJj', format: 'wav' }, 'speech'); void speak.catch(() => {});
  await vi.waitFor(() => expect(mocks.sdk.pushAudioData).toHaveBeenCalled());
  await connection.closeAndWait(); await expect(speak).rejects.toThrow();
  expect(mocks.sdk.exit).toHaveBeenCalledTimes(1); expect(document.body.children).toHaveLength(0);
});
it('does not create a second billed session if cleanup was not confirmed', async () => {
  await connection.connect('call'); mocks.cancel.mockRejectedValue(new Error('not closed'));
  await expect(connection.closeAndWait()).rejects.toThrow(); await expect(connection.connect('call-two')).rejects.toThrow();
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('fails closed on lost heartbeat and reports it to the caller', async () => {
  await connection.connect('call'); vi.useFakeTimers();
  // The interval was registered on the real clock; use a new connection under the fake clock.
  await connection.closeAndWait(); await connection.connect('call'); mocks.heartbeat.mockRejectedValue(new Error('gone'));
  await vi.advanceTimersByTimeAsync(30_000); expect(failed).toHaveBeenCalledTimes(1);
});
it('clamps PCM samples without signed overflow', () => {
  expect(Array.from(floatToPortraitPcm(new Float32Array([-2, -1, 0, 1, 2])))).toEqual([-32768, -32768, 0, 32767, 32767]);
});
