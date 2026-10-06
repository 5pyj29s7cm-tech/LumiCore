import { type AudioSession, getVoiceStateKey } from "../session";
import { getOrCreateActiveConversation } from "../../../conversation/manager";
import { logger } from "../../../../logger";
import type { captureChatAuthorization } from "../../chat_authorization";
import { isVoiceprintGateOpen, blockUnverifiedVoice, resetUtteranceVoiceprint, advanceVoiceprintUtterance, waitForVoiceprintGate, getVoiceprintSpeakerMeta } from "../voiceprint";
import { createResilientStreamingSession, getActiveStreamingSTTProvider } from "../../../stt/adapter";
import { isCurrentVoiceInputSource, isRepeatedVoiceFinal } from "../../../cognition/voice_input_guard";
import { voiceEchoScope, isEchoedImmediateVoiceControl, isVoiceCallEndCommand, isPureInterruptCommand, isEchoText } from "../echo";
import { computeAdaptiveEndpointSilenceMs } from "../../../stt/adaptive_endpointing";
import { recordLatency } from "../../../monitor/latency_store";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../../../personality/state";
import { himTick } from "../../../personality/him";
import { normalizeSpeechCommand, speechCommandKey } from "../../../cognition/speech_normalization";
import { isSpeechClearlyDirectedAwayFromLumi, isVoiceFiller, classifyActiveVoiceWorkInput } from "../../voice_turn_state";
import { assessVoiceTranscriptForExecution } from "../../../cognition/voice_transcript_guard";
import { buildTransportNeutralConfirmationScope, getPendingConfirmationDurably, isExplicitConfirmationReply } from "../../../tools/pending_confirmation";
import { hasExplicitToolIntent } from "../../../cognition/tool_intent";
import { captureVoiceTurnOwner, resetSilenceTimer, handlePriorityVoiceStop, interruptVoiceSpeech, reservePriorityVoiceHandoff } from "../../voice_transport_runtime";
import { respondAlongsideActiveVoiceWork } from "../../voice_conversation_turn";
import { runVoiceInputPipeline } from "../../voice_input_pipeline";
import type { VoiceConnectionRuntime } from './connection';

export async function startVoiceTranscription(
  runtime: VoiceConnectionRuntime,
  session: AudioSession,
  startControlGeneration: number,
  voiceStartSessionId: string,
  authorization: ReturnType<typeof captureChatAuthorization>,
): Promise<void> {


    const sttProvider = getActiveStreamingSTTProvider();
    if (sttProvider) {
      try {
        const language = sttProvider === 'qwen' ? 'zh' : 'zh-CN';
        session.sttSession = createResilientStreamingSession(
          { provider: sttProvider, language, interimResults: true },
          {
            onRecovering: ({ attempt, delayMs, error }) => {
              if (!session.isActive || session.callControlGeneration !== startControlGeneration) return;
              logger.warn(`[Audio] STT connection recovering (attempt=${attempt}, delayMs=${delayMs}): ${error.message}`);
              runtime.socket.emit('audio:status', {
                status: 'connecting',
                sessionId: voiceStartSessionId,
                reason: 'stt_recovering',
                attempt,
                delayMs,
              });
            },
            onRecovered: ({ attempt }) => {
              if (!session.isActive || session.callControlGeneration !== startControlGeneration) return;
              logger.info(`[Audio] STT connection recovered after attempt ${attempt}`);
              if (!session.isProcessing && !session.isSpeaking) {
                runtime.socket.emit('audio:status', { status: 'listening', reason: 'stt_recovered', sessionId: voiceStartSessionId });
              }
            },
          },
        );
        const callbackSttSession = session.sttSession;
        const callbackSessionId = session.sessionId;
        resetSilenceTimer(session, runtime.socket);

        session.sttSession.onResult(async (result) => {
          if (!authorization.isCurrent()) return;
          if (!isCurrentVoiceInputSource({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            callbackSessionId,
            currentSttSession: session.sttSession,
            callbackSttSession,
          })) {
            logger.info(`[Audio] Ignored stale STT callback for session ${callbackSessionId}`);
            return;
          }
          if (result.speechStarted) {
            session.lastSpeechStartedAt = Date.now();
            session.lastSpeechEndedAt = 0;
          }
          const inputOwner = captureVoiceTurnOwner(session);
          if (result.speechFinal) session.lastSpeechEndedAt = Date.now();
          const immediateText = String(result.text || '').trim();
          if (
            immediateText
            && !session.transcriptionOnly
            && isEchoedImmediateVoiceControl(
              immediateText,
              session.isSpeaking || Date.now() < session.ttsPlaybackUntil,
              voiceEchoScope(session),
            )
          ) {
            logger.info(`[Audio] Ignored echoed priority control (${result.isFinal ? 'final' : 'interim'})`);
            session.accumulatedText = '';
            if (result.isFinal) advanceVoiceprintUtterance(runtime.socket, session);
            return;
          }
          if (
            immediateText
            && !session.transcriptionOnly
            && isVoiceCallEndCommand(immediateText)
          ) {
            logger.info(`[Audio] Voice-call end command recognized (${result.isFinal ? 'final' : 'interim'})`);
            session.accumulatedText = '';
            await runtime.commitActiveVoiceCancellation(session, { source: 'voice_end_command' });
            if (!inputOwner.isCurrent()) return;
            resetUtteranceVoiceprint(session);
            runtime.socket.emit('audio:end-call-request', { sessionId: callbackSessionId });
            return;
          }
          if (
            immediateText
            && !session.transcriptionOnly
            && isPureInterruptCommand(immediateText)
          ) {
            logger.info(`[Audio] Priority stop recognized (${result.isFinal ? 'final' : 'interim'})`);
            session.accumulatedText = '';
            await handlePriorityVoiceStop(
              runtime.socket,
              session,
              () => runtime.commitActiveVoiceCancellation(session).then(() => undefined),
            );
            return;
          }
          if (result.text && result.isFinal) {
            const asrFinalAt = Date.now();
            const speechEndedAt = session.lastSpeechEndedAt > 0
              ? Math.min(session.lastSpeechEndedAt, asrFinalAt)
              : asrFinalAt;
            const speechDurationMs = session.lastSpeechStartedAt > 0
              ? Math.max(0, speechEndedAt - session.lastSpeechStartedAt)
              : undefined;
            session.endpointSilenceMs = computeAdaptiveEndpointSilenceMs({
              transcript: result.text,
              speechDurationMs,
              previousSilenceMs: session.endpointSilenceMs,
            });
            session.sttSession?.updateEndpointing?.(session.endpointSilenceMs);
            if (speechEndedAt > 0) {
              recordLatency('stt', asrFinalAt - speechEndedAt);
            }
            logger.info(`[Audio] Final transcript received (${result.text.length} chars)`);
            // Feed voice sentiment into emotional state when a provider includes it.
            if (result.sentiment && session.userId) {
              try {
                const stateKey = getVoiceStateKey(session);
                const es = loadEmotionalState(stateKey);
                const updated = updateEmotionalState(es, {
                  type: 'sentiment_analysis',
                  timestamp: new Date().toISOString(),
                  userId: session.userId,
                  sentiment: {
                    valence: result.sentiment.sentiment_score,
                    frustration: result.sentiment.sentiment === 'negative' ? 0.6 : 0,
                    urgency: 0,
                  },
                });
                saveEmotionalState(stateKey, updated);
                try { const hm2 = loadHIMState(stateKey); const { him: nh2 } = himTick(updated, hm2); saveHIMState(stateKey, nh2); } catch {}
              } catch { /* best-effort sentiment tracking */ }
            }
            session.accumulatedText += result.text;
            const text = normalizeSpeechCommand(session.accumulatedText);
            session.accumulatedText = '';
            if (!text) return;

            // ── Filter filler words: single-char interjections ──
            // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
            const isFiller = /^[嗯啊哦呃哼唉呀哈呵嗨喂诶唔嘶啧哎哦哟嘿嘛哇啦嘞][。！？.!?，,～~]*$/.test(text);
            if (isFiller || isVoiceFiller(text)) {
              logger.info(`[Audio] Ignored filler (${text.length} chars)`);
              advanceVoiceprintUtterance(runtime.socket, session);
              return;
            }
            if (isSpeechClearlyDirectedAwayFromLumi(text)) {
              logger.info(`[Audio] Ignored speech explicitly directed to another person (${text.length} chars)`);
              advanceVoiceprintUtterance(runtime.socket, session);
              return;
            }
            // ── Filter pure noise (no CJK, no letters, no digits) ──
            // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
            const hasContent = /[a-zA-Z一-鿿㐀-䶿\d]/.test(text);
            if (!hasContent) {
              logger.info(`[Audio] Ignored pure noise (${text.length} chars)`);
              advanceVoiceprintUtterance(runtime.socket, session);
              return;
            }

            // TTS echo is not an authorization failure. Remove it before the
            // voiceprint gate so self speech cannot mutate the call state.
            if (isEchoText(text, session.isSpeaking, voiceEchoScope(session))) {
              logger.info(`[Audio] Echo cancelled during speech (${text.length} chars)`);
              advanceVoiceprintUtterance(runtime.socket, session);
              return;
            }

            let voiceAuthorized = session.transcriptionOnly || isVoiceprintGateOpen(session);
            if (!session.transcriptionOnly && !isVoiceprintGateOpen(session)) {
              const verifiedAfterSync = await waitForVoiceprintGate(session);
              if (!verifiedAfterSync) {
                blockUnverifiedVoice(runtime.socket, session, 'Ignored transcript before command/barge-in');
                advanceVoiceprintUtterance(runtime.socket, session);
                resetSilenceTimer(session, runtime.socket);
                return;
              }
              voiceAuthorized = true;
            }
            const transcriptSpeakerMeta = getVoiceprintSpeakerMeta(session);
            advanceVoiceprintUtterance(runtime.socket, session);
            const commandKey = speechCommandKey(text);
            const duplicateActiveFinal = isRepeatedVoiceFinal({
              commandKey,
              lastCommandKey: session.lastAcceptedCommandKey,
              currentChunkAt: session.lastChunkTime,
              lastAcceptedChunkAt: session.lastAcceptedCommandChunkAt,
              lastAcceptedAt: session.lastAcceptedCommandAt,
              laneActive: session.isProcessing || session.isSpeaking || Boolean(session.bargeinTimer),
            });
            if (duplicateActiveFinal) {
              logger.info(`[Audio] Ignored duplicate final transcript (${text.length} chars)`);
              runtime.socket.emit('audio:confirm', { text });
              resetSilenceTimer(session, runtime.socket);
              return;
            }
            session.lastAcceptedCommandKey = commandKey;
            session.lastAcceptedCommandAt = Date.now();
            session.lastAcceptedCommandChunkAt = session.lastChunkTime;
            const transcriptExecutionGuard = assessVoiceTranscriptForExecution(text);
            const activeWorkRunning = session.isBackgroundWork && session.activeWorkStatus !== 'completed';
            if (
              transcriptExecutionGuard.action === 'clarify'
              && activeWorkRunning
              && session.activeTurnRequestId
            ) {
              // Contaminated/incomplete STT must not cancel, modify, or queue
              // tools behind the task that already owns the work lane. Keep
              // that task alive and answer on the non-tool sidecar instead.
              logger.warn(
                `[Audio] Guarded uncertain transcript beside active work reason=${transcriptExecutionGuard.reason} chars=${text.length}`,
              );
              const workRequestId = session.activeTurnRequestId;
              interruptVoiceSpeech(session);
              runtime.socket.emit('audio:status', { status: 'interrupted', sessionId: callbackSessionId });
              runtime.socket.emit('audio:interrupt-ack', { sessionId: callbackSessionId, workContinues: true, requestId: workRequestId });
              runtime.socket.emit('audio:confirm', { text });
              void respondAlongsideActiveVoiceWork(
                runtime.socket,
                session,
                text,
                runtime.llmGetters,
                'side_chat',
                {
                  text: transcriptExecutionGuard.responseText,
                  cognitiveIntent: 'voice_transcript_clarification',
                },
              );
              resetSilenceTimer(session, runtime.socket);
              return;
            }
            if (session.isProcessing || session.isSpeaking) {
              if (activeWorkRunning) {
                const activeConfirmationConversationId = session.activeTaskConversationId
                  || getOrCreateActiveConversation(
                    session.userId,
                    session.agentId,
                    session.domain,
                    session.orgId,
                  ).id;
                const confirmsPendingAction = isExplicitConfirmationReply(text)
                  && Boolean(await getPendingConfirmationDurably(session.userId, buildTransportNeutralConfirmationScope({
                    domain: session.domain,
                    orgId: session.orgId,
                    conversationId: activeConfirmationConversationId,
                    taskId: session.activeTaskId || undefined,
                  })) || await getPendingConfirmationDurably(session.userId, buildTransportNeutralConfirmationScope({
                    domain: session.domain,
                    orgId: session.orgId,
                    conversationId: activeConfirmationConversationId,
                  })));
                if (confirmsPendingAction) {
                  logger.info('[Audio] Confirmation continues the pending action instead of entering the side-chat lane');
                  // Replace only the transport owner. The durable task and its
                  // exact pending action remain intact for the confirmation
                  // turn that starts immediately below.
                  if (!await reservePriorityVoiceHandoff(session, false)) return;
                  runtime.socket.emit('audio:status', { status: 'interrupted', sessionId: callbackSessionId });
                  runtime.socket.emit('audio:interrupt-ack', { sessionId: callbackSessionId, workContinues: false });
                  // Fall through to the normal pipeline, which executes the
                  // exact one-time pending action deterministically.
                } else {
                const activeWorkDecision = classifyActiveVoiceWorkInput(
                  session.activeRoutingText,
                  text,
                  { hasExplicitToolIntent: hasExplicitToolIntent(text) },
                );
                const interruptionKind = activeWorkDecision.kind;
                logger.info(`[Audio] Work-lane interruption=${interruptionKind} source=semantic_transcript request=${session.activeTurnRequestId || 'none'} (${text.length} chars)`);
                if (interruptionKind === 'cancel_work') {
                  await runtime.commitActiveVoiceCancellation(session, { source: 'voice_cancel_command' });
                  if (!inputOwner.isCurrent()) return;
                  runtime.socket.emit("audio:status", { status: "interrupted", sessionId: callbackSessionId });
                  runtime.socket.emit("audio:interrupt-ack", { sessionId: callbackSessionId, workContinues: false });
                  runtime.socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, runtime.socket);
                  return;
                }
                if (interruptionKind === 'modify_work') {
                  // Replace the transport turn so the running model cannot
                  // keep acting on stale instructions, but preserve the
                  // durable task id, receipts, permission snapshot, and
                  // pending confirmation for the corrected continuation.
                  if (!await reservePriorityVoiceHandoff(session, true)) return;
                  runtime.socket.emit("audio:status", { status: "interrupted", sessionId: callbackSessionId });
                  runtime.socket.emit("audio:interrupt-ack", { sessionId: callbackSessionId, workContinues: false });
                  // Fall through: the correction is merged into a replacement work turn.
                } else {
                  const workRequestId = session.activeTurnRequestId;
                  interruptVoiceSpeech(session);
                  runtime.socket.emit("audio:status", { status: "interrupted", sessionId: callbackSessionId });
                  runtime.socket.emit("audio:interrupt-ack", { sessionId: callbackSessionId, workContinues: true, requestId: workRequestId });
                  if (interruptionKind === 'stop_speaking') {
                    runtime.socket.emit("audio:status", { status: "listening", requestId: workRequestId, lane: 'work' });
                    resetSilenceTimer(session, runtime.socket);
                    return;
                  }
                  if (activeWorkDecision.queueIncomingWork) {
                    // An unrelated command arriving during work is queued by
                    // default. Silent replacement made multi-step tasks stop at
                    // step one whenever the user spoke again. Explicit
                    // correction/cancellation phrases still take their own
                    // branches above.
                    const duplicate = session.inputQueue.some(item => speechCommandKey(item.text) === commandKey);
                    if (!duplicate) session.inputQueue.push({
                      text,
                      queuedAt: new Date(asrFinalAt).toISOString(),
                      voiceAuthorized,
                      inputTiming: {
                        speechEndedAt,
                        asrFinalAt,
                        sttProvider,
                        captureChunkSequence: session.voiceCaptureProvenance.chunkSequence,
                      },
                    });
                    runtime.socket.emit('audio:work_queued', {
                      text,
                      queuePosition: session.inputQueue.findIndex(item => speechCommandKey(item.text) === commandKey) + 1,
                      activeRequestId: workRequestId,
                    });
                    runtime.socket.emit("audio:confirm", { text });
                    void respondAlongsideActiveVoiceWork(runtime.socket, session, text, runtime.llmGetters, interruptionKind);
                    resetSilenceTimer(session, runtime.socket);
                    return;
                  } else {
                    runtime.socket.emit("audio:confirm", { text });
                    void respondAlongsideActiveVoiceWork(runtime.socket, session, text, runtime.llmGetters, interruptionKind);
                    resetSilenceTimer(session, runtime.socket);
                    return;
                  }
                }
                }
              } else if (session.isSpeaking) {
                logger.info(`[Audio] Barge-in during speech source=semantic_transcript request=${session.activeTurnRequestId || 'none'} (${text.length} chars)`);
                if (isPureInterruptCommand(text)) {
                  await runtime.commitActiveVoiceCancellation(session, { source: 'voice_interrupt_command' });
                  if (!inputOwner.isCurrent()) return;
                } else {
                  await runtime.commitActiveVoiceCancellation(session, { source: 'voice_replaced', preserveInterruptedTurn: true });
                  if (!inputOwner.isCurrent()) return;
                }
                runtime.socket.emit("audio:status", { status: "interrupted", sessionId: callbackSessionId });
                runtime.socket.emit("audio:interrupt-ack", { sessionId: callbackSessionId });
                if (isPureInterruptCommand(text)) {
                  runtime.socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, runtime.socket);
                  return;
                }
              } else {
                logger.info(`[Audio] Barge-in during processing source=semantic_transcript request=${session.activeTurnRequestId || 'none'} (${text.length} chars)`);
                if (isPureInterruptCommand(text)) {
                  await runtime.commitActiveVoiceCancellation(session, { source: 'voice_interrupt_command' });
                  if (!inputOwner.isCurrent()) return;
                } else {
                  await runtime.commitActiveVoiceCancellation(session, { source: 'voice_replaced', preserveInterruptedTurn: true });
                  if (!inputOwner.isCurrent()) return;
                }
                runtime.socket.emit("audio:status", { status: "interrupted", sessionId: callbackSessionId });
                runtime.socket.emit("audio:interrupt-ack", { sessionId: callbackSessionId });
                if (isPureInterruptCommand(text)) {
                  runtime.socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, runtime.socket);
                  return;
                }
              }
            }

            // Echo confirmation — brief window for user to see what was heard and interrupt if wrong
            runtime.socket.emit("audio:confirm", { text });
            logger.info(`[Audio] Accepted transcript (${text.length} chars)`);

            if (session.transcriptionOnly) {
              runtime.socket.emit("audio:transcript", { text, isFinal: true, ...transcriptSpeakerMeta });
              runtime.socket.emit("audio:status", { status: "listening" });
              resetSilenceTimer(session, runtime.socket);
              return;
            }

            // Yield just long enough for the confirmation event to render. The
            // streaming microphone lane remains open, so a fixed 600 ms grace
            // period only made every accepted command feel sluggish without
            // adding meaningful interruption safety.
            session.bargeinTimer = setTimeout(() => {
              session.bargeinTimer = null;
              if (!session.isActive) return;
              void runVoiceInputPipeline(
                runtime.socket,
                session,
                text,
                runtime.llmGetters,
                runtime.sensoryFn,
                runtime.io,
                new Date(asrFinalAt).toISOString(),
                voiceAuthorized,
                {
                  speechEndedAt,
                  asrFinalAt,
                  sttProvider,
                  captureChunkSequence: session.voiceCaptureProvenance.chunkSequence,
                },
              );
            }, 160);
          } else if (
            result.text
            && !result.isFinal
            // Meeting transcription intentionally shows every participant.
            // Personal voice commands remain private until the current
            // utterance has passed its own speaker-verification gate.
            && (session.transcriptionOnly || !session.voiceprintRequired || isVoiceprintGateOpen(session))
          ) {
            runtime.socket.emit("audio:transcript", { text: result.text, isFinal: false });
          }
        });

        session.sttSession.onError(async (err: Error) => {
          if (!isCurrentVoiceInputSource({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            callbackSessionId,
            currentSttSession: session.sttSession,
            callbackSttSession,
          })) return;
          logger.error("[Audio STT Error]:", err);
          await runtime.stopVoiceCall(session, { source: 'voice_stt_failed', error: {
            code: 'STT_RUNTIME_FAILED',
            message: 'Speech recognition temporarily failed. Please try again.',
          } });
        });

        runtime.socket.emit("audio:status", { status: "listening", sessionId: voiceStartSessionId });
      } catch (err: any) {
        logger.error("[Audio Start Error]:", err);
        await runtime.stopVoiceCall(session, { source: 'voice_start_failed', error: {
          code: 'VOICE_START_FAILED',
          message: 'Voice input could not be started. Check the voice settings and try again.',
        } });
      }
    } else {
      await runtime.stopVoiceCall(session, { source: 'voice_stt_not_configured', error: {
        code: 'STT_NOT_CONFIGURED',
        message: 'Realtime speech recognition is not configured. Choose an available speech-recognition service in Voice settings.',
      } });
    }
}
