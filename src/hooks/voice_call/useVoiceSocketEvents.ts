import { useEffect } from "react";
import { hasVoiceCapture } from "@/lib/voiceCaptureLease";
import { sanitizeAgentResponseTextForDisplay, shouldDisplayAgentResponse, type AgentResponseDelivery } from "@/lib/agentResponseDelivery";
import { closeAudioContext } from "@/lib/audioContextLifecycle";
import { applyPreferredVoiceOutputDevice } from "@/lib/voiceDevicePreferences";
import type { useVoiceCaptureRuntime } from './useVoiceCaptureRuntime';
import { shouldAcceptVoiceStatus, LUMI_VOICE_TRANSCRIPT_EVENT, normalizeVoiceAudioBuffer, normalizeSelectedVoiceId } from './protocol';
import type { CallState, VoiceTranscriptEventDetail, VoiceAudioResponse, VoiceTranscriptMeta } from './contracts';
import { createVoicePlaybackRuntime, releaseAudioBufferSource } from './playback';

export function useVoiceSocketEvents(previousBindings: ReturnType<typeof useVoiceCaptureRuntime>) {
  const { disabled, socket, activeStartPayload, isCallActive, cancelledVoiceRequestsRef, activeVoiceRequestIdRef, scheduleThinkingWatchdog, clearThinkingWatchdog, setCallState, passiveTimer, disconnectTimer, transcriptionOnlyRef, prevCallState, endCall, activeWorkRequestIdRef, setTranscript, privateCaptureRef, onTranscript, audioQueue, ensureTtsContext, isConversationTtsPlaying, playbackRequestIdRef, setHasConversationPlayback, isTtsPlaying, proactiveSource, setError, playbackGenerationRef, ttsStartedAt, ttsBargeInCandidateSentRef, outputLevelRef, ttsEchoFloorRef, ttsBargeInFramesRef, ttsSourceRef, ttsContext, ttsGainNode, nextStartTime, proactivePlaybackGenerationRef, proactiveStateTimerRef, proactiveContext, setResponseText, onResponse, callGenerationRef, cleanupCapture, disposePlaybackContexts, preferredVoiceIdRef, pendingInterruptRef, stopAllPlayback, proactiveContextRef, isMutedRef } = previousBindings;



  useEffect(() => {
    if (disabled || !socket) return;

    const onAudioStatus = (data: { status: string; requestId?: string; lane?: string; sessionId?: string }) => {
      if (data.sessionId && data.sessionId !== activeStartPayload.current?.sessionId) return;
      if (!isCallActive.current) return;
      if (data.requestId && cancelledVoiceRequestsRef.current.has(data.requestId)) return;
      const activeRequestId = activeVoiceRequestIdRef.current;
      if (!shouldAcceptVoiceStatus(data, activeRequestId)) return;
      if ((data.status === 'thinking' || data.status === 'queued') && data.requestId) {
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
      if (typeof window !== 'undefined' && !privateCaptureRef.current) {
        window.dispatchEvent(new CustomEvent<VoiceTranscriptEventDetail>(LUMI_VOICE_TRANSCRIPT_EVENT, {
          detail: { text: data.text, isFinal: true, source: 'confirm' },
        }));
      }
      if (!transcriptionOnlyRef.current) {
        onTranscript?.(data.text, true);
      }
    };
    const { prepareAudio, prepareQueueHead, playAudioChunk } = createVoicePlaybackRuntime({
    audioQueue, isCallActive, ensureTtsContext, isConversationTtsPlaying, playbackRequestIdRef,
    setHasConversationPlayback, isTtsPlaying, proactiveSource, setError, setCallState, playbackGenerationRef,
    ttsStartedAt, ttsBargeInCandidateSentRef, clearThinkingWatchdog, outputLevelRef, ttsEchoFloorRef,
    ttsBargeInFramesRef, ttsSourceRef, ttsContext, ttsGainNode, nextStartTime, socket
  });


    // Handle raw binary payloads and the metadata envelope emitted by the
    // server.  Normalize before queueing so a Uint8Array/serialized Buffer
    // cannot reach decodeAudioData as an invalid object.
    const onAudioResponse = (data: unknown) => {
      if (!isCallActive.current) { console.log('[VoiceCall] Ignoring audio:response, call ended'); return; }
      const binaryView = typeof ArrayBuffer !== 'undefined'
        && (data instanceof ArrayBuffer || ArrayBuffer.isView(data));
      const envelope = !binaryView
        && data
        && typeof data === 'object'
        && Object.prototype.hasOwnProperty.call(data, 'buffer')
        ? data as Partial<VoiceAudioResponse>
        : null;
      const actualRequestId = envelope?.requestId;
      if (envelope?.sessionId && envelope.sessionId !== activeStartPayload.current?.sessionId) return;
      if (actualRequestId && cancelledVoiceRequestsRef.current.has(actualRequestId)) return;
      // A fast server can deliver the first audio packet in the same turn as
      // the `thinking` status packet.  If a React effect was being rebound (or
      // the status packet was lost during a reconnect), the client may not
      // have installed the request id yet.  Adopt the id carried by the audio
      // packet in that case; only reject a packet when we already have a
      // different active turn.  Previously the `null !== requestId` case
      // silently discarded every audio packet while text/transcription still
      // appeared to work.
      const activeRequestId = activeVoiceRequestIdRef.current;
      if (actualRequestId && activeRequestId && actualRequestId !== activeRequestId) return;
      if (actualRequestId && !activeRequestId) activeVoiceRequestIdRef.current = actualRequestId;
      const actualBuffer = normalizeVoiceAudioBuffer(envelope ? envelope.buffer : data);
      if (!actualBuffer || actualBuffer.byteLength === 0) {
        console.error('[VoiceCall] Ignoring an audio:response without a decodable binary buffer');
        return;
      }
      const actualGain = envelope?.volumeGain;
      const actualLane = envelope?.lane;
      const actualFormat = envelope?.format;
      const packet: VoiceAudioResponse = {
        buffer: actualBuffer, format: actualFormat, volumeGain: actualGain,
        lane: actualLane, requestId: actualRequestId, receivedAt: performance.now(),
      };

      // A foreground reply owns the speaker. Do not let an earlier proactive
      // greeting keep the conversation packet parked in an undrained queue.
      proactivePlaybackGenerationRef.current++;
      if (proactiveStateTimerRef.current) {
        clearTimeout(proactiveStateTimerRef.current);
        proactiveStateTimerRef.current = null;
      }
      if (proactiveSource.current) {
        releaseAudioBufferSource(proactiveSource.current, true);
        proactiveSource.current = null;
      }
      if (proactiveContext.current) {
        void closeAudioContext(proactiveContext.current);
        proactiveContext.current = null;
      }
      isTtsPlaying.current = isConversationTtsPlaying.current;

      if (isConversationTtsPlaying.current) {
        // Currently playing — queue this chunk
        audioQueue.current.push(packet);
        if (audioQueue.current.length === 1 && ttsContext.current && ttsContext.current.state !== 'closed') {
          prepareQueueHead(ttsContext.current);
        }
        return;
      }
      playAudioChunk(actualBuffer, actualGain, actualLane, actualRequestId, actualFormat, packet);
    };

    const onAudioTranscript = (data: { text: string; isFinal: boolean } & VoiceTranscriptMeta) => {
      if (!isCallActive.current) return;
      // Reset passive timer — user is speaking
      if (passiveTimer.current) { clearTimeout(passiveTimer.current); passiveTimer.current = null; }
      if (disconnectTimer.current) { clearTimeout(disconnectTimer.current); disconnectTimer.current = null; }
      if (prevCallState.current === 'passive') setCallState('listening');
      setTranscript(data.text);
      if (typeof window !== 'undefined' && !privateCaptureRef.current) {
        window.dispatchEvent(new CustomEvent<VoiceTranscriptEventDetail>(LUMI_VOICE_TRANSCRIPT_EVENT, {
          detail: {
            text: data.text,
            isFinal: data.isFinal,
            source: 'transcript',
            speakerLabel: data.speakerLabel,
            speakerConfidence: data.speakerConfidence,
            speakerSource: data.speakerSource,
            speakerMatched: data.speakerMatched,
          },
        }));
      }
      onTranscript?.(data.text, data.isFinal, {
        requestId: data.requestId,
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
      const publicText = sanitizeAgentResponseTextForDisplay(data.text);
      if (!publicText) return;
      setTranscript(''); // Clear user transcript when AI starts responding
      setResponseText(publicText);
      onResponse?.(publicText, { requestId: data.requestId });
    };

    const onAudioError = (data: { message: string; sessionId?: string }) => {
      if (!isCallActive.current) return;
      if (data.sessionId && data.sessionId !== activeStartPayload.current?.sessionId) return;
      callGenerationRef.current++;
      isCallActive.current = false;
      activeStartPayload.current = null;
      for (const id of [activeVoiceRequestIdRef.current, playbackRequestIdRef.current, activeWorkRequestIdRef.current, ...audioQueue.current.map(chunk => chunk instanceof ArrayBuffer ? undefined : chunk.requestId)]) {
        if (id) cancelledVoiceRequestsRef.current.add(id);
      }
      activeVoiceRequestIdRef.current = null;
      activeWorkRequestIdRef.current = null;
      setError(data.message);
      clearThinkingWatchdog();
      cleanupCapture();
      disposePlaybackContexts();
      transcriptionOnlyRef.current = false;
      setCallState('idle');
    };

    const onAudioTtsError = (data: { requestId?: string; lane?: string }) => {
      if (!isCallActive.current) return;
      const activeRequestId = activeVoiceRequestIdRef.current;
      if (data?.requestId && activeRequestId && data.requestId !== activeRequestId) return;
      // TTS failure must not end an otherwise healthy STT/LLM conversation.
      // Keep the explanation short and user-facing; detailed provider errors
      // remain on the server log and are never rendered as chat content.
      setError('Voice output is temporarily unavailable; the text reply is still available.');
    };

    const onAudioVoiceChanged = (data: {
      voiceId?: string;
      sessionId?: string;
      fallback?: boolean;
      reason?: string;
    }) => {
      const payload = activeStartPayload.current;
      const acknowledgedVoiceId = normalizeSelectedVoiceId(data?.voiceId);
      if (
        !isCallActive.current
        || !payload
        || !acknowledgedVoiceId
        || data?.sessionId !== payload.sessionId
        || (payload.voiceId !== acknowledgedVoiceId && data?.fallback !== true)
      ) return;
      activeStartPayload.current = { ...payload, voiceId: acknowledgedVoiceId };
      preferredVoiceIdRef.current = acknowledgedVoiceId;
    };

    const onAudioVoiceUnavailable = (data: {
      reason?: string;
      requestedVoiceId?: string;
      currentVoiceId?: string | null;
      sessionId?: string;
    }) => {
      const payload = activeStartPayload.current;
      if (!isCallActive.current || !payload) return;
      if (data?.sessionId && data.sessionId !== payload.sessionId) return;
      const requestedVoiceId = normalizeSelectedVoiceId(data?.requestedVoiceId);
      if (requestedVoiceId && payload.voiceId !== requestedVoiceId) return;

      const currentVoiceId = normalizeSelectedVoiceId(data?.currentVoiceId);
      activeStartPayload.current = { ...payload, voiceId: currentVoiceId };
      preferredVoiceIdRef.current = currentVoiceId;
      setError(data?.reason === 'voice_profile_scope_mismatch'
        ? 'The selected voice is unavailable in this Lumi workspace.'
        : 'The selected voice could not be applied to the active call.');
    };

    const onAudioInterruptAck = (data?: { workContinues?: boolean; requestId?: string; sessionId?: string }) => {
      if (!isCallActive.current) return;
      if (data?.sessionId && data.sessionId !== activeStartPayload.current?.sessionId) return;
      const currentRequestId = activeVoiceRequestIdRef.current || playbackRequestIdRef.current || activeWorkRequestIdRef.current;
      if (data?.requestId && currentRequestId && data.requestId !== currentRequestId) return;
      const pending = pendingInterruptRef.current;
      if (pending && (!data?.requestId || data.requestId === pending.requestId)
        && (pending.generation !== playbackGenerationRef.current
          || (pending.requestId && currentRequestId && pending.requestId !== currentRequestId))) return;
      pendingInterruptRef.current = null;
      if (data?.workContinues) {
        if (data.requestId) {
          cancelledVoiceRequestsRef.current.delete(data.requestId);
          activeVoiceRequestIdRef.current = data.requestId;
        }
      } else {
        activeWorkRequestIdRef.current = null;
        activeVoiceRequestIdRef.current = null;
      }
      clearThinkingWatchdog();
      stopAllPlayback();
      setCallState('listening');
    };

    const onAudioEndCallRequest = (data?: { sessionId?: string }) => {
      if (!isCallActive.current) return;
      if (data?.sessionId && data.sessionId !== activeStartPayload.current?.sessionId) return;
      endCall();
    };

    const onAudioSidecarResponse = (data: { text?: string; requestId?: string; workRequestId?: string }) => {
      if (!isCallActive.current || !data.text?.trim()) return;
      const workRequestId = data.workRequestId || data.requestId;
      if (!workRequestId || workRequestId !== activeVoiceRequestIdRef.current) return;
      const publicText = sanitizeAgentResponseTextForDisplay(data.text);
      if (!publicText) return;
      setTranscript('');
      setResponseText(publicText);
      onResponse?.(publicText, { requestId: data.requestId });
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
      setResponseText(sanitizeAgentResponseTextForDisplay(data.text));
    };

    const onAudioProactiveError = (data: { contextId?: string; userId?: string; domain?: string; orgId?: string }) => {
      const context = proactiveContextRef.current;
      if (!context?.enabled || data.contextId !== context.contextId || data.userId !== context.userId
        || data.domain !== context.domain || String(data.orgId || '') !== context.orgId
        || !socket.connected || isMutedRef.current || hasVoiceCapture() || isCallActive.current
        || localStorage.getItem('lumi_allow_proactive_voice') !== 'true') return;
      setError('Proactive voice output is temporarily unavailable. Please check voice settings.');
    };

    const onAudioProactiveSpeak = (data: { audioBuffer: ArrayBuffer; text: string; timestamp: string; contextId?: string; userId?: string; domain?: string; orgId?: string; volumeGain?: number }) => {
      // A proactive greeting is optional. Never let it share ownership of the
      // conversation playback queue or reset the foreground speaking state.
      const acceptedContext = proactiveContextRef.current;
      const canPlay = () => Boolean(acceptedContext?.enabled
        && proactiveContextRef.current === acceptedContext
        && data.contextId === acceptedContext.contextId && data.userId === acceptedContext.userId
        && data.domain === acceptedContext.domain && String(data.orgId || '') === acceptedContext.orgId
        && localStorage.getItem('lumi_allow_proactive_voice') === 'true'
        && socket.connected && !isMutedRef.current && !hasVoiceCapture()
        && !isCallActive.current && !isConversationTtsPlaying.current);
      if (!canPlay()) return;

      void (async () => {
        let ctx: AudioContext | null = null;
        let source: AudioBufferSourceNode | null = null;
        let proactiveGeneration = 0;
        const playbackGeneration = playbackGenerationRef.current;
        const previousState = prevCallState.current;
        const finish = (stopSource = false) => {
          const ownsProactiveLane = proactiveGeneration > 0
            && proactivePlaybackGenerationRef.current === proactiveGeneration;
          if (ownsProactiveLane && proactiveStateTimerRef.current) {
            clearTimeout(proactiveStateTimerRef.current);
            proactiveStateTimerRef.current = null;
          }
          if (source) releaseAudioBufferSource(source, stopSource);
          if (ownsProactiveLane && proactiveSource.current === source) proactiveSource.current = null;
          if (ownsProactiveLane && proactiveContext.current === ctx) proactiveContext.current = null;
          if (ctx) void closeAudioContext(ctx);
          if (ownsProactiveLane) isTtsPlaying.current = isConversationTtsPlaying.current;
          if (ownsProactiveLane && !isConversationTtsPlaying.current) {
            setCallState(current => current === 'speaking' ? previousState : current);
          }
        };

        try {
          const audioBuffer = normalizeVoiceAudioBuffer(data?.audioBuffer);
          if (!audioBuffer || audioBuffer.byteLength === 0) {
            console.error('[ProactiveVoice] Ignoring an audio payload without binary data');
            return;
          }
          proactiveGeneration = ++proactivePlaybackGenerationRef.current;
          // Stop any currently-playing proactive speech before starting new one
          if (proactiveSource.current) {
            releaseAudioBufferSource(proactiveSource.current, true);
            proactiveSource.current = null;
          }
          if (proactiveContext.current) {
            void closeAudioContext(proactiveContext.current);
            proactiveContext.current = null;
          }
          if (proactiveStateTimerRef.current) {
            clearTimeout(proactiveStateTimerRef.current);
            proactiveStateTimerRef.current = null;
          }
          isTtsPlaying.current = true;
          ctx = new AudioContext();
          await applyPreferredVoiceOutputDevice(ctx);
          proactiveContext.current = ctx;
          if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
            await ctx.resume();
          }
          if (ctx.state !== 'running') throw new Error(`Proactive audio output is ${ctx.state}`);

          const decoded = await ctx.decodeAudioData(audioBuffer.slice(0));
          if (
            playbackGeneration !== playbackGenerationRef.current
            || proactiveGeneration !== proactivePlaybackGenerationRef.current
            || !canPlay()
            || (ctx.state as string) === 'closed'
            || isConversationTtsPlaying.current
          ) {
            finish(true);
            return;
          }

          source = ctx.createBufferSource();
          proactiveSource.current = source;
          source.buffer = decoded;
          const gain = ctx.createGain();
          gain.gain.value = typeof data.volumeGain === 'number' ? Math.max(0, Math.min(1.5, data.volumeGain)) : 1;
          source.connect(gain);
          gain.connect(ctx.destination);
          source.onended = () => finish(false);
          source.start(0);
          setError(previous => previous?.startsWith('Proactive voice output') ? null : previous);
          // Keep a bounded fallback in case a WebView never dispatches `ended`.
          setCallState('speaking');
          proactiveStateTimerRef.current = setTimeout(
            () => finish(true),
            Math.max(2_000, Math.round(decoded.duration * 1_000) + 1_000),
          );
        } catch (err) {
          console.error('[ProactiveVoice] Playback failed:', err);
          if (canPlay()) setError('Proactive voice output could not be played. Please check the audio output device.');
          finish(true);
        }
      })();
    };

    socket.on('audio:status', onAudioStatus);
    socket.on('audio:confirm', onAudioConfirm);
    socket.on('audio:response', onAudioResponse);
    socket.on('audio:transcript', onAudioTranscript);
    socket.on('agent:response', onAgentResponse);
    socket.on('audio:error', onAudioError);
    socket.on('audio:tts_error', onAudioTtsError);
    socket.on('audio:voice_changed', onAudioVoiceChanged);
    socket.on('audio:voice_unavailable', onAudioVoiceUnavailable);
    socket.on('audio:interrupt-ack', onAudioInterruptAck);
    socket.on('audio:end-call-request', onAudioEndCallRequest);
    socket.on('audio:sidecar_response', onAudioSidecarResponse);
    socket.on('audio:work_progress', onAudioWorkProgress);
    socket.on('audio:proactive_speak', onAudioProactiveSpeak);
    socket.on('audio:proactive_error', onAudioProactiveError);

    return () => {
      socket.off('audio:status', onAudioStatus);
      socket.off('audio:confirm', onAudioConfirm);
      socket.off('audio:response', onAudioResponse);
      socket.off('audio:transcript', onAudioTranscript);
      socket.off('agent:response', onAgentResponse);
      socket.off('audio:error', onAudioError);
      socket.off('audio:tts_error', onAudioTtsError);
      socket.off('audio:voice_changed', onAudioVoiceChanged);
      socket.off('audio:voice_unavailable', onAudioVoiceUnavailable);
      socket.off('audio:interrupt-ack', onAudioInterruptAck);
      socket.off('audio:end-call-request', onAudioEndCallRequest);
      socket.off('audio:sidecar_response', onAudioSidecarResponse);
      socket.off('audio:work_progress', onAudioWorkProgress);
      socket.off('audio:proactive_speak', onAudioProactiveSpeak);
      socket.off('audio:proactive_error', onAudioProactiveError);
      clearThinkingWatchdog();
    };
  }, [disabled, socket, onTranscript, onResponse, stopAllPlayback, disposePlaybackContexts, cleanupCapture, clearThinkingWatchdog, endCall, ensureTtsContext, scheduleThinkingWatchdog, audioQueue, isCallActive, isConversationTtsPlaying, playbackRequestIdRef, setHasConversationPlayback, isTtsPlaying, proactiveSource, setError, setCallState, playbackGenerationRef, ttsStartedAt, ttsBargeInCandidateSentRef, outputLevelRef, ttsEchoFloorRef, ttsBargeInFramesRef, ttsSourceRef, ttsContext, ttsGainNode, nextStartTime, activeStartPayload, cancelledVoiceRequestsRef, activeVoiceRequestIdRef, prevCallState, passiveTimer, disconnectTimer, transcriptionOnlyRef, activeWorkRequestIdRef, setTranscript, privateCaptureRef, proactivePlaybackGenerationRef, proactiveStateTimerRef, proactiveContext, setResponseText, callGenerationRef, preferredVoiceIdRef, pendingInterruptRef, proactiveContextRef, isMutedRef]);
  return {
    ...previousBindings
  } as const;
}
