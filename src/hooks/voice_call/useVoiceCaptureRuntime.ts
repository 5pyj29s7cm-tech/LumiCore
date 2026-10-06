import { useRef, useCallback, useEffect } from "react";
import { releaseVoiceCapture, hasVoiceCapture, subscribeVoiceCapture } from "@/lib/voiceCaptureLease";
import { closeAudioContext } from "@/lib/audioContextLifecycle";
import { classifyVoiceCaptureHealth, VOICE_CAPTURE_STALL_MS } from "@/lib/voiceCaptureRecovery";
import { requestPreferredMicrophoneStream } from "@/lib/voiceDevicePreferences";
import type { useVoiceSessionState } from './useVoiceSessionState';
import type { VoiceAudioResponse, EndCallOptions } from './contracts';
import { releaseAudioBufferSource } from './playback';
import { createVoiceSessionId, normalizeSelectedVoiceId } from './protocol';

export function useVoiceCaptureRuntime(previousBindings: ReturnType<typeof useVoiceSessionState>) {
  const { playbackGenerationRef, playbackRequestIdRef, setHasConversationPlayback, outputLevelRef, proactivePlaybackGenerationRef, playbackStartTime, proactiveStateTimerRef, proactiveSource, proactiveContext, ttsSourceRef, ttsContext, nextStartTime, ttsGainNode, isTtsPlaying, isConversationTtsPlaying, ttsStartedAt, ttsEchoFloorRef, ttsBargeInFramesRef, ttsBargeInCandidateSentRef, outputMeterTimerRef, outputAnalyserRef, socket, disabled, privateCapture, proactive, isCallActive, setCallState, isMutedRef, proactiveContextRef, isMuted, privateCaptureRef, streamRef, scriptProcessorRef, audioContext, rawAudioLevelRef, lastCaptureFrameAtRef, callGenerationRef, socketRef, transcriptionOnlyRef, canSendMicAudioRef, callStateRef, lastPassiveSilenceKeepAlive, captureRecoveryInFlightRef, setError, passiveTimer, disconnectTimer, captureLeaseToken, clearThinkingWatchdog, activeStartPayload, activeVoiceRequestIdRef, activeWorkRequestIdRef, cancelledVoiceRequestsRef, setIsMuted } = previousBindings;


  const audioQueue = useRef<Array<ArrayBuffer | VoiceAudioResponse>>([]);
  const stopAllPlayback = useCallback(() => {
    playbackGenerationRef.current++;
    playbackRequestIdRef.current = null;
    setHasConversationPlayback(false);
    outputLevelRef.current = 0;
    proactivePlaybackGenerationRef.current++;
    playbackStartTime.current = 0;
    // Clear sentence audio queue
    audioQueue.current = [];
    if (proactiveStateTimerRef.current) {
      clearTimeout(proactiveStateTimerRef.current);
      proactiveStateTimerRef.current = null;
    }
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
    isConversationTtsPlaying.current = false;
    ttsStartedAt.current = 0;
    ttsEchoFloorRef.current = 0;
    ttsBargeInFramesRef.current = 0;
    ttsBargeInCandidateSentRef.current = false;
  }, [isConversationTtsPlaying, isTtsPlaying, nextStartTime, outputLevelRef, playbackGenerationRef, playbackRequestIdRef, playbackStartTime, proactiveContext, proactivePlaybackGenerationRef, proactiveSource, proactiveStateTimerRef, setHasConversationPlayback, ttsBargeInCandidateSentRef, ttsBargeInFramesRef, ttsContext, ttsEchoFloorRef, ttsGainNode, ttsSourceRef, ttsStartedAt]);

  const disposePlaybackContexts = useCallback(() => {
    stopAllPlayback();
    if (outputMeterTimerRef.current) clearInterval(outputMeterTimerRef.current);
    outputMeterTimerRef.current = null;
    try { outputAnalyserRef.current?.disconnect(); } catch {}
    outputAnalyserRef.current = null;
    const gain = ttsGainNode.current;
    ttsGainNode.current = null;
    try { gain?.disconnect(); } catch {}
    const context = ttsContext.current;
    ttsContext.current = null;
    nextStartTime.current = 0;
    void closeAudioContext(context);
  }, [nextStartTime, outputAnalyserRef, outputMeterTimerRef, stopAllPlayback, ttsContext, ttsGainNode]);

  useEffect(() => {
    if (!socket || disabled || privateCapture || !proactive?.userId) return;
    const stopProactive = () => {
      proactivePlaybackGenerationRef.current++;
      if (proactiveStateTimerRef.current) clearTimeout(proactiveStateTimerRef.current);
      proactiveStateTimerRef.current = null;
      releaseAudioBufferSource(proactiveSource.current, true);
      proactiveSource.current = null;
      void closeAudioContext(proactiveContext.current);
      proactiveContext.current = null;
      isTtsPlaying.current = isConversationTtsPlaying.current;
      if (!isCallActive.current) setCallState(current => current === 'speaking' ? 'idle' : current);
    };
    const publish = () => {
      stopProactive();
      const context = {
        contextId: createVoiceSessionId(), userId: proactive.userId,
        domain: proactive.domain, orgId: proactive.orgId || '',
        voiceId: normalizeSelectedVoiceId(proactive.voiceId),
        enabled: localStorage.getItem('lumi_allow_proactive_voice') === 'true'
          && !proactive.outputMuted && !isMutedRef.current && !hasVoiceCapture(),
      };
      proactiveContextRef.current = context;
      if (socket.connected) socket.emit('proactive:configure', context);
    };
    const onSetting = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (!key || key === 'lumi_allow_proactive_voice') publish();
    };
    const onDisconnect = () => { proactiveContextRef.current = null; stopProactive(); };
    publish();
    socket.on('connect', publish);
    socket.on('disconnect', onDisconnect);
    window.addEventListener('lumi:setting-changed', onSetting);
    const unsubscribe = subscribeVoiceCapture(publish);
    return () => {
      const old = proactiveContextRef.current;
      proactiveContextRef.current = null;
      stopProactive();
      if (socket.connected && old) socket.emit('proactive:configure', { ...old, enabled: false });
      socket.off('connect', publish);
      socket.off('disconnect', onDisconnect);
      window.removeEventListener('lumi:setting-changed', onSetting);
      unsubscribe();
    };
  }, [disabled, privateCapture, socket, proactive?.userId, proactive?.domain, proactive?.orgId, proactive?.voiceId, proactive?.outputMuted, isMuted, proactivePlaybackGenerationRef, proactiveStateTimerRef, proactiveSource, proactiveContext, isTtsPlaying, isConversationTtsPlaying, isCallActive, setCallState, isMutedRef, proactiveContextRef]);

  const cleanupCapture = useCallback(() => {
    if (typeof window !== 'undefined' && !privateCaptureRef.current) {
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
    lastCaptureFrameAtRef.current = 0;
  }, [audioContext, lastCaptureFrameAtRef, privateCaptureRef, rawAudioLevelRef, scriptProcessorRef, streamRef]);

  const installMicrophoneCapture = useCallback(async (
    generation: number,
    replaceExisting = false,
  ): Promise<void> => {
    const stream = await requestPreferredMicrophoneStream({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    if (generation !== callGenerationRef.current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    const nextContext = new AudioContext({ sampleRate: 16000 });
    try {
      stream.getAudioTracks().forEach(track => { track.enabled = !isMutedRef.current; });
      const source = nextContext.createMediaStreamSource(stream);
      // 128 ms frames keep realtime STT and spoken barge-in responsive while
      // remaining large enough to avoid excessive socket overhead.
      const scriptProcessor = nextContext.createScriptProcessor(2048, 1, 1);
      scriptProcessor.onaudioprocess = (event) => {
        lastCaptureFrameAtRef.current = Date.now();
        const currentSocket = socketRef.current;
        if (!currentSocket?.connected) return;
        const input = event.inputBuffer.getChannelData(0);
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
        if (!privateCaptureRef.current) window.dispatchEvent(new CustomEvent('lumi:voice-audio-level', {
          detail: { level: frameRms },
        }));

        // Keep realtime STT active while Lumi speaks. Browser echo cancellation
        // plus the server's recent-TTS matcher remove self speech; keeping this
        // lane open gives stop commands a semantic path even when the local
        // energy detector does not cross its threshold.
        if (isTtsPlaying.current) {
          currentSocket.volatile.emit('audio:chunk', chunk);

          const ttsAgeMs = ttsStartedAt.current > 0 ? Date.now() - ttsStartedAt.current : 0;
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
            if (ttsBargeInFramesRef.current > 0 && !transcriptionOnlyRef.current && !privateCaptureRef.current) {
              window.dispatchEvent(new CustomEvent('lumi:voice-pcm-frame', {
                detail: { samples: new Float32Array(input), rms: frameRms },
              }));
            }
            const strongSpeechFrame = frameRms > Math.max(0.045, adaptiveThreshold * 1.6);
            const sustainedCandidate = ttsBargeInFramesRef.current >= (strongSpeechFrame ? 3 : 5);
            if (sustainedCandidate && !ttsBargeInCandidateSentRef.current) {
              ttsBargeInCandidateSentRef.current = true;
              currentSocket.emit('audio:interrupt-candidate', {
                source: 'local_energy',
                rms: Number(frameRms.toFixed(4)),
                threshold: Number(adaptiveThreshold.toFixed(4)),
                frames: ttsBargeInFramesRef.current,
                ttsAgeMs,
              });
            }
          }
          return;
        }

        const micAllowed = transcriptionOnlyRef.current || (canSendMicAudioRef.current?.() ?? true);
        if (!micAllowed) return;

        if (!transcriptionOnlyRef.current && !privateCaptureRef.current) {
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
      const zeroGain = nextContext.createGain();
      zeroGain.gain.value = 0;
      scriptProcessor.connect(zeroGain);
      zeroGain.connect(nextContext.destination);

      if (replaceExisting) cleanupCapture();
      if (generation !== callGenerationRef.current) {
        scriptProcessor.onaudioprocess = null;
        try { scriptProcessor.disconnect(); } catch {}
        stream.getTracks().forEach(track => track.stop());
        void closeAudioContext(nextContext);
        return;
      }
      streamRef.current = stream;
      audioContext.current = nextContext;
      scriptProcessorRef.current = scriptProcessor;
      lastCaptureFrameAtRef.current = Date.now();
      if (!privateCaptureRef.current) window.dispatchEvent(new CustomEvent('lumi:voice-capture-state', { detail: { active: true } }));
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      void closeAudioContext(nextContext);
      throw error;
    }
  }, [audioContext, callGenerationRef, callStateRef, canSendMicAudioRef, cleanupCapture, isMutedRef, isTtsPlaying, lastCaptureFrameAtRef, lastPassiveSilenceKeepAlive, privateCaptureRef, rawAudioLevelRef, scriptProcessorRef, socketRef, streamRef, transcriptionOnlyRef, ttsBargeInCandidateSentRef, ttsBargeInFramesRef, ttsEchoFloorRef, ttsStartedAt]);

  const recoverMicrophoneCapture = useCallback(async (forceRestart = false): Promise<void> => {
    if (!isCallActive.current || captureRecoveryInFlightRef.current) return;
    const context = audioContext.current;
    const health = forceRestart ? 'restart_capture' : classifyVoiceCaptureHealth({
      callActive: isCallActive.current,
      trackStates: streamRef.current?.getAudioTracks().map(track => track.readyState) || [],
      audioContextState: context?.state || null,
      lastFrameAt: lastCaptureFrameAtRef.current,
      stallMs: VOICE_CAPTURE_STALL_MS,
    });
    if (health === 'inactive' || health === 'healthy') return;

    if (health === 'resume_context' && context) {
      try {
        await context.resume();
        if (context.state === 'running') {
          lastCaptureFrameAtRef.current = Date.now();
          return;
        }
      } catch {}
    }

    captureRecoveryInFlightRef.current = true;
    const generation = callGenerationRef.current;
    try {
      await installMicrophoneCapture(generation, true);
      if (generation === callGenerationRef.current && isCallActive.current) setError(null);
    } catch (captureError: any) {
      if (generation === callGenerationRef.current && isCallActive.current) {
        setError(captureError?.message || 'Microphone input was interrupted and could not be restored.');
      }
    } finally {
      captureRecoveryInFlightRef.current = false;
    }
  }, [audioContext, callGenerationRef, captureRecoveryInFlightRef, installMicrophoneCapture, isCallActive, lastCaptureFrameAtRef, setError, streamRef]);

  const clearPassiveTimers = useCallback(() => {
    if (passiveTimer.current) { clearTimeout(passiveTimer.current); passiveTimer.current = null; }
    if (disconnectTimer.current) { clearTimeout(disconnectTimer.current); disconnectTimer.current = null; }
  }, [disconnectTimer, passiveTimer]);

  const endCall = useCallback((options: EndCallOptions = {}) => {
    callGenerationRef.current++;
    releaseVoiceCapture(captureLeaseToken.current);
    isCallActive.current = false;
    clearPassiveTimers();
    clearThinkingWatchdog();
    const activeSocket = socketRef.current;
    activeSocket?.emit('audio:stop', {
      refineTranscript: options.refineTranscript === true,
      preserveMeeting: options.preserveMeeting === true,
      refinementId: options.refinementId,
      sessionId: activeStartPayload.current?.sessionId,
    });
    activeStartPayload.current = null;
    for (const id of [activeVoiceRequestIdRef.current, playbackRequestIdRef.current, activeWorkRequestIdRef.current, ...audioQueue.current.map(chunk => chunk instanceof ArrayBuffer ? undefined : chunk.requestId)]) {
      if (id) cancelledVoiceRequestsRef.current.add(id);
    }
    activeVoiceRequestIdRef.current = null;
    activeWorkRequestIdRef.current = null;
    disposePlaybackContexts();
    cleanupCapture();

    isTtsPlaying.current = false;
    transcriptionOnlyRef.current = false;
    ttsStartedAt.current = 0;
    setIsMuted(false);
    isMutedRef.current = false;

    setCallState('idle');
  }, [callGenerationRef, captureLeaseToken, isCallActive, clearPassiveTimers, clearThinkingWatchdog, socketRef, activeStartPayload, activeVoiceRequestIdRef, activeWorkRequestIdRef, disposePlaybackContexts, cleanupCapture, isTtsPlaying, transcriptionOnlyRef, ttsStartedAt, setIsMuted, isMutedRef, setCallState, playbackRequestIdRef, cancelledVoiceRequestsRef]);
  return {
    ...previousBindings, endCall, audioQueue, cleanupCapture, disposePlaybackContexts, stopAllPlayback, installMicrophoneCapture, recoverMicrophoneCapture
  } as const;
}
