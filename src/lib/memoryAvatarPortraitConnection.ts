import { memoryAvatarPortraitService as service } from '../services/memoryAvatarPortraitService';
import { createAliyunAvatarConnection } from './aliyunAvatarConnection';

export interface PortraitConnectionOptions {
  avatarId: string;
  provider?: 'did' | 'aliyun';
  onSurface?: (surface: HTMLDivElement | null) => void;
  onStream: (stream: MediaStream | null) => void;
  onPlayback?: (playing: boolean) => void;
  onFailure: () => void;
}

/** One owner/person instance, one peer. No automatic retry of a billed create/speak. */
export function createMemoryAvatarPortraitConnection(options: PortraitConnectionOptions) {
  if (options.provider === 'aliyun') return createAliyunAvatarConnection(options);
  let cleanup = Promise.resolve();
  let current: {
    controller: AbortController; peer?: RTCPeerConnection; sessionId: string;
    requestId: string; remoteId?: string; stream?: MediaStream; channel?: RTCDataChannel;
  } | undefined;
  const close = () => {
    const call = current;
    if (!call) return;
    current = undefined;
    call.controller.abort();
    if (call.channel) {
      call.channel.onmessage = null; call.channel.onclose = null; call.channel.onerror = null;
      call.channel.close();
    }
    if (call.peer) {
      call.peer.ontrack = null; call.peer.onicecandidate = null; call.peer.onconnectionstatechange = null;
      call.peer.close();
    }
    call.stream?.getTracks().forEach(track => track.stop());
    options.onStream(null);
    options.onPlayback?.(false);
    // Cancelling by request also covers an accepted create with a lost HTTP response.
    cleanup = service.cancel(options.avatarId, call.sessionId, call.requestId).then(() => {});
    void cleanup.catch(() => {});
  };
  const connect = async (sessionId: string, signal?: AbortSignal) => {
    close();
    if (signal?.aborted) throw new DOMException('Call cancelled.', 'AbortError');
    const call = { controller: new AbortController(), sessionId, requestId: crypto.randomUUID() } as NonNullable<typeof current>;
    current = call;
    const valid = () => current === call && !call.controller.signal.aborted;
    const abort = () => { if (current === call) close(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 45_000);
    try {
      const offer = await service.create(options.avatarId, sessionId, call.requestId, call.controller.signal);
      call.remoteId = offer.portraitSessionId;
      if (!valid()) throw new DOMException('Call cancelled.', 'AbortError');
      if (offer.callSessionId !== sessionId || !offer.portraitSessionId || offer.offer?.type !== 'offer' || typeof offer.offer.sdp !== 'string' || !Array.isArray(offer.iceServers)) throw new Error('Invalid portrait offer');
      const peer = new RTCPeerConnection({ iceServers: offer.iceServers });
      call.peer = peer;
      const stream = new MediaStream(); call.stream = stream;
      let connected!: () => void;
      let failed!: (error: Error) => void;
      let hasTrack = false;
      let rendererReady = false;
      const ready = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject; });
      // A failed ICE callback may arrive before SDP negotiation finishes.
      void ready.catch(() => {});
      const fail = () => {
        if (!valid()) return;
        failed(new Error('Portrait connection failed'));
        close(); options.onFailure();
      };
      const check = () => { if (valid() && hasTrack && rendererReady && peer.connectionState === 'connected') connected(); };
      const channel = peer.createDataChannel('JanusDataChannel'); call.channel = channel;
      channel.onmessage = event => {
        if (!valid() || typeof event.data !== 'string' || event.data.length > 8192) return;
        const eventName = event.data.split(':')[0];
        if (eventName === 'stream/ready') { rendererReady = true; check(); }
        else if (eventName === 'stream/started' && rendererReady) options.onPlayback?.(true);
        else if (eventName === 'stream/done') options.onPlayback?.(false);
        else if (eventName === 'stream/error') fail();
      };
      channel.onclose = fail; channel.onerror = fail;
      call.controller.signal.addEventListener('abort', () => failed(new DOMException('Call cancelled.', 'AbortError')), { once: true });
      peer.ontrack = event => {
        if (!valid()) { event.track.stop(); return; }
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
        hasTrack = stream.getVideoTracks().length > 0;
        options.onStream(stream);
        event.track.addEventListener('ended', fail, { once: true });
        check();
      };
      let candidateTail = Promise.resolve();
      peer.onicecandidate = event => {
        if (!valid()) return;
        const candidate = event.candidate?.toJSON() || null;
        candidateTail = candidateTail.then(async () => {
          if (valid()) await service.ice(options.avatarId, offer.portraitSessionId, sessionId, candidate, call.controller.signal);
        }).catch(fail);
      };
      peer.onconnectionstatechange = () => {
        if (!valid()) return;
        if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) fail();
        else check();
      };
      await peer.setRemoteDescription(offer.offer);
      if (!valid()) throw new DOMException('Call cancelled.', 'AbortError');
      const answer = await peer.createAnswer();
      if (!valid()) throw new DOMException('Call cancelled.', 'AbortError');
      await peer.setLocalDescription(answer);
      await service.answer(options.avatarId, offer.portraitSessionId, sessionId, { type: 'answer', sdp: answer.sdp }, call.controller.signal);
      await ready;
      if (!valid()) throw new DOMException('Call cancelled.', 'AbortError');
    } catch (error) {
      if (current === call) close();
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  // Long-running live previews must confirm cleanup before renewing a billed renderer.
  const closeAndWait = () => { close(); return cleanup; };
  return { connect, close, closeAndWait, usesBrowserAudio: false,
    playAudio: async (_reply: { audioBase64: string; format: string }, _requestId: string, _signal?: AbortSignal) => { throw new Error('D-ID audio is sent by the server'); } };
}
