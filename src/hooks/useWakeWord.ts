import { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { apiFetch } from '@/services/apiClient';
import { releaseSensorStream, requestMicrophoneStream } from '@/services/sensorPermissionService';
import { translate } from '@/i18n/runtime';
import { closeAudioContext } from '@/lib/audioContextLifecycle';
import { VOICE_PROVIDER_CHANGED_EVENT } from '@/services/voiceService';

interface UseWakeWordOptions {
  /** Socket.IO connection for the selected server-side STT wake detector. */
  socket?: Socket | null;
  /** Porcupine access key (free at https://picovoice.ai) — optional, server-side Qwen ASR is the default */
  accessKey?: string;
  /** Keyword to detect. Default 'Jarvis' */
  keyword?: string;
  /** Ref to the startCall function from useVoiceCall */
  startCallRef: React.MutableRefObject<((voiceId?: string, personalityId?: string, agentId?: string, options?: { transcriptionOnly?: boolean; domain?: 'personal' | 'work'; orgId?: string }) => Promise<void>)>;
  /** Enable/disable wake word */
  enabled?: boolean;
  /** Sensitivity 0-1. Default 0.5 (Picovoice only) */
  sensitivity?: number;
  /** Voice ID to pass to startCall */
  voiceId?: string;
  /** Personality ID to pass to startCall */
  personalityId?: string;
  /** Stable Lumi identity to pass to startCall */
  agentId?: string;
  /** Domain scope to pass to the voice call when wake word starts it */
  startCallOptions?: { domain?: 'personal' | 'work'; orgId?: string };
  /** Called when wake word is detected (before startCall) */
  onDetection?: () => void;
  /** Return false to ignore wake audio/detections, e.g. when voiceprint says this is not the owner. */
  canAcceptWake?: () => boolean;
  canSendWakeAudio?: () => boolean;
  /** If provided and returns true, skip starting a new call (e.g. already in a call) */
  isCallActive?: () => boolean;
  /** Called to interrupt an active call when wake word fires during one */
  onInterrupt?: () => void;
}

interface UseWakeWordReturn {
  isListening: boolean;
  isSupported: boolean;
  lastDetection: string | null;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => void;
}

const PICOVOICE_ACCESS_KEY_STORAGE = 'lumi_picovoice_key';
const wakeServiceMissingMessage = () => translate('wakeServiceMissing');
const wakeServiceUnavailableMessage = () => translate('wakeServiceUnavailable');

function isWakeProviderUnavailableMessage(message: string): boolean {
  return /required for wake word detection|not configured|no DashScope key|access denied|not in good standing|unauthori[sz]ed|invalid api key|forbidden|401|403/i.test(message || '');
}

async function hasServerWakeProvider(signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await apiFetch('/api/voice/active-provider', { signal });
    const status = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    if (!status.active || !Object.hasOwn(status.active, 'streamingStt')) return null;
    const provider = status.active.streamingStt;
    // A selected official route cannot be satisfied by an unrelated direct key.
    if (status.pref?.stt === 'relay') return provider === 'relay';
    return provider === 'ark' || provider === 'qwen';
  } catch {
    return null;
  }
}

export function useWakeWord({
  socket,
  accessKey: propKey,
  keyword = 'Jarvis',
  startCallRef,
  enabled = false,
  sensitivity = 0.5,
  voiceId,
  personalityId,
  agentId,
  startCallOptions,
  onDetection,
  canAcceptWake,
  canSendWakeAudio,
  isCallActive,
  onInterrupt,
}: UseWakeWordOptions): UseWakeWordReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [lastDetection, setLastDetection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const enabledRef = useRef(enabled);
  const socketRef = useRef(socket);
  const isListeningRef = useRef(false);
  const startInFlightRef = useRef(false);
  const wakeConfigUnavailableRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureAbortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<any>(null);
  const retryAttemptRef = useRef(0);
  const retryScheduledRef = useRef(false);
  const onDetectionRef = useRef(onDetection);
  const canAcceptWakeRef = useRef(canAcceptWake);
  const canSendWakeAudioRef = useRef(canSendWakeAudio);
  const isCallActiveRef = useRef(isCallActive);
  const onInterruptRef = useRef(onInterrupt);
  const wakeHandlersRef = useRef<{
    socket?: Socket;
    detected?: (data: { keyword: string; timestamp: string }) => void;
    started?: () => void;
    error?: (data: { message: string }) => void;
  }>({});

  enabledRef.current = enabled;
  socketRef.current = socket;
  onDetectionRef.current = onDetection;
  canAcceptWakeRef.current = canAcceptWake;
  canSendWakeAudioRef.current = canSendWakeAudio;
  isCallActiveRef.current = isCallActive;
  onInterruptRef.current = onInterrupt;

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  const accessKey = propKey || localStorage.getItem(PICOVOICE_ACCESS_KEY_STORAGE) || '';

  const removeWakeHandlers = useCallback(() => {
    const handlers = wakeHandlersRef.current;
    const s = handlers.socket || socketRef.current;
    if (s) {
      if (handlers.detected) s.off('wake:detected', handlers.detected);
      if (handlers.started) s.off('wake:started', handlers.started);
      if (handlers.error) s.off('wake:error', handlers.error);
    }
    wakeHandlersRef.current = {};
  }, []);

  const cleanupAudio = useCallback(() => {
    captureAbortRef.current?.abort();
    captureAbortRef.current = null;
    startInFlightRef.current = false;
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) { try { void Promise.resolve(engine.release()).catch(() => {}); } catch {} }
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch {}
      processorRef.current = null;
    }
    void closeAudioContext(ctxRef.current);
    ctxRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  const clearRetrySchedule = useCallback((resetAttempts = false) => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryScheduledRef.current = false;
    if (resetAttempts) retryAttemptRef.current = 0;
  }, []);

  const scheduleRetry = useCallback(() => {
    if (!enabledRef.current || retryScheduledRef.current || wakeConfigUnavailableRef.current) return;
    const attempt = retryAttemptRef.current++;
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)));
    retryScheduledRef.current = true;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      retryScheduledRef.current = false;
      setRetryEpoch(value => value + 1);
    }, delayMs);
    console.warn(`[WakeWord-Server] Retrying wake stream in ${delayMs}ms`);
  }, []);

  const disable = useCallback(() => {
    clearRetrySchedule(true);
    setIsListening(false);
    isListeningRef.current = false;
    startInFlightRef.current = false;
    const s = socketRef.current;
    if (s?.connected) {
      s.emit('wake:stop');
    }
    removeWakeHandlers();
    cleanupAudio();
  }, [cleanupAudio, removeWakeHandlers, clearRetrySchedule]);

  // ── Selected server-side STT wake detection (primary) ──

  const enableServerWake = useCallback(async (signal: AbortSignal) => {
    const s = socketRef.current;
    if (!s?.connected) {
      setError('Socket not connected — retrying...');
      return;
    }

    if (wakeConfigUnavailableRef.current) {
      setIsListening(false);
      setIsSupported(false);
      setError(wakeServiceMissingMessage());
      return;
    }

    const hasProvider = await hasServerWakeProvider(signal);
    if (signal.aborted) return;
    if (hasProvider === false) {
      wakeConfigUnavailableRef.current = true;
      setIsListening(false);
      setIsSupported(false);
      setError(wakeServiceUnavailableMessage());
      return;
    }

    try {
      setError(null);
      console.log('[WakeWord-Server] Opening microphone...');

      const stream = await requestMicrophoneStream({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }, signal);
      if (signal.aborted) { releaseSensorStream('microphone', stream); return; }
      streamRef.current = stream;
      console.log('[WakeWord-Server] Mic opened, setting up AudioContext');

      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (signal.aborted || socketRef.current !== s || !s.connected || !enabledRef.current) return;
        const canSend = canSendWakeAudioRef.current;
        if (canSend && !canSend()) return;
        try {
          const input = event.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            pcm[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
          }
          s.emit('wake:audio', pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
        } catch { /* ignore */ }
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      // Set up listeners BEFORE emitting wake:start
      removeWakeHandlers();

      const onDetected = (data: { keyword: string; timestamp: string }) => {
        if (signal.aborted || socketRef.current !== s || !enabledRef.current) return;
        const canAccept = canAcceptWakeRef.current;
        if (canAccept && !canAccept()) {
          console.log('[WakeWord-Server] Ignored detection: voice gate closed');
          return;
        }
        console.log('[WakeWord-Server] Detected:', data.keyword);
        setLastDetection(data.timestamp);
        onDetectionRef.current?.();

        if (isCallActiveRef.current?.()) {
          onInterruptRef.current?.();
        } else {
          startCallRef.current?.(voiceId, personalityId, agentId, startCallOptions);
        }
      };

      const onStarted = () => {
        if (signal.aborted || socketRef.current !== s) return;
        console.log('[WakeWord-Server] Server confirmed, listening');
        clearRetrySchedule(true);
        isListeningRef.current = true;
        setIsListening(true);
        setIsSupported(true);
      };

      const onError = (data: { message: string }) => {
        if (signal.aborted) return;
        console.warn('[WakeWord-Server] Server error:', data.message);
        const message = data.message || '';
        if (isWakeProviderUnavailableMessage(message)) {
          clearRetrySchedule(true);
          wakeConfigUnavailableRef.current = true;
          isListeningRef.current = false;
          setIsListening(false);
          setIsSupported(false);
          setError(/required for wake word detection|not configured|no DashScope key/i.test(message)
            ? wakeServiceMissingMessage()
            : wakeServiceUnavailableMessage());
          cleanupAudio();
          try { s.emit('wake:stop'); } catch {}
          removeWakeHandlers();
          return;
        }
        isListeningRef.current = false;
        setIsListening(false);
        cleanupAudio();
        try { s.emit('wake:stop'); } catch {}
        removeWakeHandlers();
        setError(data.message);
        scheduleRetry();
      };

      wakeHandlersRef.current = { socket: s, detected: onDetected, started: onStarted, error: onError };
      s.on('wake:detected', onDetected);
      s.on('wake:started', onStarted);
      s.on('wake:error', onError);

      console.log('[WakeWord-Server] Emitting wake:start');
      s.emit('wake:start');
    } catch (err: any) {
      if (signal.aborted) return;
      cleanupAudio();
      const msg = err.message || 'Failed to start wake word';
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setError('Microphone permission denied. Please allow mic access.');
      } else if (isWakeProviderUnavailableMessage(msg)) {
        wakeConfigUnavailableRef.current = true;
        isListeningRef.current = false;
        setIsListening(false);
        setIsSupported(false);
        setError(/required for wake word detection|not configured|no DashScope key/i.test(msg)
          ? wakeServiceMissingMessage()
          : wakeServiceUnavailableMessage());
      } else {
        setError(msg);
      }
    }
  }, [voiceId, personalityId, agentId, startCallOptions, startCallRef, cleanupAudio, removeWakeHandlers, clearRetrySchedule, scheduleRetry]);

  // ── Picovoice on-device detection (fallback) ──

  const enablePicovoice = useCallback(async (signal: AbortSignal) => {
    try {
      setError(null);

      const { Porcupine, BuiltInKeyword } = await import('@picovoice/porcupine-web');
      if (signal.aborted) return;

      const keywordMap: Record<string, typeof BuiltInKeyword[keyof typeof BuiltInKeyword]> = {
        'Porcupine': BuiltInKeyword.Porcupine,
        'Computer': BuiltInKeyword.Computer,
        'Hey Google': BuiltInKeyword.HeyGoogle,
        'Alexa': BuiltInKeyword.Alexa,
        'Jarvis': BuiltInKeyword.Jarvis,
      };

      const detectionCallback = (_detection: any) => {
        if (signal.aborted || !enabledRef.current) return;
        const canAccept = canAcceptWakeRef.current;
        if (canAccept && !canAccept()) return;
        setLastDetection(new Date().toISOString());
        onDetectionRef.current?.();
        if (isCallActiveRef.current?.()) {
          onInterruptRef.current?.();
          return;
        }
        startCallRef.current?.(voiceId, personalityId, agentId, startCallOptions);
      };

      let engine: any;
      const builtinKeyword = keywordMap[keyword];

      if (builtinKeyword) {
        engine = await Porcupine.create(
          accessKey,
          { builtin: builtinKeyword, sensitivity },
          detectionCallback,
          { publicPath: '/porcupine_params.pv' },
        );
      } else {
        const safeName = keyword.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const customPath = `/porcupine/${safeName}.ppn`;
        try {
          engine = await Porcupine.create(
            accessKey,
            { publicPath: customPath, label: keyword, sensitivity },
            detectionCallback,
            { publicPath: '/porcupine_params.pv' },
          );
        } catch {
          if (signal.aborted) return;
          console.warn(`[WakeWord] Custom keyword "${keyword}" not found, falling back to "Jarvis"`);
          engine = await Porcupine.create(
            accessKey,
            { builtin: BuiltInKeyword.Jarvis, sensitivity },
            detectionCallback,
            { publicPath: '/porcupine_params.pv' },
          );
        }
      }

      if (signal.aborted) { await engine.release(); return; }
      engineRef.current = engine;
      const stream = await requestMicrophoneStream({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }, signal);
      if (signal.aborted) { releaseSensorStream('microphone', stream); return; }
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: engine.sampleRate });
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(engine.frameLength, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (!enabledRef.current) return;
        try {
          const input = event.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            pcm[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
          }
          engine.process(pcm);
        } catch { /* ignore */ }
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      setIsListening(true);
      setIsSupported(true);
    } catch (err: any) {
      if (signal.aborted) return;
      cleanupAudio();
      const msg = err.message || 'Failed to initialize wake word';
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setError('Microphone permission denied.');
      } else if (msg.includes('Porcupine') || msg.includes('Pv')) {
        setError(msg);
      } else {
        setError(msg);
      }
    }
  }, [accessKey, keyword, sensitivity, voiceId, personalityId, agentId, startCallOptions, startCallRef, cleanupAudio]);

  const enable = useCallback(async () => {
    if (startInFlightRef.current || isListeningRef.current) return;

    // Replace only this socket's stale session. Keep retryAttemptRef intact so
    // repeated provider failures back off instead of reconnecting in a loop.
    const currentSocket = socketRef.current;
    if (currentSocket?.connected) currentSocket.emit('wake:stop');
    removeWakeHandlers();
    cleanupAudio();
    startInFlightRef.current = true;
    setIsListening(false);
    isListeningRef.current = false;
    const controller = new AbortController();
    captureAbortRef.current = controller;

    try {
      if (accessKey) {
        console.log('[WakeWord] Using Picovoice (on-device)');
        await enablePicovoice(controller.signal);
      } else if (socketRef.current?.connected) {
        console.log('[WakeWord] Using selected STT (server-side)');
        await enableServerWake(controller.signal);
      } else {
        console.log('[WakeWord] No Picovoice key and socket not connected, waiting...');
        setError('Waiting for connection...');
      }
    } finally {
      if (captureAbortRef.current === controller) startInFlightRef.current = false;
    }
  }, [accessKey, cleanupAudio, enablePicovoice, enableServerWake, removeWakeHandlers]);

  // Listen for socket disconnect/reconnect — reset so wake auto-restarts on reconnect
  useEffect(() => {
    const s = socketRef.current;
    if (!s) return;

    const onDisconnect = () => {
      console.log('[WakeWord] Socket disconnected, resetting...');
      isListeningRef.current = false;
      clearRetrySchedule();
      removeWakeHandlers();
      cleanupAudio();
      setIsListening(false);
      setError('Connection lost — reconnecting...');
    };
    const onReconnect = () => {
      console.log('[WakeWord] Socket reconnected');
      // The server may have refreshed provider health or credentials while the
      // socket was down. Permit exactly one fresh start; a persistent account
      // denial will set this flag again and stop the retry loop.
      wakeConfigUnavailableRef.current = false;
      setError(null);
    };

    s.on('disconnect', onDisconnect);
    // socket.io-client fires 'connect' on initial AND reconnect
    const onConnect = () => {
      if (!s.connected) return;
      onReconnect();
    };
    s.on('connect', onConnect);

    return () => {
      s.off('disconnect', onDisconnect);
      s.off('connect', onConnect);
      if (wakeHandlersRef.current.socket === s) {
        if (s.connected) s.emit('wake:stop');
        removeWakeHandlers();
        cleanupAudio();
        isListeningRef.current = false;
        setIsListening(false);
      }
    };
  }, [socket, socket?.id, cleanupAudio, removeWakeHandlers, clearRetrySchedule]);

  useEffect(() => {
    const onKeysChanged = () => {
      wakeConfigUnavailableRef.current = false;
      if (enabledRef.current) {
        setError(null);
        disable();
        setRetryEpoch(value => value + 1);
      }
    };
    window.addEventListener('lumi:keys-changed', onKeysChanged);
    window.addEventListener(VOICE_PROVIDER_CHANGED_EVENT, onKeysChanged);
    return () => {
      window.removeEventListener('lumi:keys-changed', onKeysChanged);
      window.removeEventListener(VOICE_PROVIDER_CHANGED_EVENT, onKeysChanged);
    };
  }, [disable]);

  // Auto-start / stop — includes socket state so it retries when connection becomes available
  useEffect(() => {
    console.log('[WakeWord] State change — enabled:', enabled, 'isListening:', isListening, 'socket:', !!socketRef.current?.connected);
    if (enabled && !isListening && !wakeConfigUnavailableRef.current && !retryScheduledRef.current) {
      enable();
    } else if (!enabled) {
      disable();
    }
  }, [enabled, isListening, enable, disable, socket?.connected, retryEpoch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { disable(); };
  }, [disable]);

  return { isListening, isSupported, lastDetection, error, enable, disable };
}

export function savePicovoiceKey(key: string) {
  localStorage.setItem(PICOVOICE_ACCESS_KEY_STORAGE, key);
}

export function getPicovoiceKey(): string | null {
  return localStorage.getItem(PICOVOICE_ACCESS_KEY_STORAGE);
}
