import { useState, useRef, useCallback, useEffect } from "react";
import { applyPreferredVoiceOutputDevice } from "@/lib/voiceDevicePreferences";
import type { UseVoiceCallOptions, CallState, VoiceStartPayload } from './contracts';
import { THINKING_WATCHDOG_MS } from './protocol';

export function useVoiceSessionState({
  socket,
  onTranscript,
  onResponse,
  canSendMicAudio,
  disabled = false,
  privateCapture = false,
  proactive,
}: UseVoiceCallOptions) {

  const proactiveContextRef = useRef<{ contextId: string; userId: string; domain: string; orgId: string; enabled: boolean } | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  // Server readiness and local output have independent lifetimes. Decoding or
  // queued audio still owns the stop button after the server returns to STT.
  const [hasConversationPlayback, setHasConversationPlayback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [responseText, setResponseText] = useState<string>('');
  const [isMuted, setIsMuted] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState<'good' | 'fair' | 'poor'>('good');

  const audioContext = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rawAudioLevelRef = useRef(0);
  const outputLevelRef = useRef(0);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputMeterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureLeaseToken = useRef(Symbol('voice-capture'));
  const privateCaptureRef = useRef(privateCapture);
  privateCaptureRef.current = privateCapture;
  const proactiveSource = useRef<AudioBufferSourceNode | null>(null);
  const proactiveContext = useRef<AudioContext | null>(null);
  const proactiveStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proactivePlaybackGenerationRef = useRef(0);
  const callStartTime = useRef<number>(0);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const passiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevCallState = useRef<CallState>('idle');
  const transcriptionOnlyRef = useRef(false);
  const canSendMicAudioRef = useRef(canSendMicAudio);
  const ttsEchoFloorRef = useRef(0);
  const ttsBargeInFramesRef = useRef(0);
  const ttsBargeInCandidateSentRef = useRef(false);
  const thinkingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingWatchdogStartedAt = useRef(0);
  const callStateRef = useRef<CallState>('idle');
  const lastPassiveSilenceKeepAlive = useRef(0);
  const activeStartPayload = useRef<VoiceStartPayload | null>(null);
  const preferredVoiceIdRef = useRef<string | undefined>(undefined);
  const activeVoiceRequestIdRef = useRef<string | null>(null);
  const activeWorkRequestIdRef = useRef<string | null>(null);
  const socketRef = useRef(socket);
  const callGenerationRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  const playbackRequestIdRef = useRef<string | null>(null);
  const cancelledVoiceRequestsRef = useRef(new Set<string>());
  const pendingInterruptRef = useRef<{ requestId?: string; generation: number } | null>(null);
  const startInFlightRef = useRef(false);
  const isMutedRef = useRef(false);
  const lastCaptureFrameAtRef = useRef(0);
  const captureRecoveryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureRecoveryInFlightRef = useRef(false);

  useEffect(() => { canSendMicAudioRef.current = canSendMicAudio; }, [canSendMicAudio]);
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  const clearThinkingWatchdog = useCallback(() => {
    if (thinkingWatchdogRef.current) {
      clearTimeout(thinkingWatchdogRef.current);
      thinkingWatchdogRef.current = null;
    }
  }, []);

  const isCallActive = useRef(false);
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
  const isConversationTtsPlaying = useRef(false);
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
      const analyser = ttsContext.current.createAnalyser?.();
      if (analyser) {
        analyser.fftSize = 256;
        outputAnalyserRef.current = analyser;
        ttsGainNode.current.connect(analyser);
        analyser.connect(ttsContext.current.destination);
        const samples = new Uint8Array(analyser.fftSize);
        if (outputMeterTimerRef.current) clearInterval(outputMeterTimerRef.current);
        outputMeterTimerRef.current = setInterval(() => {
          if (outputAnalyserRef.current !== analyser || !isConversationTtsPlaying.current) { outputLevelRef.current = 0; return; }
          analyser.getByteTimeDomainData(samples);
          let total = 0;
          for (const sample of samples) total += ((sample - 128) / 128) ** 2;
          outputLevelRef.current = Math.min(1, Math.sqrt(total / samples.length));
        }, 50);
      } else ttsGainNode.current.connect(ttsContext.current.destination);
      nextStartTime.current = 0;
    }
    return ttsContext.current;
  }, []);
  return {
    playbackGenerationRef, playbackRequestIdRef, setHasConversationPlayback, outputLevelRef,
    proactivePlaybackGenerationRef, playbackStartTime, proactiveStateTimerRef, proactiveSource, proactiveContext,
    ttsSourceRef, ttsContext, nextStartTime, ttsGainNode, isTtsPlaying, isConversationTtsPlaying, ttsStartedAt,
    ttsEchoFloorRef, ttsBargeInFramesRef, ttsBargeInCandidateSentRef, outputMeterTimerRef, outputAnalyserRef, socket,
    disabled, privateCapture, proactive, isCallActive, setCallState, isMutedRef, proactiveContextRef, isMuted,
    privateCaptureRef, streamRef, scriptProcessorRef, audioContext, rawAudioLevelRef, lastCaptureFrameAtRef,
    callGenerationRef, socketRef, transcriptionOnlyRef, canSendMicAudioRef, callStateRef,
    lastPassiveSilenceKeepAlive, captureRecoveryInFlightRef, setError, passiveTimer, disconnectTimer,
    captureLeaseToken, clearThinkingWatchdog, activeStartPayload, activeVoiceRequestIdRef, activeWorkRequestIdRef,
    cancelledVoiceRequestsRef, setIsMuted, scheduleThinkingWatchdog, prevCallState, setTranscript, onTranscript,
    ensureTtsContext, setResponseText, onResponse, preferredVoiceIdRef, pendingInterruptRef, setConnectionQuality,
    callState, startInFlightRef, callStartTime, captureRecoveryTimerRef, hasConversationPlayback, error, transcript,
    responseText, connectionQuality
  } as const;
}
