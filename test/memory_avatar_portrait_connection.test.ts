// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ create: vi.fn(), answer: vi.fn(), ice: vi.fn(), cancel: vi.fn() }));
vi.mock('../src/services/memoryAvatarPortraitService', () => ({ memoryAvatarPortraitService: fixture }));
import { createMemoryAvatarPortraitConnection } from '../src/lib/memoryAvatarPortraitConnection';

class Stream {
  tracks: any[] = [];
  addTrack(track: any) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}
class Peer {
  static peers: Peer[] = [];
  connectionState = 'new'; ontrack: any; onicecandidate: any; onconnectionstatechange: any;
  close = vi.fn(() => { this.connectionState = 'closed'; });
  setRemoteDescription = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'fixture-answer' }));
  setLocalDescription = vi.fn(async () => {});
  channel = { onmessage: null as any, onclose: null as any, onerror: null as any, close: vi.fn() };
  createDataChannel = vi.fn(() => this.channel);
  constructor(public config: any) { Peer.peers.push(this); }
  ready() {
    const track = { kind: 'video', stop: vi.fn(), addEventListener: vi.fn() };
    this.ontrack?.({ track }); this.connectionState = 'connected'; this.onconnectionstatechange?.();
    this.channel.onmessage?.({ data: 'stream/ready' });
    return track;
  }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const offer = (callSessionId = 'call') => ({ portraitSessionId: 'local-stream', callSessionId, offer: { type: 'offer', sdp: 'fixture-offer' }, iceServers: [] });
beforeEach(() => {
  Peer.peers = [];
  fixture.create.mockReset().mockResolvedValue(offer()); fixture.answer.mockReset().mockResolvedValue({ ok: true });
  fixture.ice.mockReset().mockResolvedValue({ ok: true }); fixture.cancel.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('MediaStream', Stream);
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('private portrait WebRTC lifecycle', () => {
  it('waits for SDP, a video track and a connected peer, then releases all resources', async () => {
    const stream = vi.fn(); const failed = vi.fn();
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream: stream, onFailure: failed });
    let ready = false;
    const pending = connection.connect('call').then(() => { ready = true; });
    await vi.waitFor(() => expect(fixture.answer).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    const track = Peer.peers[0].ready(); await pending;
    expect(fixture.answer).toHaveBeenCalledWith('person', 'local-stream', 'call', { type: 'answer', sdp: 'fixture-answer' }, expect.any(AbortSignal));
    expect(ready).toBe(true); connection.close();
    expect(track.stop).toHaveBeenCalledOnce(); expect(Peer.peers[0].close).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenLastCalledWith(null); expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });
  it('cancels a create by its request ID even when no HTTP receipt was returned', async () => {
    const gate = deferred<any>(); fixture.create.mockReturnValueOnce(gate.promise);
    const onStream = vi.fn();
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream, onFailure: vi.fn() });
    const pending = connection.connect('call'); const assertion = expect(pending).rejects.toThrow();
    connection.close(); gate.resolve(offer()); await assertion;
    expect(fixture.cancel).toHaveBeenCalledWith('person', 'call', fixture.create.mock.calls[0][2]);
    expect(Peer.peers).toHaveLength(0); expect(onStream).toHaveBeenCalledOnce();
  });
  it('rejects a cross-call offer before opening a peer', async () => {
    fixture.create.mockResolvedValueOnce(offer('another-call'));
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream: vi.fn(), onFailure: vi.fn() });
    await expect(connection.connect('call')).rejects.toThrow('Invalid portrait offer');
    expect(Peer.peers).toHaveLength(0); expect(fixture.cancel).toHaveBeenCalledOnce();
  });
  it('does not replay creation after an unknown network outcome', async () => {
    fixture.create.mockRejectedValueOnce(new TypeError('Network failure'));
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream: vi.fn(), onFailure: vi.fn() });
    await expect(connection.connect('call')).rejects.toThrow('Network failure');
    expect(fixture.create).toHaveBeenCalledOnce(); expect(fixture.cancel).toHaveBeenCalledOnce();
  });
  it('does not infer renderer readiness from an ICE connection or a timer and hides the warmup', async () => {
    const onStream = vi.fn();
    const onPlayback = vi.fn();
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream, onPlayback, onFailure: vi.fn() });
    let ready = false; const pending = connection.connect('call').then(() => { ready = true; });
    await vi.waitFor(() => expect(Peer.peers).toHaveLength(1));
    const peer = Peer.peers[0];
    peer.ontrack({ track: { kind: 'video', stop: vi.fn(), addEventListener: vi.fn() } });
    peer.connectionState = 'connected'; peer.onconnectionstatechange();
    await Promise.resolve(); expect(ready).toBe(false); expect(onPlayback).not.toHaveBeenCalled();
    peer.channel.onmessage({ data: 'stream/ready' }); await pending;
    expect(peer.createDataChannel).toHaveBeenCalledWith('JanusDataChannel');
    peer.channel.onmessage({ data: 'stream/started:fixture' }); expect(onPlayback).toHaveBeenLastCalledWith(true);
    peer.channel.onmessage({ data: 'stream/done:fixture' }); expect(onPlayback).toHaveBeenLastCalledWith(false);
    expect(onStream.mock.calls.at(-1)?.[0]).toBeInstanceOf(Stream); // Do not truncate buffered audio at the done message.
    connection.close(); expect(peer.channel.close).toHaveBeenCalledOnce();
  });
  it('cuts old tracks before replacing a stream and ignores late old-peer callbacks', async () => {
    const onStream = vi.fn();
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream, onFailure: vi.fn() });
    const first = connection.connect('call'); await vi.waitFor(() => expect(Peer.peers).toHaveLength(1));
    const oldPeer = Peer.peers[0]; const oldCallback = oldPeer.ontrack; const oldTrack = oldPeer.ready(); await first;
    const second = connection.connect('call'); await vi.waitFor(() => expect(Peer.peers).toHaveLength(2));
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    const staleTrack = { kind: 'video', stop: vi.fn() }; oldCallback({ track: staleTrack });
    expect(staleTrack.stop).toHaveBeenCalledOnce();
    Peer.peers[1].ready(); await second;
    expect(fixture.create.mock.calls[0][2]).not.toBe(fixture.create.mock.calls[1][2]); connection.close();
  });
  it('fails a disconnected peer without silently creating another billed stream', async () => {
    const onFailure = vi.fn();
    const connection = createMemoryAvatarPortraitConnection({ avatarId: 'person', onStream: vi.fn(), onFailure });
    const pending = connection.connect('call'); await vi.waitFor(() => expect(Peer.peers).toHaveLength(1));
    const track = Peer.peers[0].ready(); await pending;
    Peer.peers[0].connectionState = 'disconnected'; Peer.peers[0].onconnectionstatechange();
    expect(track.stop).toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledOnce(); expect(fixture.create).toHaveBeenCalledOnce();
  });
});
