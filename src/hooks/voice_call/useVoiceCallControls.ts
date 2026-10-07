import { useRef, useCallback, useEffect } from "react";
import { claimVoiceCapture, releaseVoiceCapture } from "@/lib/voiceCaptureLease";
import { applyPreferredVoiceOutputDevice, VOICE_DEVICE_PREFERENCE_CHANGED } from "@/lib/voiceDevicePreferences";
import type { useVoiceSocketEvents } from './useVoiceSocketEvents';
import type { StartCallOptions, VoiceStartPayload } from './contracts';
import { normalizeSelectedVoiceId, waitForVoiceSocket, createVoiceSessionId, prepareVoiceSwitch } from './protocol';

export function useVoiceCallControls(previousBindings: ReturnType<typeof useVoiceSocketEvents>) {
  const { disabled, socket, isCallActive, activeVoiceRequestIdRef, playbackRequestIdRef, activeWorkRequestIdRef, audioQueue, cancelledVoiceRequestsRef, pendingInterruptRef, setConnectionQuality, setCallState, clearThinkingWatchdog, stopAllPlayback, activeStartPayload, privateCapture, callState, startInFlightRef, captureLeaseToken, endCall, preferredVoiceIdRef, callGenerationRef, setError, transcriptionOnlyRef, ensureTtsContext, socketRef, installMicrophoneCapture, callStartTime, cleanupCapture, disposePlaybackContexts, recoverMicrophoneCapture, captureRecoveryTimerRef, ttsContext, proactiveContext, isTtsPlaying, callStateRef, playbackGenerationRef, setIsMuted, isMutedRef, streamRef, ttsStartedAt, ttsEchoFloorRef, ttsBargeInFramesRef, ttsBargeInCandidateSentRef, privateCaptureRef, rawAudioLevelRef, hasConversationPlayback } = previousBindings;


  useEffect(() => {
    if (disabled || !socket) return;
    const onDisconnect = () => {
      if (!isCallActive.current) return;
      for (const id of [activeVoiceRequestIdRef.current, playbackRequestIdRef.current, activeWorkRequestIdRef.current, ...audioQueue.current.map(chunk => chunk instanceof ArrayBuffer ? undefined : chunk.requestId)]) {
        if (id) cancelledVoiceRequestsRef.current.add(id);
      }
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      pendingInterruptRef.current = null;
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
  }, [disabled, socket, clearThinkingWatchdog, stopAllPlayback, isCallActive, activeVoiceRequestIdRef, activeWorkRequestIdRef, pendingInterruptRef, setConnectionQuality, setCallState, playbackRequestIdRef, audioQueue, cancelledVoiceRequestsRef, activeStartPayload]);

  // Push audio emotion perception events when call state changes
  useEffect(() => {
    if (privateCapture || disabled || !socket?.connected || callState === 'idle' || callState === 'connecting') return;
    const emotionMap: Record<string, { emotion: string; intensity: number }> = {
      listening: { emotion: 'attentive', intensity: 0.4 },
      thinking: { emotion: 'focused', intensity: 0.6 },
      speaking: { emotion: 'engaged', intensity: 0.7 },
    };
    const entry = emotionMap[callState];
    if (entry) {
      socket.emit('perception:audio_emotion', entry);
    }
  }, [callState, disabled, privateCapture, socket]);

  const startCall = useCallback(async (voiceId?: string, personalityId: string = 'lumi', agentId?: string, options: StartCallOptions = {}) => {
    if (disabled) return;
    if (isCallActive.current || startInFlightRef.current) return;
    claimVoiceCapture(captureLeaseToken.current, endCall);
    const requestedVoiceId = normalizeSelectedVoiceId(voiceId);
    if (voiceId !== undefined) preferredVoiceIdRef.current = requestedVoiceId;
    const generation = ++callGenerationRef.current;
    startInFlightRef.current = true;
    try {
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      pendingInterruptRef.current = null;
      setError(null);
      setCallState('connecting');
      transcriptionOnlyRef.current = options.transcriptionOnly === true;

      // Create the output context while the start action still has a user
      // activation.  Waiting until the model responds can make WebView2 keep
      // a newly-created AudioContext suspended, which looks like a successful
      // transcription with a silent assistant reply.
      try {
        const playbackContext = ensureTtsContext();
        if (playbackContext.state === 'suspended' || (playbackContext.state as string) === 'interrupted') {
          void playbackContext.resume().catch(() => {});
        }
      } catch (error) {
        // Keep STT usable if a platform does not expose Web Audio; the audio
        // lane will report its own failure when a reply needs playback.
        console.warn('[VoiceCall] Could not prewarm TTS audio context:', error);
      }

      const activeSocket = socketRef.current;
      await waitForVoiceSocket(activeSocket);
      if (generation !== callGenerationRef.current) return;

      await installMicrophoneCapture(generation);
      if (generation !== callGenerationRef.current) return;

      isCallActive.current = true;
      callStartTime.current = Date.now();
      const captureSessionId = createVoiceSessionId();
      const startPayload: VoiceStartPayload = {
        voiceId: preferredVoiceIdRef.current || requestedVoiceId,
        personalityId,
        agentId,
        conversationId: options.conversationId,
        transcriptionOnly: options.transcriptionOnly === true,
        meetingId: options.transcriptionOnly ? options.meetingId : undefined,
        domain: options.domain || 'personal',
        orgId: options.domain === 'work' ? options.orgId : undefined,
        sessionId: captureSessionId,
        audioInputKind: 'physical_microphone',
        captureSessionId,
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
      disposePlaybackContexts();
      releaseVoiceCapture(captureLeaseToken.current);
      setError(err.message || 'Failed to start voice call');
      setCallState('idle');
    } finally {
      startInFlightRef.current = false;
    }
  }, [activeStartPayload, activeVoiceRequestIdRef, activeWorkRequestIdRef, callGenerationRef, callStartTime, captureLeaseToken, cleanupCapture, disabled, disposePlaybackContexts, endCall, ensureTtsContext, installMicrophoneCapture, isCallActive, pendingInterruptRef, preferredVoiceIdRef, setCallState, setError, socketRef, startInFlightRef, transcriptionOnlyRef]);

  const switchVoice = useCallback((voiceId?: string): boolean => {
    const normalizedVoiceId = normalizeSelectedVoiceId(voiceId);
    if (!normalizedVoiceId) return false;
    preferredVoiceIdRef.current = normalizedVoiceId;

    const transition = prepareVoiceSwitch(activeStartPayload.current, normalizedVoiceId);
    if (!isCallActive.current || !transition) return false;
    activeStartPayload.current = transition.nextPayload;
    if (transition.event && socketRef.current?.connected) {
      socketRef.current.emit('audio:switch-voice', transition.event);
    }
    return true;
  }, [activeStartPayload, isCallActive, preferredVoiceIdRef, socketRef]);

  useEffect(() => {
    if (disabled) return;
    const timer = setInterval(() => {
      void recoverMicrophoneCapture(false);
    }, 1_000);
    captureRecoveryTimerRef.current = timer;
    return () => {
      clearInterval(timer);
      if (captureRecoveryTimerRef.current === timer) captureRecoveryTimerRef.current = null;
    };
  }, [captureRecoveryTimerRef, disabled, recoverMicrophoneCapture]);

  useEffect(() => {
    const applyDevicePreference = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: 'input' | 'output' }>).detail;
      if (detail?.kind === 'input') {
        void recoverMicrophoneCapture(true);
        return;
      }
      if (ttsContext.current) void applyPreferredVoiceOutputDevice(ttsContext.current);
      if (proactiveContext.current) void applyPreferredVoiceOutputDevice(proactiveContext.current);
    };
    window.addEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, applyDevicePreference);
    return () => window.removeEventListener(VOICE_DEVICE_PREFERENCE_CHANGED, applyDevicePreference);
  }, [proactiveContext, recoverMicrophoneCapture, ttsContext]);

  const startCallRef = useRef(startCall);
  startCallRef.current = startCall;

  const interrupt = useCallback(() => {
    if (!isCallActive.current) return;
    if (!isTtsPlaying.current && audioQueue.current.length === 0
      && !['speaking', 'thinking', 'queued'].includes(callStateRef.current)
      && !activeVoiceRequestIdRef.current && !activeWorkRequestIdRef.current) return;
    const requestId = activeVoiceRequestIdRef.current || playbackRequestIdRef.current || activeWorkRequestIdRef.current || undefined;
    for (const id of [requestId, playbackRequestIdRef.current, ...audioQueue.current.map(chunk => chunk instanceof ArrayBuffer ? undefined : chunk.requestId)]) {
      if (id) cancelledVoiceRequestsRef.current.add(id);
    }
    stopAllPlayback();
    pendingInterruptRef.current = { requestId, generation: playbackGenerationRef.current };
    socketRef.current?.emit('audio:interrupt', { source: 'user_control', sessionId: activeStartPayload.current?.sessionId, requestId });
  }, [activeStartPayload, activeVoiceRequestIdRef, activeWorkRequestIdRef, audioQueue, callStateRef, cancelledVoiceRequestsRef, isCallActive, isTtsPlaying, pendingInterruptRef, playbackGenerationRef, playbackRequestIdRef, socketRef, stopAllPlayback]);

  useEffect(() => {
    const stopVoiceOutput = () => {
      if (isCallActive.current) interrupt();
      else stopAllPlayback();
    };
    window.addEventListener('lumi:stop-voice-output', stopVoiceOutput);
    return () => window.removeEventListener('lumi:stop-voice-output', stopVoiceOutput);
  }, [interrupt, isCallActive, stopAllPlayback]);

  const switchPersonality = useCallback((personalityId: string) => {
    if (callState !== 'idle') {
      socket?.emit('audio:switch-personality', { personalityId });
    }
  }, [socket, callState]);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      isMutedRef.current = next;
      if (streamRef.current) {
        streamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
      }
      return next;
    });
  }, [isMutedRef, setIsMuted, streamRef]);

  useEffect(() => () => {
    releaseVoiceCapture(captureLeaseToken.current);
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
  }, [activeStartPayload, activeVoiceRequestIdRef, activeWorkRequestIdRef, callGenerationRef, captureLeaseToken, cleanupCapture, disposePlaybackContexts, isCallActive, socketRef]);

  // Track the beginning of each TTS utterance. Audio-frame processing above
  // uses this timestamp to learn an adaptive echo floor and detect barge-in.
  useEffect(() => {
    if (isTtsPlaying.current && ttsStartedAt.current === 0) {
      ttsStartedAt.current = Date.now();
    } else if (!isTtsPlaying.current) {
      ttsStartedAt.current = 0;
      ttsEchoFloorRef.current = 0;
      ttsBargeInFramesRef.current = 0;
      ttsBargeInCandidateSentRef.current = false;
    }
  }, [callState, isTtsPlaying, ttsBargeInCandidateSentRef, ttsBargeInFramesRef, ttsEchoFloorRef, ttsStartedAt]);

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
  }, [socket, callState, setConnectionQuality]);

  // Report ambient noise level to server every 5s for environment-aware behavior
  useEffect(() => {
    if (!socket || callState === 'idle') return;
    const interval = setInterval(() => {
      if (privateCaptureRef.current) return;
      socket.emit('ambient:noise_level', {
        rms: rawAudioLevelRef.current,
        isSpeaking: isTtsPlaying.current,
        callState,
        timestamp: new Date().toISOString(),
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [socket, callState, privateCaptureRef, rawAudioLevelRef, isTtsPlaying]);

  return {
    ...previousBindings, callState: hasConversationPlayback && isCallActive.current && callState !== 'connecting' ? 'speaking' as const : callState,
    audioLevel: 0,
    elapsedSeconds: isCallActive.current && callStartTime.current > 0
      ? Math.floor((Date.now() - callStartTime.current) / 1000)
      : 0,
    inputLevelRef: rawAudioLevelRef, startCall, startCallRef, switchVoice, interrupt, toggleMute, switchPersonality, clearError: () => setError(null)
  };
}
