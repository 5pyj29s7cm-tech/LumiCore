// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { act, renderHook } from '@testing-library/react';
const fixture = vi.hoisted(() => ({ tracks: [] as any[], sources: [] as any[], processors: [] as any[], cameras: [] as any[] }));
vi.mock('../src/lib/voiceDevicePreferences', () => ({
  VOICE_DEVICE_PREFERENCE_CHANGED: 'fixture-devices', applyPreferredVoiceOutputDevice: async () => {},
  requestPreferredMicrophoneStream: async () => {
    const track = { enabled: true, readyState: 'live', stop: vi.fn() }; fixture.tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  },
}));
vi.mock('../src/services/sensorPermissionService', () => ({
  requestCameraStream: async () => {
    const track = { enabled: true, addEventListener: vi.fn(), stop: vi.fn() };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] }; fixture.cameras.push(stream); return stream;
  },
  releaseSensorStream: (_kind: string, stream: any) => stream?.getTracks().forEach((track: any) => track.stop()),
}));
import { createMemoryAvatarVoiceSocket, useMemoryAvatarCall } from '../src/hooks/useMemoryAvatarCall';
import { useVoiceCall } from '../src/hooks/useVoiceCall';

class Client extends EventEmitter {
  connected = true; volatile = this; outputs: Array<[string, any]> = [];
  emit(event: string, data?: any): boolean { this.outputs.push([event, data]); return true; }
  deliver(event: string, data?: any) { return super.emit(event, data); }
}
class AudioContextFixture {
  state = 'running'; currentTime = 0; destination = {};
  createGain() { return { gain: { value: 1, setValueAtTime: vi.fn() }, connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 256, connect() {}, disconnect() {}, getByteTimeDomainData(samples: Uint8Array) { samples.fill(160); } }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { const processor = { onaudioprocess: null, connect() {}, disconnect() {} }; fixture.processors.push(processor); return processor; }
  createBufferSource() { const source = { buffer: null, onended: null as any, connect() {}, disconnect() {}, start: vi.fn(), stop: vi.fn() }; fixture.sources.push(source); return source; }
  async decodeAudioData() { return { duration: 2 }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
beforeEach(() => {
  fixture.tracks = []; fixture.sources = []; fixture.processors = []; fixture.cameras = [];
  vi.stubGlobal('AudioContext', AudioContextFixture);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('private avatar audio socket bridge', () => {
  it('namespaces input and output, fences exact avatar/session, and excludes perception messages', () => {
    const client = new Client(); const adapter = createMemoryAvatarVoiceSocket(client, 'memory_avatar_a');
    const listener = vi.fn(); adapter.on('agent:response', listener);
    adapter.emit('audio:start', { sessionId: 'call-a' });
    adapter.volatile.emit('audio:chunk', new Uint8Array([1, 2]));
    expect(client.outputs.at(-1)).toEqual(['avatar:audio:chunk', { avatarId: 'memory_avatar_a', sessionId: 'call-a', chunk: new Uint8Array([1, 2]) }]);
    adapter.emit('perception:audio_emotion', { emotion: 'happy' });
    expect(client.outputs.some(([event]) => event.includes('perception'))).toBe(false);
    client.deliver('agent:response', { avatarId: 'memory_avatar_a', sessionId: 'call-a' });
    client.deliver('avatar:agent:response', { avatarId: 'memory_avatar_b', sessionId: 'call-a' });
    client.deliver('avatar:agent:response', { avatarId: 'memory_avatar_a', sessionId: 'old' });
    expect(listener).not.toHaveBeenCalled();
    client.deliver('avatar:agent:response', { avatarId: 'memory_avatar_a', sessionId: 'call-a' });
    expect(listener).toHaveBeenCalledOnce();
    adapter.emit('audio:stop');
    client.deliver('avatar:agent:response', { avatarId: 'memory_avatar_a', sessionId: 'call-a' });
    expect(listener).toHaveBeenCalledOnce(); adapter.off('agent:response', listener);
  });

  it('switching from a mounted Lumi call releases its microphone before opening the avatar microphone', async () => {
    const client = new Client();
    const main = renderHook(() => useVoiceCall({ socket: client }));
    const avatar = renderHook(() => useMemoryAvatarCall({ socket: client, avatarId: 'memory_avatar_a', ownerId: 'owner', enabled: true }));
    try {
      await act(async () => { await main.result.current.startCall(); });
      const firstTrack = fixture.tracks[0];
      await act(async () => { await avatar.result.current.startVoice(); });
      expect(firstTrack.stop).toHaveBeenCalledOnce();
      expect(main.result.current.callState).toBe('idle');
      expect(fixture.tracks).toHaveLength(2);
      expect(client.outputs.some(([event]) => event === 'audio:stop')).toBe(true);
      expect(client.outputs.some(([event]) => event === 'avatar:audio:start')).toBe(true);
    } finally { main.unmount(); avatar.unmount(); }
  });

  it('passes durable request IDs and derives mouth motion from actual output samples only', async () => {
    const client = new Client(); const onTranscript = vi.fn(); const onResponse = vi.fn();
    const hook = renderHook(() => useMemoryAvatarCall({ socket: client, avatarId: 'memory_avatar_a', ownerId: 'owner', enabled: true, onTranscript, onResponse }));
    try {
      await act(async () => { await hook.result.current.startVoice(); });
      const start = client.outputs.find(([event]) => event === 'avatar:audio:start')![1];
      const envelope = { ...start, requestId: 'voice-request' };
      expect(hook.result.current.outputLevelRef.current).toBe(0);
      await act(async () => {
        client.deliver('avatar:audio:status', { ...envelope, status: 'thinking' });
        client.deliver('avatar:audio:transcript', { ...envelope, text: 'Hello', isFinal: true });
        client.deliver('avatar:agent:response', { ...envelope, channel: 'voice', text: 'Hello back', finalized: true });
        client.deliver('avatar:audio:response', { ...envelope, lane: 'conversation', buffer: new Uint8Array([1, 2]).buffer, format: 'wav' });
        await Promise.resolve();
      });
      expect(onTranscript).toHaveBeenCalledWith('Hello', true, expect.objectContaining({ requestId: 'voice-request' }));
      expect(onResponse).toHaveBeenCalledWith('Hello back', { requestId: 'voice-request' });
      await vi.waitFor(() => expect(hook.result.current.outputLevelRef.current).toBeCloseTo(0.25));
      expect(fixture.sources.at(-1)?.start).toHaveBeenCalledOnce();
      await act(async () => { hook.result.current.end(); });
      expect(hook.result.current.outputLevelRef.current).toBe(0);
    } finally { hook.unmount(); }
  });

  it('account change with an unchanged avatar ID releases camera/microphone and rejects old replies', async () => {
    const client = new Client(); const onResponse = vi.fn();
    const hook = renderHook(({ ownerId }) => useMemoryAvatarCall({ socket: client, avatarId: 'memory_avatar_a', ownerId, enabled: true, onResponse }), { initialProps: { ownerId: 'owner-a' } });
    try {
      await act(async () => { await hook.result.current.startVideo(); });
      const start = client.outputs.find(([event]) => event === 'avatar:audio:start')![1];
      const camera = fixture.cameras[0];
      expect(hook.result.current.isCameraOn).toBe(true);
      await act(async () => { hook.rerender({ ownerId: 'owner-b' }); });
      expect(fixture.tracks[0].stop).toHaveBeenCalled(); expect(camera.getTracks()[0].stop).toHaveBeenCalled();
      expect(hook.result.current.isCameraOn).toBe(false); expect(hook.result.current.state).toBe('idle');
      await act(async () => { client.deliver('avatar:agent:response', { ...start, requestId: 'old', channel: 'voice', finalized: true, text: 'Wrong owner' }); });
      expect(onResponse).not.toHaveBeenCalled();
    } finally { hook.unmount(); }
  });
});
