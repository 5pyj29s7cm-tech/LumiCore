import { aliyunAvatarService as service } from '../services/aliyunAvatarService';
import type { PortraitConnectionOptions } from './memoryAvatarPortraitConnection';
import { liveAudioEncoding } from '../../shared/avatar_live';
type Sdk = Awaited<ReturnType<typeof import('lm-avatar-chat-sdk/cloud')['createCloudAvatar']>>;

export function floatToPortraitPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); pcm[i] = Math.round(value < 0 ? value * 32768 : value * 32767); }
  return pcm;
}

/** Audio-only SDK: no microphone capture, no Aliyun dialogue model, no automatic paid retries. */
export function createAliyunAvatarConnection(options: PortraitConnectionOptions) {
  let cleanup = Promise.resolve();
  let generation = 0;
  let current: { sessionId: string; requestId: string; controller: AbortController; sdk?: Sdk; host?: HTMLDivElement; heartbeat?: ReturnType<typeof setInterval>;
    ready: boolean; played: Set<string>; playing: boolean; processing?: boolean; rejectSpeech?: (error: Error) => void; speechState?: (state: string) => void } | undefined;
  const close = () => {
    generation++;
    const call = current; if (!call) return; current = undefined;
    clearInterval(call.heartbeat);
    call.controller.abort(); call.rejectSpeech?.(new DOMException('Stopped', 'AbortError'));
    try { call.sdk?.exit(); } catch { /* Exact server cleanup still runs. */ }
    call.host?.remove(); options.onSurface?.(null); options.onStream(null); options.onPlayback?.(false);
    cleanup = service.cancel(options.avatarId, call.sessionId, call.requestId).then(() => {}); void cleanup.catch(() => {});
  };
  const connect = async (sessionId: string, signal?: AbortSignal) => {
    close(); const attempt = generation; await cleanup; signal?.throwIfAborted();
    if (attempt !== generation) throw new DOMException('Stopped', 'AbortError');
    const call: NonNullable<typeof current> = { sessionId, requestId: crypto.randomUUID(), controller: new AbortController(), ready: false, played: new Set(), playing: false };
    current = call; const valid = () => current === call && !call.controller.signal.aborted;
    const abort = () => { if (current === call) close(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 45_000);
    try {
      // Load before creating a paid cloud session, and only when this provider is selected.
      const sdk = await import('lm-avatar-chat-sdk/cloud'); call.controller.signal.throwIfAborted();
      const offer = await service.create(options.avatarId, sessionId, call.requestId, call.controller.signal);
      if (!valid() || offer.callSessionId !== sessionId) throw new Error('aliyun_session_mismatch');
      const host = document.createElement('div'), video = document.createElement('video'); call.host = host;
      host.style.cssText = 'width:100%;height:100%;position:relative;';
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;'; video.playsInline = true;
      host.append(video); options.onSurface?.(host);
      let ready = false, frame = false;
      await new Promise<void>((resolve, reject) => {
        const failed = () => { if (valid()) { reject(new Error('aliyun_renderer_failed')); close(); options.onFailure(); } };
        const check = () => { if (valid() && ready && frame) resolve(); };
        call.controller.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
        const avatar = sdk.createCloudAvatar({ ...offer.rtc, sessionId: offer.sessionId, rootContainer: video, ignoreAudioInput: true }); call.sdk = avatar;
        avatar.onErrorReceived(failed);
        avatar.onFirstFrameReceived(() => { frame = true; check(); });
        avatar.onReadyToSpeech(() => { ready = true; check(); });
        avatar.onStateChanged(state => {
          if (!valid()) return;
          const speaking = state === sdk.TYVoiceChatState.Responding;
          call.playing = speaking; options.onPlayback?.(speaking);
          call.speechState?.(state);
        });
        void Promise.resolve(avatar.start({ mode: sdk.TYVoiceChatMode.tap2talk, outboundSampleRate: 24000, keepAlive: true })).catch(failed);
      });
      call.controller.signal.throwIfAborted();
      await service.ready(options.avatarId, sessionId, offer.portraitSessionId, call.controller.signal); call.ready = true;
      call.heartbeat = setInterval(() => {
        void service.heartbeat(options.avatarId, sessionId, offer.portraitSessionId).catch(() => { if (valid()) { close(); options.onFailure(); } });
      }, 30_000);
    } catch (error) { if (current === call) close(); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const playAudio = async (reply: { audioBase64: string; format: string }, requestId: string, signal?: AbortSignal) => {
    const call = current;
    if (!call?.ready || call.playing || call.processing || call.rejectSpeech || call.played.has(requestId) || !liveAudioEncoding(reply.format)
      || !reply.audioBase64 || reply.audioBase64.length > 8_000_000) throw new Error('aliyun_speech_unavailable');
    signal?.throwIfAborted(); call.played.add(requestId);
    call.processing = true;
    try {
    const audio = new OfflineAudioContext(1, 1, 24000);
    const decoded = await audio.decodeAudioData(Uint8Array.from(atob(reply.audioBase64), char => char.charCodeAt(0)).buffer);
    if (current !== call || call.controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    signal?.throwIfAborted();
    if (decoded.duration > 90 || decoded.duration <= 0) throw new Error('aliyun_audio_too_long');
    const renderer = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000);
    const source = renderer.createBufferSource(); source.buffer = decoded; source.connect(renderer.destination); source.start();
    const mono = await renderer.startRendering();
    if (current !== call || call.controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    signal?.throwIfAborted();
    // Completion is observed from the provider's state, never inferred from accepting bytes.
    await new Promise<void>((resolve, reject) => {
      let started = false;
      const abort = () => { close(); reject(new DOMException('Stopped', 'AbortError')); };
      const timeout = setTimeout(abort, Math.min(120_000, decoded.duration * 1000 + 30_000));
      const clear = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); call.rejectSpeech = undefined; call.speechState = undefined; };
      call.rejectSpeech = error => { clear(); reject(error); };
      signal?.addEventListener('abort', abort, { once: true });
      call.speechState = state => {
        if (current !== call) return;
        if (state === 'Responding') { started = true; call.playing = true; options.onPlayback?.(true); }
        else if (started && (state === 'StandBy' || state === 'Listening' || state === 'Idle')) {
          call.playing = false; options.onPlayback?.(false); clear(); resolve();
        }
      };
      try { call.sdk!.pushAudioData(floatToPortraitPcm(mono.getChannelData(0)), true); }
      catch { abort(); }
    });
    } finally { call.processing = false; }
  };
  return { connect, close, closeAndWait: () => { close(); return cleanup; }, playAudio, usesBrowserAudio: true };
}
