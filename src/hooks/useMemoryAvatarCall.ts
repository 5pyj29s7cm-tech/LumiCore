import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceCall, type VoiceTranscriptMeta } from './useVoiceCall';
import { releaseSensorStream, requestCameraStream } from '@/services/sensorPermissionService';
import { createMemoryAvatarPortraitConnection } from '../lib/memoryAvatarPortraitConnection';

interface AvatarCallOptions {
  socket: any;
  avatarId: string;
  ownerId?: string;
  voiceId?: string;
  enabled: boolean;
  portrait?: boolean;
  portraitMediaId?: string;
  portraitProvider?: 'did' | 'aliyun';
  onTranscript?: (text: string, isFinal: boolean, meta?: VoiceTranscriptMeta) => void;
  onResponse?: (text: string, meta?: { requestId?: string }) => void;
}

/** Keep the mature audio hook on a separate wire and never forward private perception. */
export function createMemoryAvatarVoiceSocket(socket: any, avatarId: string, lifecycle: {
  prepareStart?: (sessionId: string, signal: AbortSignal) => Promise<void>;
  onStop?: () => void;
} = {}) {
  let sessionId = '';
  let prepared = false;
  let startController: AbortController | undefined;
  let startPending = Promise.resolve();
  const subscriptions = new Map<string, Map<(...args: any[]) => void, (...args: any[]) => void>>();
  const shared = (event: string) => ['connect', 'connect_error', 'disconnect', 'ping', 'pong'].includes(event);
  const wire = (event: string) => shared(event) ? event : `avatar:${event}`;
  const adapter: any = {
    get connected() { return Boolean(socket?.connected); },
    get id() { return socket?.id; },
    get sessionId() { return sessionId; },
    get startPending() { return startPending; },
    connect: () => socket?.connect?.(),
    on(event: string, callback: (...args: any[]) => void) {
      const wrapped = (...args: any[]) => {
        if (!shared(event) && (!sessionId || args[0]?.sessionId !== sessionId || args[0]?.avatarId !== avatarId)) return;
        callback(...args);
      };
      const entries = subscriptions.get(event) || new Map();
      entries.set(callback, wrapped);
      subscriptions.set(event, entries);
      socket?.on(wire(event), wrapped);
      return adapter;
    },
    off(event: string, callback: (...args: any[]) => void) {
      const entries = subscriptions.get(event);
      const wrapped = entries?.get(callback);
      if (wrapped) socket?.off(wire(event), wrapped);
      entries?.delete(callback);
      return adapter;
    },
    once(event: string, callback: (...args: any[]) => void) {
      const once = (...args: any[]) => { adapter.off(event, once); callback(...args); };
      return adapter.on(event, once);
    },
    emit(event: string, data?: any) { return send(event, data, false); },
    volatile: { emit(event: string, data?: any) { return send(event, data, true); } },
  };
  function send(event: string, data: any, volatile: boolean) {
    if (shared(event)) { if (socket?.connected) socket.emit(event, data); return adapter; }
    if (!event.startsWith('audio:')) return adapter;
    if (event === 'audio:stop') {
      startController?.abort(); lifecycle.onStop?.();
      if (sessionId && socket?.connected && prepared) socket.emit(wire(event), { ...data, avatarId, agentId: avatarId, sessionId });
      sessionId = ''; prepared = false;
      return adapter;
    }
    if (event === 'audio:start') {
      startController?.abort();
      sessionId = String(data?.sessionId || '');
      prepared = !lifecycle.prepareStart;
      if (lifecycle.prepareStart && sessionId && socket?.connected) {
        const controller = new AbortController(); startController = controller;
        const startingId = sessionId;
        startPending = lifecycle.prepareStart(startingId, controller.signal).then(() => {
          if (controller.signal.aborted || sessionId !== startingId || !socket?.connected) throw new DOMException('Call cancelled.', 'AbortError');
          prepared = true;
          socket.emit(wire(event), { ...data, avatarId, agentId: avatarId, sessionId, portrait: true });
        });
        void startPending.catch(() => {});
        return adapter;
      }
    }
    if (!sessionId || !socket?.connected) return adapter;
    if (!prepared) return adapter;
    const payload = event === 'audio:chunk'
      ? { chunk: data, avatarId, sessionId }
      : { ...data, avatarId, agentId: avatarId, sessionId };
    if (volatile) socket.volatile.emit(wire(event), payload);
    else socket.emit(wire(event), payload);
    return adapter;
  }
  return adapter;
}

export function useMemoryAvatarCall({ socket, avatarId, ownerId, voiceId, enabled, portrait = false, portraitMediaId, portraitProvider, onTranscript, onResponse }: AvatarCallOptions) {
  const [portraitOutput, setPortraitOutput] = useState<{ scope: string; stream: MediaStream | null } | null>(null);
  const portraitScope = JSON.stringify([ownerId, avatarId, portraitMediaId, portraitProvider]);
  const [portraitSurface, setPortraitSurface] = useState<{ scope: string; surface: HTMLDivElement | null } | null>(null);
  const [portraitPlayback, setPortraitPlayback] = useState<{ scope: string; playing: boolean } | null>(null);
  const portraitSpeaking = portraitPlayback?.scope === portraitScope && portraitPlayback.playing;
  const [portraitError, setPortraitError] = useState(false);
  const endVoiceRef = useRef<() => void>(() => {});
  const portraitConnection = useMemo(() => createMemoryAvatarPortraitConnection({ avatarId, provider: portraitProvider,
    onSurface: surface => setPortraitSurface({ scope: portraitScope, surface }),
    onStream: stream => setPortraitOutput({ scope: portraitScope, stream }),
    onPlayback: playing => setPortraitPlayback({ scope: portraitScope, playing }),
    onFailure: () => { setPortraitError(true); endVoiceRef.current(); },
  }), [avatarId, portraitScope, portraitProvider]);
  const adapter = useMemo(() => createMemoryAvatarVoiceSocket(socket, avatarId, portrait ? {
    prepareStart: portraitConnection.connect, onStop: portraitConnection.close,
  } : {}), [socket, avatarId, portrait, portraitConnection]);
  const voice = useVoiceCall({ socket: adapter, disabled: !enabled, privateCapture: true, onTranscript, onResponse });
  const { endCall, startCall, interrupt: interruptVoice } = voice;
  endVoiceRef.current = voice.endCall;
  const startGeneration = useRef(0);
  const portraitAttempt = useRef(0);
  const currentAdapter = useRef(adapter); currentAdapter.current = adapter;
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [transportErrorCode, setTransportErrorCode] = useState<string | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const cameraGeneration = useRef(0);
  const sequence = useRef(0);
  const stateRef = useRef(voice.callState);
  stateRef.current = voice.callState;

  const stopCamera = useCallback(() => {
    cameraGeneration.current++;
    if (cameraRef.current) releaseSensorStream('camera', cameraRef.current);
    cameraRef.current = null;
    setCameraStream(null);
    adapter.emit('audio:video', { enabled: false });
  }, [adapter]);
  const end = useCallback(() => { startGeneration.current++; portraitAttempt.current++; stopCamera(); endCall(); }, [stopCamera, endCall]);
  const startCamera = useCallback(async () => {
    if (!enabled || cameraRef.current) return;
    const generation = ++cameraGeneration.current;
    setCameraError(null);
    try {
      const stream = await requestCameraStream({ width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' });
      if (generation !== cameraGeneration.current) { releaseSensorStream('camera', stream); return; }
      cameraRef.current = stream;
      setCameraStream(stream);
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', stopCamera, { once: true }));
    } catch {
      if (generation === cameraGeneration.current) setCameraError('Camera access is unavailable. Voice conversation can continue.');
    }
  }, [enabled, stopCamera]);
  const startVoice = useCallback(async () => {
    if (!enabled || !avatarId) return;
    const generation = ++startGeneration.current;
    setCameraError(null);
    setTransportErrorCode(null);
    setPortraitError(false);
    await startCall(voiceId, avatarId, avatarId, { domain: 'personal' });
    try { await adapter.startPending; }
    catch {
      if (generation === startGeneration.current && currentAdapter.current === adapter) { endCall(); setPortraitError(true); }
    }
  }, [enabled, avatarId, voiceId, startCall, endCall, adapter]);
  const startVideo = useCallback(async () => {
    if (!enabled || !avatarId) return;
    // Start audio synchronously with the click to preserve output activation.
    await Promise.all([startVoice(), startCamera()]);
    if (!adapter.sessionId) stopCamera();
  }, [enabled, avatarId, startVoice, startCamera, adapter, stopCamera]);
  const toggleCamera = useCallback(() => {
    if (cameraRef.current) stopCamera();
    else if (stateRef.current !== 'idle') void startCamera();
  }, [startCamera, stopCamera]);

  useEffect(() => {
    const failed = (data: { code?: string }) => setTransportErrorCode(data.code || 'VOICE_INPUT_UNAVAILABLE');
    adapter.on('audio:error', failed);
    adapter.on('audio:tts_error', failed);
    return () => { adapter.off('audio:error', failed); adapter.off('audio:tts_error', failed); };
  }, [adapter]);

  useEffect(() => {
    if (!portrait) return;
    const audio = (data: { audioBase64: string; format: string; requestId: string }) => {
      if (!portraitConnection.usesBrowserAudio) return;
      const attempt = portraitAttempt.current, sessionId = adapter.sessionId;
      void portraitConnection.playAudio(data, data.requestId).catch(() => {
        if (attempt === portraitAttempt.current && currentAdapter.current === adapter && adapter.sessionId === sessionId && sessionId) { setPortraitError(true); endVoiceRef.current(); }
      });
    };
    adapter.on('audio:portrait', audio);
    return () => { adapter.off('audio:portrait', audio); };
  }, [adapter, portrait, portraitConnection]);

  useEffect(() => {
    if (!portrait) return;
    const attemptRef = portraitAttempt;
    const interrupted = () => {
      const sessionId = adapter.sessionId;
      if (!sessionId) return;
      const attempt = ++portraitAttempt.current;
      // D-ID photo streams cannot stop one utterance in place. Replacing the
      // peer cuts old audio immediately and gives the next reply a new stream.
      void portraitConnection.connect(sessionId).catch(() => {
        if (attempt === portraitAttempt.current && currentAdapter.current === adapter && adapter.sessionId === sessionId) { setPortraitError(true); endVoiceRef.current(); }
      });
    };
    adapter.on('audio:interrupt-ack', interrupted);
    return () => { attemptRef.current++; adapter.off('audio:interrupt-ack', interrupted); portraitConnection.close(); };
  }, [adapter, portrait, portraitConnection]);
  const interrupt = useCallback(() => {
    if (portrait && adapter.sessionId) {
      portraitAttempt.current++;
      portraitConnection.close();
      adapter.emit('audio:interrupt', { source: 'user_control' });
    } else interruptVoice();
  }, [adapter, portrait, portraitConnection, interruptVoice]);

  useEffect(() => {
    if (!cameraStream) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = cameraStream;
    void video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const capture = () => {
      if (!adapter.connected || !adapter.sessionId || !video.videoWidth || video.readyState < 2) return;
      const ratio = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
      canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
      const context = canvas.getContext('2d');
      if (!context) return;
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        if (dataUrl.length > 350_000) return;
        adapter.volatile.emit('audio:video', { enabled: true, frame: dataUrl, sequence: ++sequence.current });
      } catch { /* A stopped or not-yet-ready video track cannot supply a frame. */ }
    };
    video.addEventListener('loadeddata', capture);
    const timer = setInterval(capture, 1000);
    return () => { clearInterval(timer); video.removeEventListener('loadeddata', capture); video.pause(); video.srcObject = null; };
  }, [adapter, cameraStream]);

  useEffect(() => {
    if (!enabled) end();
    return end;
  }, [enabled, avatarId, ownerId, end]);
  const previousState = useRef(voice.callState);
  useEffect(() => {
    if (voice.callState === 'idle' && (voice.error || previousState.current !== 'idle')) stopCamera();
    previousState.current = voice.callState;
  }, [voice.callState, voice.error, stopCamera]);

  return {
    state: portraitSpeaking && voice.callState !== 'idle' ? 'speaking' as const : voice.callState,
    error: portraitError ? 'Portrait connection unavailable.' : cameraError || voice.error,
    errorCode: portraitError ? 'PORTRAIT_UNAVAILABLE' : cameraError ? 'CAMERA_UNAVAILABLE' : voice.error ? transportErrorCode || 'VOICE_INPUT_UNAVAILABLE' : null,
    startVoice, startVideo, end, toggleCamera, toggleMute: voice.toggleMute,
    interrupt, portraitStream: portraitOutput?.scope === portraitScope ? portraitOutput.stream : null,
    portraitSurface: portraitSurface?.scope === portraitScope ? portraitSurface.surface : null,
    portraitSpeaking: Boolean(portraitSpeaking),
    cameraStream, isCameraOn: Boolean(cameraStream),
    isMuted: voice.isMuted, outputLevelRef: voice.outputLevelRef, inputLevelRef: voice.inputLevelRef,
    transcript: voice.transcript, responseText: voice.responseText, elapsedSeconds: voice.elapsedSeconds,
  };
}
