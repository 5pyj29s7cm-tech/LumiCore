import { useState, useRef, useCallback, useEffect } from 'react';
import {
  shouldDisplayAgentResponse,
  type AgentResponseDelivery,
} from '@/lib/agentResponseDelivery';
import { closeAudioContext } from '@/lib/audioContextLifecycle';
import {
  applyPreferredVoiceOutputDevice,
  requestPreferredMicrophoneStream,
  VOICE_DEVICE_PREFERENCE_CHANGED,
} from '@/lib/voiceDevicePreferences';

export type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'queued' | 'passive';

const THINKING_WATCHDOG_MS = 45000;

export interface VoiceTranscriptMeta {
  speakerLabel?: string | null;
  speakerConfidence?: number;
  speakerSource?: string;
  speakerMatched?: boolean;
}

interface UseVoiceCallOptions {
  socket: any;
  onTranscript?: (text: string, isFinal: boolean, meta?: VoiceTranscriptMeta) => void;
  onResponse?: (text: string) => void;
  canSendMicAudio?: () => boolean;
}

interface StartCallOptions {
  transcriptionOnly?: boolean;
  domain?: 'personal' | 'work';
  orgId?: string;
}

interface EndCallOptions {
  refineTranscript?: boolean;
}

interface VoiceStartPayload {
  voiceId?: string;
  personalityId: string;
  agentId?: string;
  transcriptionOnly: boolean;
  domain: 'personal' | 'work';
  orgId?: string;
  sessionId: string;
}

interface VoiceAudioResponse {
  buffer: ArrayBuffer;
  volumeGain?: number;
  requestId?: string;
  lane?: string;
}

export function shouldAcceptVoiceStatus(
  data: { status: string; requestId?: string },
  activeRequestId: string | null,
): boolean {
  if (data.status === 'thinking') return true;
  if (data.requestId && activeRequestId && data.requestId !== activeRequestId) return false;
  if (!data.requestId && activeRequestId && (data.status === 'listening' || data.status === 'idle')) return false;
  return true;
}

export function waitForVoiceSocket(socket: any, timeoutMs = 8000): Promise<void> {
  if (socket?.connected) return Promise.resolve();
  if (!socket) return Promise.reject(new Error('Voice connection is unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off?.('connect', onConnect);
      socket.off?.('connect_error', onError);
      if (error) reject(error); else resolve();
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(new Error(error?.message || 'Voice connection failed'));
    const timer = setTimeout(() => finish(new Error('Voice connection timed out')), timeoutMs);
    socket.on?.('connect', onConnect);
    socket.on?.('connect_error', onError);
    socket.connect?.();
  });
}

function createVoiceSessionId(): string {
  try { return crypto.randomUUID(); } catch { return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function releaseAudioBufferSource(source: AudioBufferSourceNode | null, stop = false): void {
  if (!source) return;
  source.onended = null;
  if (stop) {
    try { source.stop(); } catch {}
  }
  try { source.disconnect(); } catch {}
  try { source.buffer = null; } catch {}
}

export function useVoiceCall({ socket, onTranscript, onResponse, canSendMicAudio }: UseVoiceCallOptions) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [responseText, setResponseText] = useState<string>('');
  const [isMuted, setIsMuted] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState<'good' | 'fair' | 'poor'>('good');

  const audioContext = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rawAudioLevelRef = useRef(0);
  const proactiveSource = useRef<AudioBufferSourceNode | null>(null);
  const proactiveContext = useRef<AudioContext | null>(null);
  const callStartTime = useRef<number>(0);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const passiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCallState = useRef<CallState>('idle');
  const transcriptionOnlyRef = useRef(false);
  const canSendMicAudioRef = useRef(canSendMicAudio);
  const ttsEchoFloorRef = useRef(0);
  const ttsBargeInFramesRef = useRef(0);
  const thinkingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingWatchdogStartedAt = useRef(0);
  const callStateRef = useRef<CallState>('idle');
  const lastPassiveSilenceKeepAlive = useRef(0);
  const activeStartPayload = useRef<VoiceStartPayload | null>(null);
  const activeVoiceRequestIdRef = useRef<string | null>(null);
  const activeWorkRequestIdRef = useRef<string | null>(null);
  const socketRef = useRef(socket);
  const callGenerationRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  const startInFlightRef = useRef(false);

  useEffect(() => { canSendMicAudioRef.current = canSendMicAudio; }, [canSendMicAudio]);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  const clearThinkingWatchdog = useCallback(() => {
    if (thinkingWatchdogRef.current) {
      clearTimeout(thinkingWatchdogRef.current);
      thinkingWatchdogRef.current = null;
    }
  }, []);

  const scheduleThinkingWatchdog = useCallback((lane: 'turn' | 'work' = 'turn') => {
    clearThinkingWatchdog();
    const startedAt = Date.now();
    thinkingWatchdogStartedAt.current = startedAt;
    thinkingWatchdogRef.current = setTimeout(() => {
      if (thinkingWatchdogStartedAt.current !== startedAt) return;
      const requestId = activeVoiceRequestIdRef.current;
      // This timer protects the UI from looking frozen; it is not the owner of
      // a server task lease. A slow model/tool may still be healthy, so probe
      // status and reopen the microphone without cancelling real work.
      console.warn(`[VoiceCall] ${lane} status is stale; probing server without cancelling the turn`);
      if (requestId) {
        socketRef.current?.emit('audio:work_status_probe', { requestId, lane });
      }
      setCallState(prev => {
        if (prev !== 'thinking') return prev;
        return isCallActive.current ? 'listening' : 'idle';
      });
      thinkingWatchdogRef.current = null;
    }, THINKING_WATCHDOG_MS);
  }, [clearThinkingWatchdog]);

  const isTtsPlaying = useRef(false);
  const isCallActive = useRef(false);
  const playbackStartTime = useRef(0);
  // Streaming TTS: pre-buffer and cross-fade to eliminate gaps between chunks
  const ttsContext = useRef<AudioContext | null>(null);
  const ttsGainNode = useRef<GainNode | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const nextStartTime = useRef(0);  // When the next chunk should start playing
  const ttsStartedAt = useRef(0);

  const ensureTtsContext = useCallback(() => {
    if (!ttsContext.current || ttsContext.current.state === 'closed') {
      ttsContext.current = new AudioContext();
      void applyPreferredVoiceOutputDevice(ttsContext.current);
      ttsGainNode.current = ttsContext.current.createGain();
      ttsGainNode.current.connect(ttsContext.current.destination);
      if (ttsContext.current.state === 'suspended') {
        void ttsContext.current.resume().catch(() => {});
      }
      nextStartTime.current = 0;
    }
    return ttsContext.current;
  }, []);

  const stopAllPlayback = useCallback(() => {
    playbackGenerationRef.current++;
    playbackStartTime.current = 0;
    // Clear sentence audio queue
    audioQueue.current = [];
    // Stop proactive speech (greetings, check-ins) — now interruptible
    if (proactiveSource.current) {
      releaseAudioBufferSource(proactiveSource.current, true);
      proactiveSource.current = null;
    }
    if (proactiveContext.current) {
      void closeAudioContext(proactiveContext.current);
      proactiveContext.current = null;
    }
    // Stop currently playing TTS source
    if (ttsSourceRef.current) {
      releaseAudioBufferSource(ttsSourceRef.current, true);
      ttsSourceRef.current = null;
    }
    // Reset streaming TTS context
    if (ttsContext.current) {
      nextStartTime.current = 0;
      if (ttsGainNode.current) {
        ttsGainNode.current.gain.value = 1.0;
      }
    }
    isTtsPlaying.current = false;
    ttsEchoFloorRef.current = 0;
    ttsBargeInFramesRef.current = 0;
  }, []);

  const disposePlaybackContexts = useCallback(() => {
    stopAllPlayback();
    const gain = ttsGainNode.current;
    ttsGainNode.current = null;
    try { gain?.disconnect(); } catch {}
    const context = ttsContext.current;
    ttsContext.current = null;
    nextStartTime.current = 0;
    void closeAudioContext(context);
  }, [stopAllPlayback]);

  const cleanupCapture = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lumi:voice-capture-state', { detail: { active: false } }));
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      try { scriptProcessorRef.current.disconnect(); } catch {}
      scriptProcessorRef.current = null;
    }
    void closeAudioContext(audioContext.current);
    audioContext.current = null;
    rawAudioLevelRef.current = 0;
  }, []);

  const clearPassiveTimers = useCallback(() => {
    if (passiveTimer.current) { clearTimeout(passiveTimer.current); passiveTimer.current = null; }
    if (disconnectTimer.current) { clearTimeout(disconnectTimer.current); disconnectTimer.current = null; }
  }, []);

  const endCall = useCallback((options: EndCallOptions = {}) => {
    callGenerationRef.current++;
    isCallActive.current = false;
    clearPassiveTimers();
    clearThinkingWatchdog();
    const activeSocket = socketRef.current;
    activeSocket?.emit('audio:stop', {
      refineTranscript: options.refineTranscript === true,
      sessionId: activeStartPayload.current?.sessionId,
    });
    activeStartPayload.current = null;
    activeVoiceRequestIdRef.current = null;
    activeWorkRequestIdRef.current = null;
    disposePlaybackContexts();
    cleanupCapture();

    isTtsPlaying.current = false;
    transcriptionOnlyRef.current = false;
    ttsStartedAt.current = 0;
    setIsMuted(false);

    setCallState('idle');
  }, [cleanupCapture, disposePlaybackContexts, clearPassiveTimers, clearThinkingWatchdog]);

  const audioQueue = useRef<Array<ArrayBuffer | VoiceAudioResponse>>([]);

  useEffect(() => {
    if (!socket) return;

    const onAudioStatus = (data: { status: string; requestId?: string; lane?: string }) => {
      if (!isCallActive.current) return;
      const activeRequestId = activeVoiceRequestIdRef.current;
      if (!shouldAcceptVoiceStatus(data, activeRequestId)) return;
      if (data.status === 'thinking' && data.requestId) {
        activeVoiceRequestIdRef.current = data.requestId;
      }
      const map: Record<string, CallState> = {
        connecting: 'connecting',
        listening: 'listening',
        thinking: 'thinking',
        speaking: 'speaking',
        queued: 'queued',
        idle: 'idle',
        passive: 'passive',
      };
      const next = map[data.status] || 'idle';
      if (next === 'thinking') scheduleThinkingWatchdog();
      else if (data.lane !== 'conversation') clearThinkingWatchdog();
      setCallState(prev => {
        // Start passive timer when transitioning to listening (server waiting for speech)
        if (next === 'listening' && prev !== 'listening') {
          if (passiveTimer.current) { clearTimeout(passiveTimer.current); passiveTimer.current = null; }
          if (disconnectTimer.current) { clearTimeout(disconnectTimer.current); disconnectTimer.current = null; }
          if (transcriptionOnlyRef.current) {
            prevCallState.current = next;
            return next;
          }
          const alwaysOn = localStorage.getItem('lumi_always_on_voice') === 'true';
          const passiveDelay = alwaysOn ? 5 * 60 * 1000 : 15 * 1000;   // 5min in always-on, 15s default
          passiveTimer.current = setTimeout(() => {
            setCallState('passive');
            if (!alwaysOn) {
              disconnectTimer.current = setTimeout(() => {
                endCall();
              }, 5 * 60 * 1000);
            }
            // In always-on mode, never auto-disconnect — stay passive until user speaks or manually ends
          }, passiveDelay);
        }
        prevCallState.current = next;
        return next;
      });
      if (
        data.requestId
        && data.requestId === activeVoiceRequestIdRef.current
        && (data.status === 'listening' || data.status === 'idle')
      ) {
        if (activeWorkRequestIdRef.current === data.requestId) activeWorkRequestIdRef.current = null;
        activeVoiceRequestIdRef.current = null;
      }
    };

    // Voice confirmation window — show recognized text while the server yields
    // briefly before starting the task pipeline.
    const onAudioConfirm = (data: { text: string }) => {
      if (!isCallActive.current) return;
      setTranscript(data.text);
      if (!transcriptionOnlyRef.current) {
        onTranscript?.(data.text, true);
      }
    };

    /**
     * Play a TTS audio chunk using Web Audio API with cross-fade scheduling.
     * Pre-buffers: starts decoding while the previous chunk is still playing.
     * Cross-fade: overlaps the last 50ms of previous audio with the first 50ms of next.
     * VolumeGain: applies server-computed volume adaptation.
     */
    const playAudioChunk = (buffer: ArrayBuffer, volumeGain?: number, lane?: string, requestId?: string) => {
      if (!isCallActive.current) return;
      const ctx = ensureTtsContext();
      const playbackGeneration = playbackGenerationRef.current;
      isTtsPlaying.current = true;
      if (ttsStartedAt.current === 0) ttsStartedAt.current = Date.now();
      if (lane !== 'conversation') clearThinkingWatchdog();
      setCallState(prev => (prev === 'thinking' || prev === 'queued') ? 'speaking' : prev);

      ctx.decodeAudioData(buffer.slice(0), (decoded) => {
        if (!isCallActive.current || playbackGeneration !== playbackGenerationRef.current || ctx.state === 'closed') return;
        const now = ctx.currentTime;

        // When to start this chunk: right after the previous one, minus cross-fade overlap
        const crossFadeSec = 0.05; // 50ms cross-fade
        const effectiveStart = nextStartTime.current > 0
          ? Math.max(now, nextStartTime.current - crossFadeSec)
          : now;
        nextStartTime.current = effectiveStart + decoded.duration;

        const source = ctx.createBufferSource();
        source.buffer = decoded;

        // Volume: apply server-computed gain, default 1.0
        const gain = typeof volumeGain === 'number' ? Math.max(0.3, Math.min(1.5, volumeGain)) : 1.0;
        if (ttsGainNode.current) {
          ttsGainNode.current.gain.setValueAtTime(gain, effectiveStart);
        }

        source.connect(ttsGainNode.current!);
        ttsSourceRef.current = source;

        source.onended = () => {
          releaseAudioBufferSource(source);
          if (ttsSourceRef.current === source) ttsSourceRef.current = null;
          if (playbackGeneration !== playbackGenerationRef.current) return;
          // Check if more chunks are queued
          if (audioQueue.current.length > 0) {
            const next = audioQueue.current.shift()!;
            const queued: VoiceAudioResponse = next instanceof ArrayBuffer ? { buffer: next } : next;
            playAudioChunk(queued.buffer, queued.volumeGain, queued.lane, queued.requestId);
          } else {
            isTtsPlaying.current = false;
            setCallState(prev => prev === 'speaking' ? 'listening' : prev);
          }
        };

        source.start(effectiveStart);
        if (requestId) {
          const ackGeneration = playbackGeneration;
          const delayMs = Math.max(0, Math.round((effectiveStart - ctx.currentTime) * 1000));
          setTimeout(() => {
            if (!isCallActive.current || ackGeneration !== playbackGenerationRef.current) return;
            socket.emit('audio:playback_started', { requestId, lane });
          }, delayMs);
        }
      }, (err) => {
        if (playbackGeneration !== playbackGenerationRef.current) return;
        console.error('[VoiceCall] Decode failed:', err);
        isTtsPlaying.current = false;
        if (audioQueue.current.length > 0) {
          const next = audioQueue.current.shift()!;
          const queued: VoiceAudioResponse = next instanceof ArrayBuffer ? { buffer: next } : next;
          playAudioChunk(queued.buffer, queued.volumeGain, queued.lane, queued.requestId);
        }
      });
    };

    // Handle both old format (raw ArrayBuffer) and new format ({ buffer, volumeGain })
    const onAudioResponse = (data: ArrayBuffer | VoiceAudioResponse) => {
      if (!isCallActive.current) { console.log('[VoiceCall] Ignoring audio:response, call ended'); return; }
      if (!(data instanceof ArrayBuffer) && data.requestId && data.requestId !== activeVoiceRequestIdRef.current) return;
      const actualBuffer = data instanceof ArrayBuffer ? data : data.buffer;
      const actualGain = data instanceof ArrayBuffer ? undefined : data.volumeGain;
      const actualLane = data instanceof ArrayBuffer ? undefined : data.lane;
      const actualRequestId = data instanceof ArrayBuffer ? undefined : data.requestId;

      if (isTtsPlaying.current) {
        // Currently playing — queue this chunk
        audioQueue.current.push(data instanceof ArrayBuffer ? data : {
          buffer: actualBuffer,
          volumeGain: actualGain,
          lane: actualLane,
          requestId: actualRequestId,
        });
        return;
      }
      playAudioChunk(actualBuffer, actualGain, actualLane, actualRequestId);
    };

    const onAudioTranscript = (data: { text: string; isFinal: boolean } & VoiceTranscriptMeta) => {
      if (!isCallActive.current) return;
      // Reset passive timer — user is speaking
      if (passiveTimer.current) { clearTimeout(passiveTimer.current); passiveTimer.current = null; }
      if (disconnectTimer.current) { clearTimeout(disconnectTimer.current); disconnectTimer.current = null; }
      if (prevCallState.current === 'passive') setCallState('listening');
      setTranscript(data.text);
      onTranscript?.(data.text, data.isFinal, {
        speakerLabel: data.speakerLabel,
        speakerConfidence: data.speakerConfidence,
        speakerSource: data.speakerSource,
        speakerMatched: data.speakerMatched,
      });
      if (data.isFinal) {
        setTimeout(() => setTranscript(''), 2000); // Clear after 2s if final
      }
    };

    const onAgentResponse = (data: AgentResponseDelivery & { channel?: string; requestId?: string }) => {
      if (!isCallActive.current) return;
      if (data.channel !== 'voice') return;
      if (!activeVoiceRequestIdRef.current || data.requestId !== activeVoiceRequestIdRef.current) return;
      if (!shouldDisplayAgentResponse(data)) return;
      setTranscript(''); // Clear user transcript when AI starts responding
      setResponseText(data.text!);
      onResponse?.(data.text!);
    };

    const onAudioError = (data: { message: string }) => {
      if (!isCallActive.current) return;
      callGenerationRef.current++;
      isCallActive.current = false;
      activeStartPayload.current = null;
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      setError(data.message);
      clearThinkingWatchdog();
      cleanupCapture();
      disposePlaybackContexts();
      transcriptionOnlyRef.current = false;
      setCallState('idle');
    };

    const onAudioInterruptAck = (data?: { workContinues?: boolean; requestId?: string }) => {
      if (data?.workContinues) {
        if (data.requestId) activeVoiceRequestIdRef.current = data.requestId;
      } else {
        activeWorkRequestIdRef.current = null;
        activeVoiceRequestIdRef.current = null;
      }
      clearThinkingWatchdog();
      stopAllPlayback();
      setCallState('listening');
    };

    const onAudioEndCallRequest = () => {
      if (!isCallActive.current) return;
      endCall();
    };

    const onAudioSidecarResponse = (data: { text?: string; requestId?: string; workRequestId?: string }) => {
      if (!isCallActive.current || !data.text?.trim()) return;
      const workRequestId = data.workRequestId || data.requestId;
      if (!workRequestId || workRequestId !== activeVoiceRequestIdRef.current) return;
      setTranscript('');
      setResponseText(data.text.trim());
      onResponse?.(data.text.trim());
    };

    const onAudioWorkProgress = (data: { text?: string; requestId?: string; active?: boolean }) => {
      if (!isCallActive.current || !data.text?.trim()) return;
      if (!data.requestId || data.requestId !== activeVoiceRequestIdRef.current) return;
      if (data.active === false) {
        if (activeWorkRequestIdRef.current === data.requestId) activeWorkRequestIdRef.current = null;
        clearThinkingWatchdog();
      } else {
        activeWorkRequestIdRef.current = data.requestId;
        scheduleThinkingWatchdog('work');
      }
      // This is a live task indicator, not an assistant chat turn. Keep it in
      // the call surface without feeding it back into conversation history.
      setResponseText(data.text.trim());
    };

    const onAudioProactiveSpeak = (data: { audioBuffer: ArrayBuffer; text: string; timestamp: string }) => {
      try {
        // Stop any currently-playing proactive speech before starting new one
        if (proactiveSource.current) {
          releaseAudioBufferSource(proactiveSource.current, true);
          proactiveSource.current = null;
        }
        if (proactiveContext.current) {
          void closeAudioContext(proactiveContext.current);
          proactiveContext.current = null;
        }
        isTtsPlaying.current = true;
        const ctx = new AudioContext();
        void applyPreferredVoiceOutputDevice(ctx);
        const playbackGeneration = playbackGenerationRef.current;
        proactiveContext.current = ctx;
        ctx.decodeAudioData(data.audioBuffer.slice(0), (decoded) => {
          if (playbackGeneration !== playbackGenerationRef.current || ctx.state === 'closed') return;
          const source = ctx.createBufferSource();
          proactiveSource.current = source;
          source.buffer = decoded;
          source.connect(ctx.destination);
          source.onended = () => {
            releaseAudioBufferSource(source);
            if (proactiveSource.current === source) proactiveSource.current = null;
            if (proactiveContext.current === ctx) proactiveContext.current = null;
            isTtsPlaying.current = false;
            void closeAudioContext(ctx);
          };
          source.start(0);
        }, () => {
          if (proactiveContext.current === ctx) proactiveContext.current = null;
          isTtsPlaying.current = false;
          void closeAudioContext(ctx);
        });
        // Briefly show speaking state for visual feedback
        const prev = prevCallState.current;
        setCallState('speaking');
        const duration = Math.max(2, (data.audioBuffer.byteLength / 16000) * 1000 + 500);
        setTimeout(() => {
          setCallState(prev);
          isTtsPlaying.current = false;
        }, duration);
      } catch (err) {
        console.error('[ProactiveVoice] Playback failed:', err);
        isTtsPlaying.current = false;
      }
    };

    socket.on('audio:status', onAudioStatus);
    socket.on('audio:confirm', onAudioConfirm);
    socket.on('audio:response', onAudioResponse);
    socket.on('audio:transcript', onAudioTranscript);
    socket.on('agent:response', onAgentResponse);
    socket.on('audio:error', onAudioError);
    socket.on('audio:interrupt-ack', onAudioInterruptAck);
    socket.on('audio:end-call-request', onAudioEndCallRequest);
    socket.on('audio:sidecar_response', onAudioSidecarResponse);
    socket.on('audio:work_progress', onAudioWorkProgress);
    socket.on('audio:proactive_speak', onAudioProactiveSpeak);

    return () => {
      socket.off('audio:status', onAudioStatus);
      socket.off('audio:confirm', onAudioConfirm);
      socket.off('audio:response', onAudioResponse);
      socket.off('audio:transcript', onAudioTranscript);
      socket.off('agent:response', onAgentResponse);
      socket.off('audio:error', onAudioError);
      socket.off('audio:interrupt-ack', onAudioInterruptAck);
      socket.off('audio:end-call-request', onAudioEndCallRequest);
      socket.off('audio:sidecar_response', onAudioSidecarResponse);
      socket.off('audio:work_progress', onAudioWorkProgress);
      socket.off('audio:proactive_speak', onAudioProactiveSpeak);
      clearThinkingWatchdog();
    };
  }, [socket, onTranscript, onResponse, stopAllPlayback, disposePlaybackContexts, cleanupCapture, clearThinkingWatchdog, endCall, ensureTtsContext, scheduleThinkingWatchdog]);

  useEffect(() => {
    if (!socket) return;
    const onDisconnect = () => {
      if (!isCallActive.current) return;
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      setConnectionQuality('poor');
      setCallState('connecting');
      clearThinkingWatchdog();
      stopAllPlayback();
    };
    const onConnect = () => {
      const payload = activeStartPayload.current;
      if (!isCallActive.current || !payload) return;
      setConnectionQuality('fair');
      setCallState('connecting');
      socket.emit('audio:start', payload);
    };
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [socket, clearThinkingWatchdog, stopAllPlayback]);

  // Push audio emotion perception events when call state changes
  useEffect(() => {
    if (!socket?.connected || callState === 'idle' || callState === 'connecting') return;
    const emotionMap: Record<string, { emotion: string; intensity: number }> = {
      listening: { emotion: 'attentive', intensity: 0.4 },
      thinking: { emotion: 'focused', intensity: 0.6 },
      speaking: { emotion: 'engaged', intensity: 0.7 },
    };
    const entry = emotionMap[callState];
    if (entry) {
      socket.emit('perception:audio_emotion', entry);
    }
  }, [callState, socket]);

  const startCall = useCallback(async (voiceId?: string, personalityId: string = 'lumi', agentId?: string, options: StartCallOptions = {}) => {
    if (isCallActive.current || startInFlightRef.current) return;
    const generation = ++callGenerationRef.current;
    startInFlightRef.current = true;
    try {
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      setError(null);
      setCallState('connecting');
      transcriptionOnlyRef.current = options.transcriptionOnly === true;

      const activeSocket = socketRef.current;
      await waitForVoiceSocket(activeSocket);
      if (generation !== callGenerationRef.current) return;

      const stream = await requestPreferredMicrophoneStream({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (generation !== callGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      window.dispatchEvent(new CustomEvent('lumi:voice-capture-state', { detail: { active: true } }));

      // Set up audio level monitoring at the realtime STT sample rate.
      audioContext.current = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.current.createMediaStreamSource(stream);

      // Set up ScriptProcessorNode to capture raw PCM (linear16) for realtime STT.
      // 128 ms frames keep realtime STT and spoken barge-in responsive while
      // remaining large enough to avoid excessive socket overhead.
      const bufferSize = 2048;
      const scriptProcessor = audioContext.current.createScriptProcessor(bufferSize, 1, 1);

      scriptProcessor.onaudioprocess = (event) => {
        const currentSocket = socketRef.current;
        if (!currentSocket?.connected) return;
        const input = event.inputBuffer.getChannelData(0);
        // Convert float32 [-1,1] to int16 PCM
        const int16 = new Int16Array(input.length);
        let frameSum = 0;
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          frameSum += s * s;
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const chunk = new Uint8Array(int16.buffer);
        const frameRms = Math.sqrt(frameSum / Math.max(1, input.length));
        rawAudioLevelRef.current = frameRms;
        window.dispatchEvent(new CustomEvent('lumi:voice-audio-level', {
          detail: { level: frameRms },
        }));

        // Keep realtime STT active while Lumi speaks. Browser echo cancellation
        // plus the server's recent-TTS matcher remove self speech; keeping this
        // lane open gives stop commands a semantic path even when the local
        // energy detector does not cross its threshold.
        if (isTtsPlaying.current) {
          currentSocket.volatile.emit('audio:chunk', chunk);

          const ttsAgeMs = ttsStartedAt.current > 0 ? Date.now() - ttsStartedAt.current : 0;
          // Learn the current room/speaker echo at the start of every
          // utterance. A fixed threshold made normal-volume and short
          // interruptions unreliable across different microphones.
          if (ttsAgeMs <= 450) {
            ttsEchoFloorRef.current = ttsEchoFloorRef.current === 0
              ? frameRms
              : (ttsEchoFloorRef.current * 0.72) + (frameRms * 0.28);
            ttsBargeInFramesRef.current = 0;
          } else {
            const adaptiveThreshold = Math.max(
              0.018,
              Math.min(0.09, (ttsEchoFloorRef.current * 2.2) + 0.006),
            );
            ttsBargeInFramesRef.current = frameRms > adaptiveThreshold
              ? ttsBargeInFramesRef.current + 1
              : 0;
            const strongSpeechFrame = frameRms > Math.max(0.045, adaptiveThreshold * 1.6);
            if (strongSpeechFrame || ttsBargeInFramesRef.current >= 2) {
              // Stopping local playback is harmless and must not wait for an
              // asynchronous voiceprint sample. Audio is already flowing
              // through the semantic stop lane, so no pre-roll replay is needed.
              currentSocket.emit('audio:interrupt');
              stopAllPlayback();
              ttsStartedAt.current = 0;
              setCallState('listening');
              if (!transcriptionOnlyRef.current) {
                window.dispatchEvent(new CustomEvent('lumi:voice-pcm-frame', {
                  detail: { samples: new Float32Array(input), rms: frameRms },
                }));
              }
            }
          }
          return;
        }

        const micAllowed = transcriptionOnlyRef.current || (canSendMicAudioRef.current?.() ?? true);
        if (!micAllowed) return;

        if (!transcriptionOnlyRef.current) {
          // Feed speaker verification from the exact PCM stream sent to STT.
          // A second getUserMedia stream drifts across utterance boundaries and
          // can accidentally authorize loudspeaker audio with a stale match.
          window.dispatchEvent(new CustomEvent('lumi:voice-pcm-frame', {
            detail: { samples: new Float32Array(input), rms: frameRms },
          }));
        }

        if (!transcriptionOnlyRef.current && callStateRef.current === 'passive' && frameRms < 0.004) {
          const now = Date.now();
          if (now - lastPassiveSilenceKeepAlive.current < 1500) return;
          lastPassiveSilenceKeepAlive.current = now;
        }

        currentSocket.volatile.emit('audio:chunk', chunk);
      };

      source.connect(scriptProcessor);
      // Mute output to speakers to prevent feedback loop
      const zeroGain = audioContext.current.createGain();
      zeroGain.gain.value = 0;
      scriptProcessor.connect(zeroGain);
      zeroGain.connect(audioContext.current.destination);

      scriptProcessorRef.current = scriptProcessor;

      isCallActive.current = true;
      callStartTime.current = Date.now();
      const startPayload: VoiceStartPayload = {
        voiceId,
        personalityId,
        agentId,
        transcriptionOnly: options.transcriptionOnly === true,
        domain: options.domain || 'personal',
        orgId: options.domain === 'work' ? options.orgId : undefined,
        sessionId: createVoiceSessionId(),
      };
      activeStartPayload.current = startPayload;
      activeSocket.emit('audio:start', startPayload);
    } catch (err: any) {
      if (generation !== callGenerationRef.current) return;
      cleanupCapture();
      activeStartPayload.current = null;
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      isCallActive.current = false;
      transcriptionOnlyRef.current = false;
      setError(err.message || 'Failed to start voice call');
      setCallState('idle');
    } finally {
      startInFlightRef.current = false;
    }
  }, [cleanupCapture, stopAllPlayback]);

  useEffect(() => {
    const applyOutputPreference = () => {
      if (ttsContext.current) void applyPreferredVoiceOutputDevice(ttsContext.current);
      if (proactiveContext.current) void applyPreferredVoiceOutputDevice(proactiveContext.current);
    };
    window.addEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, applyOutputPreference);
    return () => window.removeEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, applyOutputPreference);
  }, []);

  const startCallRef = useRef(startCall);
  startCallRef.current = startCall;

  const interrupt = useCallback(() => {
    if (callState === 'speaking' || callState === 'thinking') {
      socket?.emit('audio:interrupt');
      stopAllPlayback();
    }
  }, [socket, callState, stopAllPlayback]);

  useEffect(() => {
    const stopVoiceOutput = () => {
      if (isCallActive.current) socketRef.current?.emit('audio:interrupt');
      stopAllPlayback();
    };
    window.addEventListener('lumi:stop-voice-output', stopVoiceOutput);
    return () => window.removeEventListener('lumi:stop-voice-output', stopVoiceOutput);
  }, [stopAllPlayback]);

  const switchPersonality = useCallback((personalityId: string) => {
    if (callState !== 'idle') {
      socket?.emit('audio:switch-personality', { personalityId });
    }
  }, [socket, callState]);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      if (streamRef.current) {
        streamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
      }
      return next;
    });
  }, []);

  useEffect(() => () => {
    callGenerationRef.current++;
    if (isCallActive.current && activeStartPayload.current) {
      socketRef.current?.emit('audio:stop', {
        refineTranscript: false,
        sessionId: activeStartPayload.current.sessionId,
      });
    }
    isCallActive.current = false;
    activeStartPayload.current = null;
    activeVoiceRequestIdRef.current = null;
    activeWorkRequestIdRef.current = null;
    cleanupCapture();
    disposePlaybackContexts();
  }, [cleanupCapture, disposePlaybackContexts]);

  // Track the beginning of each TTS utterance. Audio-frame processing above
  // uses this timestamp to learn an adaptive echo floor and detect barge-in.
  useEffect(() => {
    if (isTtsPlaying.current && ttsStartedAt.current === 0) {
      ttsStartedAt.current = Date.now();
    } else if (!isTtsPlaying.current) {
      ttsStartedAt.current = 0;
      ttsEchoFloorRef.current = 0;
      ttsBargeInFramesRef.current = 0;
    }
  }, [callState]);

  // Monitor connection quality via socket latency
  useEffect(() => {
    if (!socket || callState === 'idle') return;
    const interval = setInterval(() => {
      const start = Date.now();
      const onPong = () => {
        const latency = Date.now() - start;
        if (latency < 150) setConnectionQuality('good');
        else if (latency < 400) setConnectionQuality('fair');
        else setConnectionQuality('poor');
      };
      if (socket.connected) {
        socket.emit('ping');
        socket.once('pong', onPong);
      } else {
        setConnectionQuality('poor');
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [socket, callState]);

  // Report ambient noise level to server every 5s for environment-aware behavior
  useEffect(() => {
    if (!socket || callState === 'idle') return;
    const interval = setInterval(() => {
      socket.emit('ambient:noise_level', {
        rms: rawAudioLevelRef.current,
        isSpeaking: isTtsPlaying.current,
        callState,
        timestamp: new Date().toISOString(),
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [socket, callState]);

  return {
    callState,
    // Realtime RMS deliberately stays outside React state. DesktopUI is a very
    // large tree; publishing microphone frames through this hook causes the
    // WebView to retain development-render traces until it becomes unresponsive.
    audioLevel: 0,
    error,
    transcript,
    responseText,
    isMuted,
    elapsedSeconds: isCallActive.current && callStartTime.current > 0
      ? Math.floor((Date.now() - callStartTime.current) / 1000)
      : 0,
    connectionQuality,
    startCall,
    startCallRef,
    endCall,
    interrupt,
    toggleMute,
    switchPersonality,
    clearError: () => setError(null),
  };
}
