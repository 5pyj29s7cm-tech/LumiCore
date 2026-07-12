import { useState, useRef, useCallback, useEffect } from 'react';
import { requestMicrophoneStream } from '@/services/sensorPermissionService';

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
  canInterruptFromVoice?: () => boolean;
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

export function useVoiceCall({ socket, onTranscript, onResponse, canInterruptFromVoice, canSendMicAudio }: UseVoiceCallOptions) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [responseText, setResponseText] = useState<string>('');
  const [isMuted, setIsMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [connectionQuality, setConnectionQuality] = useState<'good' | 'fair' | 'poor'>('good');

  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrame = useRef<number>(0);
  const pendingAudio = useRef<ArrayBuffer[]>([]);
  const isPlaying = useRef(false);
  const playbackSource = useRef<AudioBufferSourceNode | null>(null);
  const proactiveSource = useRef<AudioBufferSourceNode | null>(null);
  const proactiveContext = useRef<AudioContext | null>(null);
  const audioQueueContext = useRef<AudioContext | null>(null);
  const callStartTime = useRef<number>(0);
  const timerInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const passiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCallState = useRef<CallState>('idle');
  const transcriptionOnlyRef = useRef(false);
  const canInterruptFromVoiceRef = useRef(canInterruptFromVoice);
  const canSendMicAudioRef = useRef(canSendMicAudio);
  const ttsPreRollChunks = useRef<Uint8Array[]>([]);
  const flushTtsPreRollOnNextAudio = useRef(false);
  const musicDuckingRef = useRef<{ active: boolean; level: number | null }>({ active: false, level: null });
  const thinkingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingWatchdogStartedAt = useRef(0);
  const callStateRef = useRef<CallState>('idle');
  const lastPassiveSilenceKeepAlive = useRef(0);
  const activeStartPayload = useRef<VoiceStartPayload | null>(null);
  const socketRef = useRef(socket);
  const callGenerationRef = useRef(0);
  const startInFlightRef = useRef(false);

  useEffect(() => { canInterruptFromVoiceRef.current = canInterruptFromVoice; }, [canInterruptFromVoice]);
  useEffect(() => { canSendMicAudioRef.current = canSendMicAudio; }, [canSendMicAudio]);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  const clearThinkingWatchdog = useCallback(() => {
    if (thinkingWatchdogRef.current) {
      clearTimeout(thinkingWatchdogRef.current);
      thinkingWatchdogRef.current = null;
    }
  }, []);

  const scheduleThinkingWatchdog = useCallback(() => {
    clearThinkingWatchdog();
    const startedAt = Date.now();
    thinkingWatchdogStartedAt.current = startedAt;
    thinkingWatchdogRef.current = setTimeout(() => {
      if (thinkingWatchdogStartedAt.current !== startedAt) return;
      console.warn('[VoiceCall] thinking state timed out; returning to listening');
      setCallState(prev => {
        if (prev !== 'thinking') return prev;
        return isCallActive.current ? 'listening' : 'idle';
      });
      thinkingWatchdogRef.current = null;
    }, THINKING_WATCHDOG_MS);
  }, [clearThinkingWatchdog]);

  const updateAudioLevel = useCallback(() => {
    if (!analyser.current) return;
    const dataArray = new Uint8Array(analyser.current.frequencyBinCount);
    analyser.current.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    setAudioLevel(rms);
    animationFrame.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  // Play audio buffer queue
  const playNextInQueue = useCallback(() => {
    if (isPlaying.current || pendingAudio.current.length === 0) return;

    const buffer = pendingAudio.current.shift()!;
    console.log('[VoiceCall] Playing audio chunk, size:', buffer.byteLength, 'remaining:', pendingAudio.current.length);
    isPlaying.current = true;

    if (!audioQueueContext.current) {
      audioQueueContext.current = new AudioContext();
      // Resume if suspended by autoplay policy
      if (audioQueueContext.current.state === 'suspended') {
        audioQueueContext.current.resume();
      }
      console.log('[VoiceCall] Created AudioContext, state:', audioQueueContext.current.state);
    }

    // Ensure context is running before decoding
    if (audioQueueContext.current.state === 'suspended') {
      audioQueueContext.current.resume();
    }

    audioQueueContext.current.decodeAudioData(buffer.slice(0), (decoded) => {
      console.log('[VoiceCall] Audio decoded, duration:', decoded.duration, 'sampleRate:', decoded.sampleRate);
      if (playbackSource.current) {
        try { playbackSource.current.stop(); } catch {}
      }

      const source = audioQueueContext.current!.createBufferSource();
      source.buffer = decoded;
      source.connect(audioQueueContext.current!.destination);
      playbackSource.current = source;

      source.onended = () => {
        console.log('[VoiceCall] Playback ended');
        isPlaying.current = false;
        playbackStartTime.current = 0;
        playbackSource.current = null;
        if (pendingAudio.current.length > 0) {
          playNextInQueue();
        }
      };

      source.start(0);
      playbackStartTime.current = Date.now();
      console.log('[VoiceCall] Playback started, interrupt enabled in 1.5s');
    }, (err) => {
      console.error('[VoiceCall] Decode failed:', err);
      isPlaying.current = false;
      playbackStartTime.current = 0;
      if (pendingAudio.current.length > 0) playNextInQueue();
    });
  }, []);

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const isTtsPlaying = useRef(false);
  const isCallActive = useRef(false);
  const playbackStartTime = useRef(0);
  // Streaming TTS: pre-buffer and cross-fade to eliminate gaps between chunks
  const ttsContext = useRef<AudioContext | null>(null);
  const ttsGainNode = useRef<GainNode | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const nextStartTime = useRef(0);  // When the next chunk should start playing
  const pendingDecodes = useRef(0);

  const ensureTtsContext = useCallback(() => {
    if (!ttsContext.current) {
      ttsContext.current = new AudioContext();
      ttsGainNode.current = ttsContext.current.createGain();
      ttsGainNode.current.connect(ttsContext.current.destination);
      if (ttsContext.current.state === 'suspended') {
        ttsContext.current.resume();
      }
      nextStartTime.current = 0;
    }
    return ttsContext.current;
  }, []);

  const stopAllPlayback = useCallback(() => {
    // Stop queue-based playback
    if (playbackSource.current) {
      try { playbackSource.current.stop(); } catch {}
      playbackSource.current = null;
    }
    pendingAudio.current = [];
    isPlaying.current = false;
    playbackStartTime.current = 0;
    // Clear sentence audio queue
    audioQueue.current = [];
    ttsPreRollChunks.current = [];
    flushTtsPreRollOnNextAudio.current = false;
    // Stop direct Audio element
    if (audioElementRef.current) {
      try {
        audioElementRef.current.pause();
        URL.revokeObjectURL(audioElementRef.current.src);
      } catch {}
      audioElementRef.current = null;
    }
    // Stop proactive speech (greetings, check-ins) — now interruptible
    if (proactiveSource.current) {
      try { proactiveSource.current.stop(); } catch {}
      proactiveSource.current = null;
    }
    if (proactiveContext.current) {
      try { proactiveContext.current.close(); } catch {}
      proactiveContext.current = null;
    }
    // Stop currently playing TTS source
    if (ttsSourceRef.current) {
      try { ttsSourceRef.current.stop(); } catch {}
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
  }, []);

  const cleanupCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      try { scriptProcessorRef.current.disconnect(); } catch {}
      scriptProcessorRef.current = null;
    }
    if (audioContext.current) {
      void audioContext.current.close().catch(() => {});
      audioContext.current = null;
    }
    if (timerInterval.current) {
      clearInterval(timerInterval.current);
      timerInterval.current = null;
    }
    cancelAnimationFrame(animationFrame.current);
    analyser.current = null;
  }, []);

  const audioQueue = useRef<Array<ArrayBuffer | { buffer: ArrayBuffer; volumeGain?: number }>>([]);

  useEffect(() => {
    if (!socket) return;

    const onAudioStatus = (data: { status: string }) => {
      if (!isCallActive.current) return;
      const map: Record<string, CallState> = {
        listening: 'listening',
        thinking: 'thinking',
        speaking: 'speaking',
        queued: 'queued',
        idle: 'idle',
        passive: 'passive',
      };
      const next = map[data.status] || 'idle';
      if (next === 'thinking') scheduleThinkingWatchdog();
      else clearThinkingWatchdog();
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
    };

    // Voice confirmation window — show recognized text during the 600ms delay
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
    const playAudioChunk = (buffer: ArrayBuffer, volumeGain?: number) => {
      if (!isCallActive.current) return;
      const ctx = ensureTtsContext();
      isTtsPlaying.current = true;
      if (ttsStartedAt.current === 0) ttsStartedAt.current = Date.now();
      clearThinkingWatchdog();
      setCallState(prev => (prev === 'thinking' || prev === 'queued') ? 'speaking' : prev);

      ctx.decodeAudioData(buffer.slice(0), (decoded) => {
        if (!isCallActive.current) return;
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
          ttsSourceRef.current = null;
          // Check if more chunks are queued
          if (audioQueue.current.length > 0) {
            const next = audioQueue.current.shift()!;
            const nextGain = typeof next === 'object' ? (next as any).volumeGain : undefined;
            const nextBuffer = typeof next === 'object' ? (next as any).buffer : next;
            playAudioChunk(nextBuffer, nextGain);
          } else {
            isTtsPlaying.current = false;
            setCallState(prev => prev === 'speaking' ? 'listening' : prev);
          }
        };

        source.start(effectiveStart);
      }, (err) => {
        console.error('[VoiceCall] Decode failed:', err);
        isTtsPlaying.current = false;
        if (audioQueue.current.length > 0) {
          const next = audioQueue.current.shift()!;
          const nextBuffer = typeof next === 'object' ? (next as any).buffer : next;
          playAudioChunk(nextBuffer);
        }
      });
    };

    // Handle both old format (raw ArrayBuffer) and new format ({ buffer, volumeGain })
    const onAudioResponse = (data: ArrayBuffer | { buffer: ArrayBuffer; volumeGain?: number }) => {
      if (!isCallActive.current) { console.log('[VoiceCall] Ignoring audio:response, call ended'); return; }
      const actualBuffer = data instanceof ArrayBuffer ? data : data.buffer;
      const actualGain = data instanceof ArrayBuffer ? undefined : data.volumeGain;

      if (isTtsPlaying.current) {
        // Currently playing — queue this chunk
        audioQueue.current.push(data instanceof ArrayBuffer ? data : { buffer: actualBuffer, volumeGain: actualGain });
        return;
      }
      playAudioChunk(actualBuffer, actualGain);
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

    const onAgentResponse = (data: { text: string }) => {
      if (!isCallActive.current) return;
      setTranscript(''); // Clear user transcript when AI starts responding
      setResponseText(data.text);
      onResponse?.(data.text);
    };

    const onAudioError = (data: { message: string }) => {
      if (!isCallActive.current) return;
      callGenerationRef.current++;
      isCallActive.current = false;
      activeStartPayload.current = null;
      setError(data.message);
      clearThinkingWatchdog();
      cleanupCapture();
      stopAllPlayback();
      transcriptionOnlyRef.current = false;
      setCallState('idle');
    };

    const onAudioInterruptAck = () => {
      clearThinkingWatchdog();
      stopAllPlayback();
      setCallState('listening');
    };

    const onAudioProactiveSpeak = (data: { audioBuffer: ArrayBuffer; text: string; timestamp: string }) => {
      try {
        // Stop any currently-playing proactive speech before starting new one
        if (proactiveSource.current) {
          try { proactiveSource.current.stop(); } catch {}
          proactiveSource.current = null;
        }
        if (proactiveContext.current) {
          try { proactiveContext.current.close(); } catch {}
          proactiveContext.current = null;
        }
        isTtsPlaying.current = true;
        const ctx = new AudioContext();
        proactiveContext.current = ctx;
        ctx.decodeAudioData(data.audioBuffer.slice(0), (decoded) => {
          const source = ctx.createBufferSource();
          proactiveSource.current = source;
          source.buffer = decoded;
          source.connect(ctx.destination);
          source.onended = () => {
            proactiveSource.current = null;
            proactiveContext.current = null;
            isTtsPlaying.current = false;
            ctx.close();
          };
          source.start(0);
        }, () => {
          proactiveSource.current = null;
          proactiveContext.current = null;
          isTtsPlaying.current = false;
          ctx.close();
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
    socket.on('audio:proactive_speak', onAudioProactiveSpeak);

    return () => {
      socket.off('audio:status', onAudioStatus);
      socket.off('audio:confirm', onAudioConfirm);
      socket.off('audio:response', onAudioResponse);
      socket.off('audio:transcript', onAudioTranscript);
      socket.off('agent:response', onAgentResponse);
      socket.off('audio:error', onAudioError);
      socket.off('audio:interrupt-ack', onAudioInterruptAck);
      socket.off('audio:proactive_speak', onAudioProactiveSpeak);
      clearThinkingWatchdog();
    };
  }, [socket, onTranscript, onResponse, stopAllPlayback, cleanupCapture, clearThinkingWatchdog, scheduleThinkingWatchdog]);

  useEffect(() => {
    if (!socket) return;
    const onDisconnect = () => {
      if (!isCallActive.current) return;
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

  // Music coexistence: duck only while a voice turn is active so music can
  // recover between utterances without covering speech.
  useEffect(() => {
    const prev = musicDuckingRef.current;
    const userSpeaking =
      callState === 'listening' &&
      (prev.active && prev.level === 0.32 ? audioLevel > 0.018 : audioLevel > 0.035);
    const level =
      callState === 'speaking' ? 0.18 :
      callState === 'thinking' ? 0.22 :
      callState === 'queued' ? 0.28 :
      callState === 'connecting' ? 0.35 :
      userSpeaking ? 0.32 :
      null;
    const active = typeof level === 'number';
    if (prev.active === active && prev.level === level) return;
    musicDuckingRef.current = { active, level };
    window.dispatchEvent(new CustomEvent('lumi:music-ducking', {
      detail: {
        reason: 'voice-call',
        active,
        level: level ?? undefined,
      },
    }));
  }, [callState, audioLevel]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent('lumi:music-ducking', {
        detail: { reason: 'voice-call', active: false },
      }));
    };
  }, []);

  const startCall = useCallback(async (voiceId?: string, personalityId: string = 'lumi', agentId?: string, options: StartCallOptions = {}) => {
    if (isCallActive.current || startInFlightRef.current) return;
    const generation = ++callGenerationRef.current;
    startInFlightRef.current = true;
    try {
      setError(null);
      setCallState('connecting');
      transcriptionOnlyRef.current = options.transcriptionOnly === true;

      const activeSocket = socketRef.current;
      await waitForVoiceSocket(activeSocket);
      if (generation !== callGenerationRef.current) return;

      const stream = await requestMicrophoneStream({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (generation !== callGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;

      // Set up audio level monitoring at the realtime STT sample rate.
      audioContext.current = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.current.createMediaStreamSource(stream);
      analyser.current = audioContext.current.createAnalyser();
      analyser.current.fftSize = 256;
      source.connect(analyser.current);
      updateAudioLevel();

      // Set up ScriptProcessorNode to capture raw PCM (linear16) for realtime STT.
      const bufferSize = 4096;
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

        // While Lumi is speaking, keep a tiny pre-roll instead of streaming
        // speaker echo into STT. If the owner truly barges in, we flush this
        // short tail after playback stops so the first words are less likely
        // to be clipped.
        if (isTtsPlaying.current) {
          ttsPreRollChunks.current.push(chunk);
          if (ttsPreRollChunks.current.length > 6) ttsPreRollChunks.current.shift();
          return;
        }

        const micAllowed = transcriptionOnlyRef.current || (canSendMicAudioRef.current?.() ?? true);
        if (!micAllowed) {
          ttsPreRollChunks.current = [];
          flushTtsPreRollOnNextAudio.current = false;
          return;
        }

        if (!transcriptionOnlyRef.current && callStateRef.current === 'passive' && frameRms < 0.004) {
          const now = Date.now();
          if (now - lastPassiveSilenceKeepAlive.current < 1500) return;
          lastPassiveSilenceKeepAlive.current = now;
        }

        if (flushTtsPreRollOnNextAudio.current && ttsPreRollChunks.current.length > 0) {
          for (const preRollChunk of ttsPreRollChunks.current) {
            currentSocket.emit('audio:chunk', preRollChunk);
          }
          ttsPreRollChunks.current = [];
          flushTtsPreRollOnNextAudio.current = false;
        }

        currentSocket.emit('audio:chunk', chunk);
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
      timerInterval.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - callStartTime.current) / 1000));
      }, 1000);
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
      isCallActive.current = false;
      transcriptionOnlyRef.current = false;
      setError(err.message || 'Failed to start voice call');
      setCallState('idle');
    } finally {
      startInFlightRef.current = false;
    }
  }, [cleanupCapture, updateAudioLevel]);

  const startCallRef = useRef(startCall);
  startCallRef.current = startCall;

  const interrupt = useCallback(() => {
    if (callState === 'speaking' || callState === 'thinking') {
      socket?.emit('audio:interrupt');
      stopAllPlayback();
    }
  }, [socket, callState, stopAllPlayback]);

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
    stopAllPlayback();
    cleanupCapture();

    isTtsPlaying.current = false;
    transcriptionOnlyRef.current = false;
    ttsStartedAt.current = 0;
    setIsMuted(false);
    setElapsedSeconds(0);

    setCallState('idle');
    setAudioLevel(0);
  }, [cleanupCapture, stopAllPlayback, clearPassiveTimers, clearThinkingWatchdog]);

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
    cleanupCapture();
    stopAllPlayback();
  }, [cleanupCapture, stopAllPlayback]);

  // Barge-in: detect user speaking over TTS via audio level.
  // After TTS starts, wait 400ms before enabling barge-in so Lumi's own
  // voice from external speakers doesn't trigger a self-interrupt.
  const ttsStartedAt = useRef(0);
  useEffect(() => {
    if (isTtsPlaying.current && ttsStartedAt.current === 0) {
      ttsStartedAt.current = Date.now();
    } else if (!isTtsPlaying.current) {
      ttsStartedAt.current = 0;
    }
  }, [callState]);

  useEffect(() => {
    const threshold = 0.12;
    const minTtsDuration = 500; // ms — ignore barge-in during first 500ms of TTS
    if (
      audioLevel > threshold &&
      isTtsPlaying.current &&
      (callState === 'speaking' || callState === 'thinking') &&
      ttsStartedAt.current > 0 &&
      Date.now() - ttsStartedAt.current > minTtsDuration
    ) {
      if (!(canInterruptFromVoiceRef.current?.() ?? true)) return;
      const preRoll = [...ttsPreRollChunks.current];
      socket?.emit('audio:interrupt');
      stopAllPlayback();
      ttsPreRollChunks.current = preRoll;
      flushTtsPreRollOnNextAudio.current = true;
      ttsStartedAt.current = 0;
      setCallState('listening');
    }
  }, [audioLevel, callState, socket, stopAllPlayback]);

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
        rms: audioLevel,
        isSpeaking: isTtsPlaying.current,
        callState,
        timestamp: new Date().toISOString(),
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [socket, callState, audioLevel]);

  return {
    callState,
    audioLevel,
    error,
    transcript,
    responseText,
    isMuted,
    elapsedSeconds,
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
