import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceCall, type VoiceTranscriptMeta } from './useVoiceCall';
import { releaseSensorStream, requestCameraStream } from '@/services/sensorPermissionService';

interface AvatarCallOptions {
  socket: any;
  avatarId: string;
  ownerId?: string;
  voiceId?: string;
  enabled: boolean;
  onTranscript?: (text: string, isFinal: boolean, meta?: VoiceTranscriptMeta) => void;
  onResponse?: (text: string, meta?: { requestId?: string }) => void;
}

/** Keep the mature audio hook on a separate wire and never forward private perception. */
export function createMemoryAvatarVoiceSocket(socket: any, avatarId: string) {
  let sessionId = '';
  const subscriptions = new Map<string, Map<(...args: any[]) => void, (...args: any[]) => void>>();
  const shared = (event: string) => ['connect', 'connect_error', 'disconnect', 'ping', 'pong'].includes(event);
  const wire = (event: string) => shared(event) ? event : `avatar:${event}`;
  const adapter: any = {
    get connected() { return Boolean(socket?.connected); },
    get id() { return socket?.id; },
    get sessionId() { return sessionId; },
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
    if (event === 'audio:start') sessionId = String(data?.sessionId || '');
    if (!sessionId || !socket?.connected) return adapter;
    const payload = event === 'audio:chunk'
      ? { chunk: data, avatarId, sessionId }
      : { ...data, avatarId, agentId: avatarId, sessionId };
    if (volatile) socket.volatile.emit(wire(event), payload);
    else socket.emit(wire(event), payload);
    if (event === 'audio:stop') sessionId = '';
    return adapter;
  }
  return adapter;
}

export function useMemoryAvatarCall({ socket, avatarId, ownerId, voiceId, enabled, onTranscript, onResponse }: AvatarCallOptions) {
  const adapter = useMemo(() => createMemoryAvatarVoiceSocket(socket, avatarId), [socket, avatarId, ownerId]);
  const voice = useVoiceCall({ socket: adapter, disabled: !enabled, privateCapture: true, onTranscript, onResponse });
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
  const end = useCallback(() => { stopCamera(); voice.endCall(); }, [stopCamera, voice.endCall]);
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
    setCameraError(null);
    setTransportErrorCode(null);
    await voice.startCall(voiceId, avatarId, avatarId, { domain: 'personal' });
  }, [enabled, avatarId, voiceId, voice.startCall]);
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
    state: voice.callState, error: cameraError || voice.error,
    errorCode: cameraError ? 'CAMERA_UNAVAILABLE' : voice.error ? transportErrorCode || 'VOICE_INPUT_UNAVAILABLE' : null,
    startVoice, startVideo, end, toggleCamera, toggleMute: voice.toggleMute,
    interrupt: voice.interrupt, cameraStream, isCameraOn: Boolean(cameraStream),
    isMuted: voice.isMuted, outputLevelRef: voice.outputLevelRef, inputLevelRef: voice.inputLevelRef,
    transcript: voice.transcript, responseText: voice.responseText, elapsedSeconds: voice.elapsedSeconds,
  };
}
