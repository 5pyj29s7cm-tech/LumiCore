// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
const fixture = vi.hoisted(() => ({ tracks: [] as any[], sources: [] as any[], processors: [] as any[], cameras: [] as any[], portraits: [] as any[], decode: vi.fn(), client: null as any }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: 'fixture-owner' } }) }));
vi.mock('../src/lib/useT', () => ({ useLocale: () => 'en' }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => fixture.client }));
vi.mock('../src/hooks/useMemoryAvatarConversation', () => ({ useMemoryAvatarConversation: () => ({ messages: [], busy: false, loading: false, error: '', send: vi.fn(), refresh: vi.fn(), interrupt: vi.fn() }) }));
vi.mock('../src/components/MemoryAvatarStage', () => ({ MemoryAvatarStage: () => <div /> }));
vi.mock('../src/components/MemoryAvatarProfile', () => ({ MemoryAvatarProfile: () => <div /> }));
vi.mock('../src/components/MemoryAvatarPortraitStage', () => ({ MemoryAvatarPortraitStage: () => <div /> }));
vi.mock('../src/lib/memoryAvatarPortraitConnection', () => ({ createMemoryAvatarPortraitConnection: (options: any) => {
  const connection = { connect: vi.fn(async () => {}), close: vi.fn(), options };
  fixture.portraits.push(connection); return connection;
} }));
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
import { Sanctuary } from '../src/components/Sanctuary';
import { memoryTerritoryCopy } from '../src/i18n/locales/memoryTerritory';

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
  decodeAudioData() { return fixture.decode(); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
beforeEach(() => {
  fixture.tracks = []; fixture.sources = []; fixture.processors = []; fixture.cameras = []; fixture.portraits = [];
  fixture.decode.mockReset().mockResolvedValue({ duration: 2 });
  vi.stubGlobal('AudioContext', AudioContextFixture);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('voice playback lifetime and interruption', () => {
  it('keeps memory voice interruption available after the backend returns to listening', async () => {
    const client = new Client();
    const hook = renderHook(() => useMemoryAvatarCall({ socket: client, avatarId: 'audit-person', ownerId: 'audit-owner', enabled: true }));
    try {
      await act(async () => { await hook.result.current.startVoice(); });
      const start = client.outputs.find(([event]) => event === 'avatar:audio:start')![1];
      const envelope = { ...start, requestId: 'audit-reply', lane: 'conversation' };
      // This order is emitted by runTurn: speaking, response, finally/listening.
      await act(async () => {
        client.deliver('avatar:audio:status', { ...envelope, status: 'thinking' });
        client.deliver('avatar:audio:status', { ...envelope, status: 'speaking' });
        client.deliver('avatar:audio:response', { ...envelope, buffer: new Uint8Array([1, 2]).buffer, format: 'wav' });
        client.deliver('avatar:audio:status', { ...envelope, status: 'listening' });
      });
      const source = fixture.sources.at(-1);
      expect(source.start).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(hook.result.current.outputLevelRef.current).toBeCloseTo(0.25));
      expect(hook.result.current.state).toBe('speaking');
      const before = client.outputs.length;
      await act(async () => { hook.result.current.interrupt(); });
      expect(client.outputs.slice(before)).toContainEqual(['avatar:audio:interrupt', expect.objectContaining({ sessionId: start.sessionId, requestId: 'audit-reply' })]);
      expect(source.stop).toHaveBeenCalledOnce();
      expect(hook.result.current.outputLevelRef.current).toBe(0);
      await act(async () => { hook.result.current.end(); });
      expect(source.stop).toHaveBeenCalledOnce();
    } finally { hook.unmount(); }
  });

  it('control: before the server listening event, the same interrupt stops output', async () => {
    const client = new Client();
    const hook = renderHook(() => useMemoryAvatarCall({ socket: client, avatarId: 'audit-person', ownerId: 'audit-owner', enabled: true }));
    try {
      await act(async () => { await hook.result.current.startVoice(); });
      const start = client.outputs.find(([event]) => event === 'avatar:audio:start')![1];
      const envelope = { ...start, requestId: 'audit-reply', lane: 'conversation' };
      await act(async () => {
        client.deliver('avatar:audio:status', { ...envelope, status: 'speaking' });
        client.deliver('avatar:audio:response', { ...envelope, buffer: new Uint8Array([1, 2]).buffer, format: 'wav' });
      });
      const source = fixture.sources.at(-1);
      expect(source.start).toHaveBeenCalledOnce();
      await act(async () => { hook.result.current.interrupt(); });
      expect(client.outputs.some(([event]) => event === 'avatar:audio:interrupt')).toBe(true);
      expect(source.stop).toHaveBeenCalledOnce();
    } finally { hook.unmount(); }
  });

  it('keeps the real Sanctuary stop button visible through the terminal sequence', async () => {
    const client = fixture.client = new Client();
    const copy = memoryTerritoryCopy('en');
    render(<Sanctuary agent={{ id: 'fixture-person', name: 'Synthetic person' }} lang="en" isOpen onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.voiceCall })); });
    const start = client.outputs.find(([event]) => event === 'avatar:audio:start')![1];
    const envelope = { ...start, requestId: 'visible-reply', lane: 'conversation' };
    await act(async () => {
      client.deliver('avatar:audio:status', { ...envelope, status: 'speaking' });
      client.deliver('avatar:audio:response', { ...envelope, buffer: new Uint8Array([1, 2]).buffer, format: 'wav' });
      client.deliver('avatar:audio:status', { ...envelope, status: 'listening' });
    });
    const source = fixture.sources.at(-1);
    fireEvent.click(screen.getByRole('button', { name: copy.interrupt }));
    expect(source.stop).toHaveBeenCalledOnce();
    expect(client.outputs).toContainEqual(['avatar:audio:interrupt', expect.objectContaining({ requestId: 'visible-reply' })]);
    await act(async () => { client.deliver('avatar:audio:interrupt-ack', { ...envelope, workContinues: false }); });
    expect(screen.queryByRole('button', { name: copy.interrupt })).toBeNull();
  });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function mainCall() {
  const client = new Client();
  const hook = renderHook(() => useVoiceCall({ socket: client }));
  await act(async () => { await hook.result.current.startCall(); });
  const start = client.outputs.find(([event]) => event === 'audio:start')![1];
  const packet = (requestId: string) => ({ sessionId: start.sessionId, requestId, lane: 'conversation', buffer: new Uint8Array([1, 2]).buffer, format: 'wav' });
  return { client, hook, start, packet };
}

describe('main voice decode, queue and request ownership', () => {
  it('naturally drains every queued chunk before returning to listening', async () => {
    const { client, hook, packet } = await mainCall();
    await act(async () => {
      client.deliver('audio:status', { ...packet('a'), status: 'speaking' });
      client.deliver('audio:response', packet('a'));
      client.deliver('audio:response', packet('a'));
      client.deliver('audio:status', { ...packet('a'), status: 'listening' });
    });
    expect(hook.result.current.callState).toBe('speaking');
    expect(fixture.decode).toHaveBeenCalledTimes(1);
    await act(async () => { fixture.sources[0].onended(); });
    expect(hook.result.current.callState).toBe('speaking');
    expect(fixture.decode).toHaveBeenCalledTimes(2);
    await act(async () => { fixture.sources[1].onended(); });
    expect(hook.result.current.callState).toBe('listening');
    expect(hook.result.current.outputLevelRef.current).toBe(0);
  });

  it('preserves a newer thinking request when the older audio finishes', async () => {
    const { client, hook, packet } = await mainCall();
    await act(async () => {
      client.deliver('audio:response', packet('a'));
      client.deliver('audio:status', { ...packet('a'), status: 'listening' });
      client.deliver('audio:status', { ...packet('b'), status: 'thinking' });
    });
    expect(hook.result.current.callState).toBe('speaking');
    await act(async () => { fixture.sources[0].onended(); });
    expect(hook.result.current.callState).toBe('thinking');
    act(() => hook.result.current.interrupt());
    expect(client.outputs.at(-1)).toEqual(['audio:interrupt', expect.objectContaining({ requestId: 'b' })]);
  });

  it('can cancel a queued request before React publishes the queued state', async () => {
    const { client, hook, packet } = await mainCall();
    await act(async () => {
      client.deliver('audio:status', { ...packet('a'), status: 'queued' });
      hook.result.current.interrupt();
    });
    expect(client.outputs.at(-1)).toEqual(['audio:interrupt', expect.objectContaining({ requestId: 'a' })]);
    await act(async () => { client.deliver('audio:response', packet('a')); });
    expect(fixture.decode).not.toHaveBeenCalled();
  });

  it.each([true, false])('cancels decoding/queue and ignores an old acknowledgement after newer playback (request tagged: %s)', async tagged => {
    const decode = deferred<{ duration: number }>(); fixture.decode.mockReturnValueOnce(decode.promise);
    const { client, hook, packet } = await mainCall();
    await act(async () => {
      client.deliver('audio:response', packet('a'));
      client.deliver('audio:response', packet('a'));
      client.deliver('audio:status', { ...packet('a'), status: 'listening' });
      hook.result.current.interrupt();
    });
    await act(async () => { decode.resolve({ duration: 2 }); client.deliver('audio:response', packet('a')); });
    expect(fixture.sources).toHaveLength(0); expect(fixture.decode).toHaveBeenCalledOnce();
    await act(async () => {
      client.deliver('audio:status', { ...packet('b'), status: 'thinking' });
      client.deliver('audio:response', packet('b'));
      client.deliver('audio:status', { ...packet('b'), status: 'listening' });
    });
    await act(async () => { client.deliver('audio:interrupt-ack', { sessionId: packet('a').sessionId, requestId: tagged ? 'a' : undefined, workContinues: false }); });
    expect(fixture.sources[0].start).toHaveBeenCalledOnce(); expect(fixture.sources[0].stop).not.toHaveBeenCalled();
    expect(hook.result.current.callState).toBe('speaking');
  });

  it.each(['end', 'reconnect'] as const)('invalidates old decoding across %s and permits fresh audio', async action => {
    const decode = deferred<{ duration: number }>(); fixture.decode.mockReturnValueOnce(decode.promise);
    const { client, hook, packet } = await mainCall();
    await act(async () => { client.deliver('audio:response', packet('a')); });
    await act(async () => {
      if (action === 'end') { hook.result.current.endCall(); await hook.result.current.startCall(); }
      else { client.deliver('disconnect'); client.deliver('connect'); }
      decode.resolve({ duration: 2 });
    });
    expect(fixture.sources).toHaveLength(0);
    expect(hook.result.current.callState).toBe('connecting');
    const nextStart = client.outputs.filter(([event]) => event === 'audio:start').at(-1)![1];
    await act(async () => {
      client.deliver('audio:response', packet('a'));
      // Main voice also supports metadata packets from older emitters without
      // a sessionId. A known interrupted request must not be re-adopted.
      client.deliver('audio:response', { ...packet('a'), sessionId: undefined });
      client.deliver('audio:status', { sessionId: nextStart.sessionId, requestId: 'b', status: 'thinking' });
      client.deliver('audio:response', { ...packet('b'), sessionId: nextStart.sessionId });
      client.deliver('audio:status', { sessionId: nextStart.sessionId, requestId: 'b', status: 'listening' });
    });
    expect(fixture.sources).toHaveLength(1); expect(hook.result.current.callState).toBe('speaking');
  });

  it('stops speech while work continues and accepts the same task subsequent output', async () => {
    const { client, hook, packet } = await mainCall();
    await act(async () => {
      client.deliver('audio:status', { ...packet('work-a'), status: 'thinking' });
      client.deliver('audio:work_progress', { requestId: 'work-a', active: true, text: 'Still executing synthetic work' });
      client.deliver('audio:response', packet('work-a'));
    });
    act(() => hook.result.current.interrupt());
    await act(async () => { client.deliver('audio:interrupt-ack', { ...packet('work-a'), workContinues: true }); });
    expect(hook.result.current.callState).toBe('listening');
    await act(async () => { client.deliver('audio:response', packet('work-a')); });
    expect(fixture.sources).toHaveLength(2); expect(fixture.sources[0].stop).toHaveBeenCalledOnce();
    expect(fixture.sources[1].start).toHaveBeenCalledOnce(); expect(hook.result.current.callState).toBe('speaking');
  });

  it('reports failed decoding without ending the microphone or keeping a phantom playback state', async () => {
    fixture.decode.mockRejectedValueOnce(new Error('Synthetic decode failure'));
    const { client, hook, packet } = await mainCall();
    await act(async () => {
      client.deliver('audio:response', packet('a'));
      client.deliver('audio:status', { ...packet('a'), status: 'listening' });
    });
    expect(hook.result.current.callState).toBe('listening');
    expect(hook.result.current.error).toContain('text reply is still available');
    expect(fixture.tracks[0].stop).not.toHaveBeenCalled();
  });
});
