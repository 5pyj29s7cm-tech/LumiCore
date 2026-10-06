import { Server, Socket } from "socket.io";
import type { LLMGetters as LlmGetters } from '../llm/dispatch';
import { type AudioSession, getVoiceStateKey, normalizeVoiceSessionId, getAudioSession } from "./voice/session";
import { getOrCreateActiveConversation, addMessageIdempotent, cancelConversationActionExecution, updateAssistantMessageTerminalPresentation } from "../conversation/manager";
import { CN_TASK_EXECUTION_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
import { buildForegroundTaskCompletionFeedback } from '../cognition/acceptance_evidence';
import { getChatExecution, recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, type ChatExecutionScope } from './chat_execution_registry';
import { voiceDurabilityUnknownText } from './voice_durability';
import { commitChatTerminalBoundary } from './chat_terminal_boundary';
import { flushDBOrThrow } from "../../db_layer";
import { logger } from "../../logger";
import { appendMeetingAudio, takeMeetingRecording, findPausedMeetingRecording, releasePausedMeetingRecording, removeMeetingRecordingFiles, normalizeMeetingId } from './meeting_recordings';
import { resolveSingleVoiceTtsRoute, resolveVoiceForProvider, clearVoiceSessionTtsSelection, normalizeVoiceSwitchId, resolveVoiceStartAsyncFence, type VoiceSwitchRequest, isVoiceSwitchSelectionAvailable, applyVoiceSwitchRequest } from "./voice/selection";
import { setRealtimeVoiceSessionActive } from "../autonomy/foreground_activity";
import { refineMeetingTranscript, startMeetingPcmRecording, meetingAuthorizationKey } from "./voice/meetings";
import { randomUUID } from "node:crypto";
import { createVoiceCallAdmission } from './voice_call_admission';
import { registerMemoryAvatarVoiceHandlers } from './memory_avatar_voice';
import { createVoiceCaptureProvenance, recordVoiceCaptureChunk } from './voice_provenance';
import { buildSocketNativeRequestBinding } from './native_request_binding';
import { getTaskRegressionSyntheticVoiceBinding } from '../evidence/task_truth_snapshot_route';
import { resolveAuthorizedSocketScope, resolveSocketScope } from "./scope";
import { captureChatAuthorization } from './chat_authorization';
import { getVoiceprints } from "../biometrics/store";
import { isVoiceprintGateOpen, blockUnverifiedVoice, resetUtteranceVoiceprint, advanceVoiceprintUtterance, waitForVoiceprintGate, getVoiceprintSpeakerMeta } from "./voice/voiceprint";
import { personalityRegistry } from "../personality";
import { isVoiceProfileAccessible, voiceProfileScope } from '../tts/profile_store';
import { synthesizeSpeech, getActiveProvider as getTTSProvider } from "../tts/adapter";
import { createResilientStreamingSession, getActiveStreamingSTTProvider } from "../stt/adapter";
import { isCurrentVoiceInputSource, isRepeatedVoiceFinal } from '../cognition/voice_input_guard';
import { addEchoText, voiceEchoScope, isEchoedImmediateVoiceControl, isVoiceCallEndCommand, isPureInterruptCommand, isEchoText } from "./voice/echo";
import { computeAdaptiveEndpointSilenceMs } from "../stt/adaptive_endpointing";
import { recordLatency } from "../monitor/latency_store";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../personality/state";
import { himTick } from "../personality/him";
import { normalizeSpeechCommand, speechCommandKey } from '../cognition/speech_normalization';
import { isSpeechClearlyDirectedAwayFromLumi, isVoiceFiller, classifyActiveVoiceWorkInput } from "./voice_turn_state";
import { assessVoiceTranscriptForExecution } from '../cognition/voice_transcript_guard';
import { buildTransportNeutralConfirmationScope, getPendingConfirmationDurably, isExplicitConfirmationReply } from "../tools/pending_confirmation";
import { hasExplicitToolIntent } from "../cognition/tool_intent";
import { getMeetingAudioDir } from "../stt/artifact_paths";
import { markVoiceLatencyMilestone, recordVoicePlaybackMetrics } from "../monitor/voice_latency_store";
import { updatePresence } from "../biometrics/presence";
import { emitVoiceWorkProgress } from "./voice/work_progress";
import { getGateConfig } from '../autonomy/safety_gate';
import { getIdleState } from "../context/activity_stream";
import { claimReminderVoiceDelivery } from './proactive_reminder_delivery';
import { finalizeLumiResponse } from "../cognition/result_finalizer";
import { queryMemories, addMemory } from "../memory/store";
import { getUserPreferredLLMConfig } from "../llm/user_preferences";
import { VOICE_CHAT_INPUT_BUDGET_TOKENS } from './voice_runtime_policy';
import { makeLLMCall } from "../llm/providers";
import { providerGetterArguments } from "../llm/provider_getters";
import { recordTokenUsage } from "../llm/token_tracker";
import { captureVoiceTurnOwner, cancelActiveVoiceTurn, quiesceActiveVoiceTransport, emitVoiceTtsFailure, resetSilenceTimer, handlePriorityVoiceStop, interruptVoiceSpeech, reservePriorityVoiceHandoff, voiceTransportState, getAmbientNoise, computeVolumeGain } from "./voice_transport_runtime";
import { respondAlongsideActiveVoiceWork } from "./voice_conversation_turn";
import { runVoiceInputPipeline } from "./voice_input_pipeline";

type ProactiveContext = { contextId: string; userId: string; domain: 'personal' | 'work'; orgId: string; voiceId: string | null; enabled: boolean };

function createVoiceConnectionRuntime(socket: Socket, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, getUserId: (s: Socket) => string, io: Server) {

  const commitActiveVoiceCancellation = async (
    session: AudioSession,
    options: {
      text?: string;
      source?: string;
      publish?: boolean;
      preserveInterruptedTurn?: boolean;
    } = {},
  ): Promise<boolean> => {
    const owner = captureVoiceTurnOwner(session);
    const { userId, agentId, personalityId, domain, orgId } = session;
    const requestId = session.activeTurnRequestId;
    if (!requestId || !userId) {
      await cancelActiveVoiceTurn(session, options.preserveInterruptedTurn === true);
      return false;
    }
    const collector = session.activeExecutionReceipts?.requestId === requestId
      ? session.activeExecutionReceipts : undefined;
    const conversationId = owner.foregroundIdentity?.conversationId || session.activeTaskConversationId
      || getOrCreateActiveConversation(userId, agentId, domain, orgId).id;
    const performCancellation = async (): Promise<boolean> => {
      // Cancellation owns the terminal now. Abort the old transport pipeline
      // before persistence can yield, so it cannot race in a late success.
      quiesceActiveVoiceTransport(session);
      const receiptState = await collector?.settle();
      const cancellationRecords = receiptState?.records || [];
      const unsettled = receiptState?.settled === false;
      const source = options.source || 'voice_cancelled';
      const text = unsettled ? CN_TASK_EXECUTION_MESSAGES.cancellationOutcomeUnknown
        : options.text || CN_TASK_EXECUTION_MESSAGES.cancelled;
      const taskId = owner.foregroundIdentity?.expectedTaskId;
      const completionFeedback = taskId ? buildForegroundTaskCompletionFeedback({
        taskId, taskLabel: owner.interruptedRoutingText || text, toolRecords: cancellationRecords,
        ...(unsettled ? { blocked: true } : { status: 'cancelled' as const }),
        reason: unsettled ? 'tool_settlement_unknown' : 'cancelled',
      }) : { status: 'cancelled' as const, incomplete: [text], nextSteps: [] };
      const scope: ChatExecutionScope = {
        userId,
        domain,
        orgId,
        source: 'voice',
        conversationId,
      };
      const terminalPayload = {
        text,
        source,
        channel: 'voice',
        requestId,
        conversationId,
        finalized: true,
        blocked: true,
        reason: unsettled ? 'execution_settlement_unknown' : 'cancelled',
        completionFeedback,
      };
      const unknownPayload = {
        text: voiceDurabilityUnknownText(),
        agentName: 'Lumi',
        source: 'voice',
        channel: 'voice',
        requestId,
        conversationId,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      };
      const shouldPublish = options.publish !== false;
      const committed = await commitChatTerminalBoundary({
        // Assistant + actual receipts + terminal disposition share one barrier.
        // Cancelling the ledger first would detach these receipts from the turn.
        persistTerminalState: () => undefined,
        persistAssistantMessage: () => {
          const updated = updateAssistantMessageTerminalPresentation({
            userId,
            conversationId,
            requestId,
            content: text,
            channel: 'voice',
            completionFeedback,
          });
          if (updated) {
            if (!unsettled) cancelConversationActionExecution(conversationId, userId, 'The active voice request was cancelled.', requestId);
            return;
          }
          addMessageIdempotent({
            userId,
            agentId,
            conversationId,
            role: 'assistant',
            content: text,
            personality: personalityId,
            mode: 'voice',
            channel: 'voice',
            cognitiveIntent: 'voice_turn_cancelled',
            llmWasCalled: false,
            domain,
            orgId,
            requestId,
            toolCalls: cancellationRecords.length ? cancellationRecords : undefined,
            completionFeedback,
            ...(taskId ? { terminalTaskDisposition: {
              outcome: unsettled ? 'blocked' as const : 'cancelled' as const,
              taskId, requestId,
              reason: unsettled ? 'tool_settlement_unknown' : 'The active voice request was cancelled.',
            } } : {}),
          });
        },
        flush: flushDBOrThrow,
        persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
          scope,
          requestId,
          'agent:response',
          terminalPayload,
          unknownPayload,
        ),
        persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
          scope,
          requestId,
          unknownPayload,
        ),
        publishCommitted: () => {
          if (!shouldPublish || !socket.connected || !owner.isCurrent()) return;
          socket.emit('agent:response', terminalPayload);
          socket.emit('chat:conversation_updated', {
            conversationId,
            agentId,
            source,
            requestId,
          });
        },
        publishUnknown: () => {
          if (shouldPublish && socket.connected && owner.isCurrent()) socket.emit('agent:response', unknownPayload);
        },
        persistenceUnknownProjection: {
          text: unknownPayload.text,
          reason: 'Terminal persistence outcome is unknown.',
        },
        onPersistenceError: error => logger.warn('[Audio] Voice cancellation persistence failed:', error),
      });
      await cancelActiveVoiceTurn(session, options.preserveInterruptedTurn === true, false, false, owner);
      return committed;
    };
    return collector ? collector.cancelOnce(performCancellation) : performCancellation();
  };

  const stopVoiceCall = async (
    session: AudioSession,
    options: { source: string; refineTranscript?: boolean; preserveMeeting?: boolean; refinementId?: string; publish?: boolean; error?: { code: string; message: string } },
  ): Promise<void> => {
    const generation = ++session.callControlGeneration;
    session.stopAuthorizationWatch?.();
    session.stopAuthorizationWatch = undefined;
    const { sessionId, userId, meetingCapture } = session;
    const meetingSession = { ...session };
    const shouldRefineMeeting = session.transcriptionOnly && options.refineTranscript === true;
    if (meetingCapture) meetingCapture.closed = true;
    const stoppedRecording = meetingCapture && (shouldRefineMeeting || !options.preserveMeeting)
      ? takeMeetingRecording(meetingCapture.recording) : null;
    session.meetingCapture = undefined;
    // Stop admission synchronously; durable cancellation may wait for storage.
    session.isActive = false;
    clearVoiceSessionTtsSelection(session);
    if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
    const sttSession = session.sttSession;
    session.sttSession = null;
    try { sttSession?.end(); } catch (error) { logger.warn('[Audio] STT close failed:', error); }
    session.transcriptionOnly = false;
    session.meetingPcmPath = null;
    session.meetingPcmBytes = 0;
    try {
      await commitActiveVoiceCancellation(session, { source: options.source, publish: false });
    } finally {
      // A newer start owns the same socket's priority registration and UI.
      if (session.callControlGeneration === generation) {
        setRealtimeVoiceSessionActive(userId, socket.id, false);
        if (options.publish !== false && socket.connected) {
          socket.emit('audio:status', { status: 'idle', sessionId });
          if (options.error) socket.emit('audio:error', { ...options.error, sessionId });
        }
      }
      if (stoppedRecording) {
        if (shouldRefineMeeting) void refineMeetingTranscript(io, socket, meetingSession, stoppedRecording, normalizeMeetingId(options.refinementId) || randomUUID());
        else removeMeetingRecordingFiles(stoppedRecording);
      } else if (shouldRefineMeeting && socket.connected) {
        socket.emit('meeting:refine_error', { meetingId: meetingSession.meetingId, refinementId: normalizeMeetingId(options.refinementId), sessionId, message: 'The meeting recording is unavailable; keeping the live transcript.' });
      }
    }
  };

  const callAdmission = createVoiceCallAdmission();
  let pendingStandardStart: { sessionId: string; cancelled: boolean } | undefined;
  let proactiveContext: ProactiveContext | null = null;
  let proactiveController: AbortController | null = null;
  const cancelProactive = () => { proactiveController?.abort(); proactiveController = null; };
  return {
    socket,
    llmGetters,
    sensoryFn,
    getUserId,
    io,
    commitActiveVoiceCancellation,
    stopVoiceCall,
    callAdmission,
    get pendingStandardStart() { return pendingStandardStart; },
    set pendingStandardStart(value: { sessionId: string; cancelled: boolean } | undefined) { pendingStandardStart = value; },
    get proactiveContext() { return proactiveContext; },
    set proactiveContext(value: ProactiveContext | null) { proactiveContext = value; },
    get proactiveController() { return proactiveController; },
    set proactiveController(value: AbortController | null) { proactiveController = value; },
    cancelProactive,
  };
}
type VoiceConnectionRuntime = ReturnType<typeof createVoiceConnectionRuntime>;

type StandardVoiceStartRequest = {
    voiceId?: string;
    personalityId?: string;
    agentId?: string;
    transcriptionOnly?: boolean;
    meetingId?: string;
    domain?: 'personal' | 'work';
    orgId?: string;
    sessionId?: string;
    audioInputKind?: string;
    captureSessionId?: string;
  };

async function handleStandardVoiceStart(runtime: VoiceConnectionRuntime, data: StandardVoiceStartRequest): Promise<void> {

    logger.info(`[Audio] Voice call started by ${runtime.socket.id}`);
    runtime.cancelProactive();
    const pendingOwner = { sessionId: normalizeVoiceSessionId(data.sessionId), cancelled: false };
    runtime.pendingStandardStart = pendingOwner;
    let admittedSession: AudioSession | undefined;
    const candidate = runtime.callAdmission.claim(async () => {
      pendingOwner.cancelled = true;
      if (admittedSession) await runtime.stopVoiceCall(admittedSession, { source: 'voice_call_replaced', error: { code: 'CALL_REPLACED', message: 'Another voice call started.' } });
    }, 'lumi');
    const reservation = candidate instanceof Promise ? await candidate : candidate;
    if (!reservation.isCurrent() || !runtime.socket.connected || pendingOwner.cancelled || runtime.pendingStandardStart !== pendingOwner) { reservation.release(); return; }
    runtime.pendingStandardStart = undefined;
    const session = getAudioSession(runtime.socket);
    admittedSession = session;
    const startControlGeneration = ++session.callControlGeneration;
    session.stopAuthorizationWatch?.();
    session.stopAuthorizationWatch = undefined;
    // Reserve the incoming id before waiting, so a stop for this pending start
    // can cancel it and old STT callbacks cannot admit work into it.
    session.sessionId = pendingOwner.sessionId;
    const voiceStartSessionId = session.sessionId;
    session.isActive = false;
    if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
    const previousSttSession = session.sttSession;
    session.sttSession = null;
    try { previousSttSession?.end(); } catch (error) { logger.warn('[Audio] Previous STT close failed:', error); }
    // Even an inactive call can still have cancellation timers awaiting
    // convergence. The new owner must finish clearing those before admission.
    if (session.userId) {
      setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, false);
      if (session.activeTurnRequestId) {
        await runtime.commitActiveVoiceCancellation(session, { source: 'voice_restarted' });
      } else {
        await cancelActiveVoiceTurn(session);
      }
    }
    if (session.callControlGeneration !== startControlGeneration || !runtime.socket.connected) return;
    session.isActive = true;
    session.voiceSwitchGeneration += 1;
    const voiceStartGeneration = session.voiceSwitchGeneration;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.isProcessing = false;
    session.isBackgroundWork = false;
    session.activeWorkStatus = 'idle';
    session.activeWorkStep = '';
    session.activeWorkToolCalls = 0;
    session.sidecarAbortController?.abort();
    session.sidecarAbortController = null;
    session.sidecarGeneration++;
    session.sidecarHistory = [];
    session.inputQueue = [];
    session.lastChunkTime = 0;
    session.lastSpeechEndedAt = 0;
    session.lastSpeechStartedAt = 0;
    session.endpointSilenceMs = 850;
    session.lastAcceptedCommandKey = '';
    session.lastAcceptedCommandAt = 0;
    session.lastAcceptedCommandChunkAt = 0;
    session.userId = runtime.getUserId(runtime.socket);
    setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, true);
    const requestedAgentId = String(data.agentId || 'lumi').trim() || 'lumi';
    // Memory Avatars are deliberately text-only, frozen, tool-free surfaces.
    // Voice currently uses the full Lumi execution lane, so accepting a
    // memory_avatar_* id here would silently bypass that boundary. Reject it
    // explicitly until a separately constrained voice lane exists.
    if (requestedAgentId.startsWith('memory_avatar_')) {
      logger.warn(`[Audio] Refused voice start for Memory Avatar lane: ${requestedAgentId}`);
      session.isActive = false;
      setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, false);
      session.agentId = 'lumi';
      runtime.socket.emit('audio:error', {
        code: 'MEMORY_AVATAR_VOICE_UNAVAILABLE',
        message: 'Memory Avatars are available in their private text sanctuary, not in the voice execution lane.',
      });
      return;
    }
    session.agentId = requestedAgentId;
    session.voiceCaptureProvenance = createVoiceCaptureProvenance({
      captureSessionId: String(data.captureSessionId || '') === session.sessionId
        ? data.captureSessionId
        : '',
      audioInputKind: data.audioInputKind,
      nativeBinding: buildSocketNativeRequestBinding(runtime.socket),
      syntheticBinding: getTaskRegressionSyntheticVoiceBinding(),
    });
    session.activeTurnProvenance = null;
    session.activeForegroundRequestIdentity = null;
    const sessionScope = resolveSocketScope(runtime.socket, session.userId, data);
    session.domain = sessionScope.domain;
    session.orgId = sessionScope.orgId;
    if (runtime.socket.data?.authenticatedOrgId && sessionScope.domain !== 'work') {
      await runtime.stopVoiceCall(session, { source: 'voice_authorization_revoked', error: { code: 'ORGANIZATION_ACCESS_CHANGED', message: 'Organization access changed. Start a new authorized session.' } });
      return;
    }
    const authorization = captureChatAuthorization(session.userId, sessionScope);
    session.authorization = authorization;
    const authorizationAbort = new AbortController();
    let authorizationCancellation: Promise<void> | undefined;
    session.cancelAuthorizationTurn = (requestId: string) => {
      if (session.authorization !== authorization || session.activeTurnRequestId !== requestId) return Promise.resolve();
      if (!authorizationCancellation) authorizationCancellation = runtime.commitActiveVoiceCancellation(session, {
        source: 'voice_authorization_revoked',
      }).then(() => undefined);
      return authorizationCancellation;
    };
    authorizationAbort.signal.addEventListener('abort', () => {
      if (session.authorization !== authorization) return;
      session.isActive = false;
      queueMicrotask(() => { if (session.authorization === authorization) session.stopAuthorizationWatch?.(); });
      quiesceActiveVoiceTransport(session);
      session.inputQueue = [];
      if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
      const revokedStt = session.sttSession;
      session.sttSession = null;
      try { revokedStt?.end(); } catch { /* The revoked call remains closed. */ }
      setRealtimeVoiceSessionActive(session.userId, runtime.socket.id, false);
      runtime.socket.emit('audio:error', { code: 'ORGANIZATION_ACCESS_CHANGED', message: 'Organization access changed. Start a new authorized session.', sessionId: voiceStartSessionId });
    }, { once: true });
    session.stopAuthorizationWatch = authorization.watch(authorizationAbort);

    session.transcriptionOnly = data.transcriptionOnly === true;
    if (session.meetingCapture) session.meetingCapture.closed = true;
    session.meetingCapture = undefined;
    session.meetingId = normalizeMeetingId(data.meetingId) || session.sessionId;
    session.meetingPcmPath = null;
    session.meetingPcmBytes = 0;
    session.meetingStartedAt = 0;
    if (session.transcriptionOnly) {
      try {
        startMeetingPcmRecording(session);
      } catch (err: any) {
        logger.warn(`[Meeting] Failed to start PCM recording: ${err?.message || err}`);
      }
    }
    const enrolledVoiceprints = session.domain === 'personal' && session.userId ? getVoiceprints(session.userId) : [];
    session.voiceprintRequired = enrolledVoiceprints.length > 0;
    session.voiceprintMatched = !session.voiceprintRequired;
    session.voiceprintConfidence = 0;
    session.voiceprintSpeakerLabel = null;
    session.voiceprintSource = '';
    session.voiceprintLastAt = 0;
    session.voiceprintUtteranceEpoch += 1;
    resetUtteranceVoiceprint(session);
    runtime.socket.emit('voiceprint:utterance_reset', { epoch: session.voiceprintUtteranceEpoch });
    const personalityCfg = personalityRegistry.getForUser(
      data.personalityId || 'lumi',
      session.userId,
      session.domain === 'work' ? session.orgId : undefined,
    );
    // Use explicit voiceId, then personality's TTS voice. Reconcile that id
    // with the active TTS provider before the first utterance; preview calls
    // carry a provider explicitly but the realtime socket does not.
    const requestedVoiceId = normalizeVoiceSwitchId(data.voiceId || personalityCfg?.ttsVoiceId) || null;
    const voiceScope = voiceProfileScope(session.userId, session.domain, session.orgId);
    if (requestedVoiceId && !isVoiceProfileAccessible(voiceScope, requestedVoiceId)) {
      logger.warn(`[Audio] Refused voice profile from another domain: ${requestedVoiceId}`);
      session.currentVoiceId = null;
      runtime.socket.emit('audio:voice_unavailable', {
        reason: 'voice_profile_scope_mismatch',
        requestedVoiceId,
        currentVoiceId: session.currentVoiceId,
        sessionId: session.sessionId,
      });
    } else {
      const activeTtsProvider = getTTSProvider();
      if (activeTtsProvider) {
        try {
          const voiceResolution = await resolveVoiceForProvider(
            voiceScope,
            activeTtsProvider,
            requestedVoiceId,
          );
          if (session.callControlGeneration !== startControlGeneration) return;
          const voiceStartFence = resolveVoiceStartAsyncFence({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            startSessionId: voiceStartSessionId,
            currentVoiceSwitchGeneration: session.voiceSwitchGeneration,
            startVoiceSwitchGeneration: voiceStartGeneration,
          });
          if (voiceStartFence === 'abandon_start') return;
          if (voiceStartFence === 'current') {
            session.currentVoiceId = voiceResolution.voiceId;
            if (voiceResolution.voiceId && voiceResolution.voiceId !== requestedVoiceId) {
              logger.info(
                `[Audio] Reconciled live voice for provider=${activeTtsProvider} requested=${requestedVoiceId || 'none'} resolved=${voiceResolution.voiceId}`,
              );
              runtime.socket.emit('audio:voice_changed', {
                voiceId: voiceResolution.voiceId,
                previousVoiceId: requestedVoiceId,
                sessionId: session.sessionId,
                provider: activeTtsProvider,
                fallback: true,
                reason: 'provider_compatibility',
              });
            }
          }
        } catch (error: any) {
          if (session.callControlGeneration !== startControlGeneration) return;
          const voiceStartFence = resolveVoiceStartAsyncFence({
            sessionActive: session.isActive,
            currentSessionId: session.sessionId,
            startSessionId: voiceStartSessionId,
            currentVoiceSwitchGeneration: session.voiceSwitchGeneration,
            startVoiceSwitchGeneration: voiceStartGeneration,
          });
          if (voiceStartFence === 'abandon_start') return;
          if (voiceStartFence === 'current') {
            session.currentVoiceId = requestedVoiceId;
            logger.warn(
              `[Audio] Could not reconcile live voice for provider=${activeTtsProvider}: ${error?.message || String(error)}`,
            );
            if (!session.transcriptionOnly) emitVoiceTtsFailure(runtime.socket, undefined, 'conversation');
          }
        }
      } else {
        // Preserve the requested id so a provider that recovers during this
        // call can reconcile it at synthesis time. STT remains usable.
        session.currentVoiceId = requestedVoiceId;
        if (!session.transcriptionOnly) emitVoiceTtsFailure(runtime.socket, undefined, 'conversation');
      }
    }
    session.personalityId = data.personalityId || 'lumi';
  return startVoiceTranscription(runtime, session, startControlGeneration, voiceStartSessionId, authorization);
}

async function startVoiceTranscription(
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

function registerVoiceCaptureAndControl(runtime: VoiceConnectionRuntime) {


  runtime.socket.on('audio:switch-voice', async (data: VoiceSwitchRequest = {}) => {
    const session = getAudioSession(runtime.socket);
    const switchGeneration = ++session.voiceSwitchGeneration;
    const requestedVoiceId = normalizeVoiceSwitchId(data?.voiceId);
    const scope = voiceProfileScope(session.userId, session.domain, session.orgId);
    const available = requestedVoiceId
      ? await isVoiceSwitchSelectionAvailable(scope, requestedVoiceId)
      : false;
    if (session.voiceSwitchGeneration !== switchGeneration) {
      runtime.socket.emit('audio:voice_unavailable', {
        accepted: false,
        reason: 'voice_switch_superseded',
        requestedVoiceId,
        currentVoiceId: session.currentVoiceId,
        sessionId: session.sessionId,
      });
      return;
    }
    const resolution = applyVoiceSwitchRequest(
      session,
      data,
      isVoiceProfileAccessible,
      () => available,
    );
    if (!resolution.accepted) {
      runtime.socket.emit('audio:voice_unavailable', resolution);
      return;
    }

    runtime.socket.emit('audio:voice_changed', {
      voiceId: resolution.voiceId,
      previousVoiceId: resolution.previousVoiceId,
      sessionId: resolution.sessionId,
    });
  });

  const resolveMeetingRequest = (data: { meetingId?: string; refinementId?: string }) => {
    const userId = runtime.getUserId(runtime.socket);
    const scope = resolveSocketScope(runtime.socket, userId);
    if (!userId || (runtime.socket.data?.authenticatedOrgId && scope.domain !== 'work')) throw new Error('Organization access changed.');
    const meetingId = normalizeMeetingId(data?.meetingId);
    if (!meetingId) throw new Error('A meeting identity is required.');
    const authorization = captureChatAuthorization(userId, scope);
    const directory = getMeetingAudioDir({ userId, domain: scope.domain, orgId: scope.orgId });
    const recording = findPausedMeetingRecording(directory, meetingId, meetingAuthorizationKey(userId, scope), authorization.isCurrent);
    return { recording, snapshot: { ...getAudioSession(runtime.socket), ...scope, userId, meetingId, authorization } };
  };
  runtime.socket.on('meeting:refine', (data: { meetingId?: string; refinementId?: string }) => {
    const identity = { meetingId: normalizeMeetingId(data?.meetingId), refinementId: normalizeMeetingId(data?.refinementId) };
    try {
      const { recording, snapshot } = resolveMeetingRequest(data);
      const detached = recording && takeMeetingRecording(recording);
      if (!detached) throw new Error('No paused recording is available; keeping the live transcript.');
      void refineMeetingTranscript(runtime.io, runtime.socket, snapshot, detached, identity.refinementId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Meeting recording is unavailable.';
      runtime.socket.emit('meeting:refine_error', { ...identity, message, ...(/authorization|Organization access/i.test(message) ? { reason: 'authorization_revoked' } : {}) });
    }
  });
  runtime.socket.on('meeting:discard', (data: { meetingId?: string }) => {
    try {
      const { recording } = resolveMeetingRequest(data);
      const detached = recording && takeMeetingRecording(recording);
      if (detached) removeMeetingRecordingFiles(detached);
    } catch { /* A discard never grants access to a recording owned by another identity. */ }
  });

  let chunkCount = 0;
  runtime.socket.on("audio:chunk", (data: Buffer) => {
    const session = getAudioSession(runtime.socket);
    if (!session.isActive || session.authorization?.isCurrent() === false) return;
    session.lastChunkTime = Date.now();
    resetSilenceTimer(session, runtime.socket);
    if (session.transcriptionOnly && session.meetingPcmPath) {
      try {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (session.meetingCapture) appendMeetingAudio(session.meetingCapture, chunk);
        session.meetingPcmBytes = session.meetingCapture?.bytes || 0;
      } catch (err: any) {
        logger.warn(`[Meeting] Failed to append PCM chunk: ${err?.message || err}`);
      }
    }
    if (session.sttSession) {
      recordVoiceCaptureChunk(session.voiceCaptureProvenance);
      session.sttSession.sendAudio(data);
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 50 === 0) {
        const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let sumSquares = 0;
        let peak = 0;
        const sampleCount = Math.floor(pcm.length / 2);
        for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
          const normalized = pcm.readInt16LE(offset) / 32768;
          sumSquares += normalized * normalized;
          peak = Math.max(peak, Math.abs(normalized));
        }
        const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
        logger.info(
          `[Audio] Sent ${chunkCount} chunks (${data.length} bytes each, rms=${rms.toFixed(4)}, peak=${peak.toFixed(4)})`,
        );
      }
    }
  });

  // ── Voiceprint: receive MFCC match results from frontend hook ──
  runtime.socket.on("voiceprint:result", (data: { isOwnerSpeaking: boolean; confidence: number; speakerLabel?: string | null; source?: string; quality?: number; frameCount?: number; reason?: string; utteranceEpoch?: number }) => {
    const session = getAudioSession(runtime.socket);
    if (session.domain === 'work') return;
    session.voiceprintMatched = data.isOwnerSpeaking === true;
    session.voiceprintConfidence = Number(data.confidence) || 0;
    session.voiceprintSpeakerLabel = data.speakerLabel || null;
    session.voiceprintSource = data.source || '';
    session.voiceprintLastAt = Date.now();

    const resultEpoch = Number(data.utteranceEpoch);
    if (
      session.voiceprintRequired
      && (!Number.isInteger(resultEpoch) || resultEpoch !== session.voiceprintUtteranceEpoch)
    ) {
      logger.info(`[Voiceprint] Ignored stale/untagged result epoch=${Number.isFinite(resultEpoch) ? resultEpoch : '-'} current=${session.voiceprintUtteranceEpoch}`);
      return;
    }

    session.utteranceVoiceprintDecided = true;
    session.utteranceVoiceprintMatched = data.isOwnerSpeaking === true;
    session.utteranceVoiceprintConfidence = Number(data.confidence) || 0;
    session.utteranceVoiceprintQuality = Number(data.quality) || 0;
    session.utteranceVoiceprintFrameCount = Math.max(0, Math.floor(Number(data.frameCount) || 0));
    session.utteranceVoiceprintSpeakerLabel = data.speakerLabel || null;
    session.utteranceVoiceprintSource = data.source || '';
    session.utteranceVoiceprintLastAt = Date.now();
    logger.info(`[Voiceprint] result epoch=${resultEpoch} source=${data.source || 'unknown'} matched=${data.isOwnerSpeaking} conf=${session.utteranceVoiceprintConfidence.toFixed(2)} quality=${session.utteranceVoiceprintQuality.toFixed(2)} frames=${session.utteranceVoiceprintFrameCount} reason=${data.reason || '-'}`);
  });

  runtime.socket.on('audio:playback_started', (data: { requestId?: string; lane?: string; durationMs?: number; clientDecodeMs?: number; clientReceiptToPlaybackMs?: number }) => {
    const requestId = String(data?.requestId || '').trim();
    if (!requestId.startsWith('voice_')) return;
    const session = getAudioSession(runtime.socket);
    const durationMs = Math.max(250, Math.min(120_000, Number(data?.durationMs) || 3_000));
    session.ttsPlaybackUntil = Math.max(session.ttsPlaybackUntil, Date.now() + durationMs + 250);
    recordVoicePlaybackMetrics(requestId, data);
    markVoiceLatencyMilestone(requestId, 'firstPlaybackAt');
    logger.info(
      `[Audio Playback] Acknowledged request=${requestId} lane=${data?.lane || 'conversation'} durationMs=${durationMs}`,
    );
  });

  // ── Presence: periodic heartbeat from usePresence hook ──
  runtime.socket.on("presence:heartbeat", (data: { facePresent: boolean; faceMatched?: boolean; faceConfidence: number; voiceprintMatched: boolean; voiceprintConfidence: number }) => {
    const userId = runtime.getUserId(runtime.socket);
    const presenceScope = resolveSocketScope(runtime.socket, userId);
    if (presenceScope.domain === 'work') {
      runtime.socket.emit('presence:state_change', { isAway: true, status: 'unavailable_in_organization' });
      return;
    }
    const state = updatePresence(userId, {
      facePresent: data.facePresent === true,
      faceMatched: data.faceMatched === true,
      faceConfidence: Number(data.faceConfidence) || 0,
      voiceprintMatched: data.voiceprintMatched === true,
      voiceprintConfidence: Number(data.voiceprintConfidence) || 0,
    });
    const status = state.isAway ? 'away' : (state.faceMatched || state.voiceprintMatched ? 'present' : 'uncertain');
    runtime.socket.emit('presence:state_change', { isAway: state.isAway, status });
  });

  runtime.socket.on('audio:interrupt-candidate', (data?: {
    source?: string;
    rms?: number;
    threshold?: number;
    frames?: number;
    ttsAgeMs?: number;
  }) => {
    const session = getAudioSession(runtime.socket);
    logger.info(`[Audio] Interrupt candidate source=${String(data?.source || 'unknown')} rms=${Number(data?.rms || 0).toFixed(4)} threshold=${Number(data?.threshold || 0).toFixed(4)} frames=${Math.max(0, Number(data?.frames || 0))} ttsAgeMs=${Math.max(0, Number(data?.ttsAgeMs || 0))} speaking=${session.isSpeaking} processing=${session.isProcessing} request=${session.activeTurnRequestId || 'none'}`);
  });

  runtime.socket.on("audio:interrupt", async (data?: { source?: string; sessionId?: string; requestId?: string }) => {
    logger.info(`[Audio] Interrupt source=${String(data?.source || 'legacy')} socket=${runtime.socket.id}`);
    const session = getAudioSession(runtime.socket);
    if (data?.sessionId && data.sessionId !== session.sessionId) return;
    if (data?.requestId && data.requestId !== session.activeTurnRequestId) return;
    const owner = captureVoiceTurnOwner(session);
    const sessionId = session.sessionId;
    const requestId = session.activeTurnRequestId;
    if (session.isBackgroundWork && session.isProcessing && session.pipelineAbortController) {
      const workRequestId = session.activeTurnRequestId;
      if (workRequestId) session.suppressedSpeechRequestIds.add(workRequestId);
      interruptVoiceSpeech(session);
      runtime.socket.emit("audio:status", { status: "interrupted", sessionId, requestId: workRequestId });
      runtime.socket.emit("audio:interrupt-ack", { workContinues: true, sessionId, requestId: workRequestId });
      return;
    }
    await runtime.commitActiveVoiceCancellation(session, { source: 'voice_interrupt' });
    if (!owner.isCurrent()) return;
    runtime.socket.emit("audio:status", { status: "interrupted", sessionId, requestId });
    runtime.socket.emit("audio:interrupt-ack", { workContinues: false, sessionId, requestId });
  });

  runtime.socket.on('audio:cancel_turn', async (data?: { requestId?: string; reason?: string; sessionId?: string }) => {
    const session = getAudioSession(runtime.socket);
    if (data?.sessionId && data.sessionId !== session.sessionId) return;
    const owner = captureVoiceTurnOwner(session);
    const sessionId = session.sessionId;
    const requestId = session.activeTurnRequestId;
    if (!requestId || (data?.requestId && data.requestId !== requestId)) return;
    if (data?.reason === 'thinking_watchdog') {
      logger.warn(`[Audio] Ignored legacy UI watchdog cancellation for live request ${requestId}`);
      if (session.isBackgroundWork && session.isProcessing) {
        emitVoiceWorkProgress(
          runtime.socket,
          session,
          requestId,
          session.activeWorkStatus,
          undefined,
          true,
        );
      } else {
        runtime.socket.emit('audio:status', { status: 'thinking', requestId });
      }
      return;
    }
    logger.warn(`[Audio] Cancelling stuck voice turn ${requestId} (${data?.reason || 'client_request'})`);
    await runtime.commitActiveVoiceCancellation(session, {
      source: 'voice_turn_cancelled',
    });
    if (!owner.isCurrent()) return;
    runtime.socket.emit('audio:interrupt-ack', { workContinues: false, requestId, sessionId });
    runtime.socket.emit('audio:status', { status: 'listening', requestId, sessionId });
    resetSilenceTimer(session, runtime.socket);
  });

  runtime.socket.on('audio:work_status_probe', (data?: { requestId?: string; lane?: string }) => {
    const session = getAudioSession(runtime.socket);
    const requestId = session.activeTurnRequestId;
    const requestedRequestId = String(data?.requestId || '').trim();
    if (requestedRequestId) {
      const recovered = getChatExecution({
        userId: session.userId,
        domain: session.domain,
        orgId: session.orgId,
        source: 'voice',
      }, requestedRequestId);
      if (recovered?.terminalEvent) {
        runtime.socket.emit(recovered.terminalEvent.event, recovered.terminalEvent.payload);
        runtime.socket.emit('audio:status', { status: 'listening', requestId: requestedRequestId });
        return;
      }
      if (recovered && !recovered.terminal && !requestId) {
        runtime.socket.emit('audio:status', {
          status: recovered.status === 'waiting_confirmation' ? 'listening' : 'thinking',
          requestId: requestedRequestId,
          lane: data?.lane || 'work',
        });
        return;
      }
    }
    if (!requestId || (data?.requestId && data.requestId !== requestId)) {
      runtime.socket.emit('audio:status', { status: 'listening', requestId: data?.requestId });
      return;
    }
    if (session.isBackgroundWork && session.isProcessing) {
      emitVoiceWorkProgress(
        runtime.socket,
        session,
        requestId,
        session.activeWorkStatus,
        undefined,
        true,
      );
      return;
    }
    runtime.socket.emit('audio:status', {
      status: session.isProcessing ? 'thinking' : 'listening',
      requestId,
      lane: data?.lane || 'conversation',
    });
  });

  runtime.socket.on("audio:stop", async (data?: { refineTranscript?: boolean; preserveMeeting?: boolean; refinementId?: string; sessionId?: string }) => {
    logger.info(`[Audio] Voice call ended by ${runtime.socket.id}`);
    if (runtime.pendingStandardStart && (!data?.sessionId || data.sessionId === runtime.pendingStandardStart.sessionId)) {
      runtime.pendingStandardStart.cancelled = true;
      runtime.pendingStandardStart = undefined;
      return;
    }
    const session = getAudioSession(runtime.socket);
    if (data?.sessionId && session.sessionId && data.sessionId !== session.sessionId) return;
    await runtime.stopVoiceCall(session, { source: 'voice_call_stopped', refineTranscript: data?.refineTranscript, preserveMeeting: data?.preserveMeeting, refinementId: data?.refinementId });
  });
}

function registerVoiceProactiveOutput(runtime: VoiceConnectionRuntime) {

  runtime.socket.on('proactive:configure', (data: Partial<ProactiveContext>) => {
    runtime.cancelProactive();
    runtime.proactiveContext = null;
    const userId = runtime.getUserId(runtime.socket);
    const scope = resolveAuthorizedSocketScope(runtime.socket, userId);
    const contextId = normalizeVoiceSessionId(data?.contextId);
    if (!scope || !contextId || data?.userId !== userId || data.domain !== scope.domain || String(data.orgId || '') !== scope.orgId) return;
    runtime.proactiveContext = { contextId, userId, ...scope, voiceId: normalizeVoiceSwitchId(data.voiceId) || null, enabled: data.enabled === true };
  });
  function beginProactive() {
    const context = runtime.proactiveContext;
    if (!context?.enabled || runtime.proactiveController || runtime.callAdmission.hasCall() || !runtime.socket.connected) return null;
    const scope = resolveAuthorizedSocketScope(runtime.socket, runtime.getUserId(runtime.socket));
    if (!scope || runtime.getUserId(runtime.socket) !== context.userId || scope.domain !== context.domain || scope.orgId !== context.orgId) return null;
    const authorization = captureChatAuthorization(context.userId, scope);
    if (!authorization.isCurrent() || shouldStayQuiet(context.userId).quiet) return null;
    // A notification must not need an earlier microphone call to initialize
    // identity, emotional state, model preferences or the selected speaker.
    const session: AudioSession = { ...getAudioSession(runtime.socket), userId: context.userId, ...scope, personalityId: 'lumi', currentVoiceId: context.voiceId };
    const controller = new AbortController();
    runtime.proactiveController = controller;
    const stopWatch = authorization.watch(controller);
    const assertCurrent = () => {
      authorization.assertCurrent();
      if (controller.signal.aborted || runtime.proactiveContext !== context || !runtime.socket.connected || runtime.getUserId(runtime.socket) !== context.userId || runtime.callAdmission.hasCall() || shouldStayQuiet(context.userId).quiet) {
        throw new DOMException('Proactive voice is no longer allowed', 'AbortError');
      }
    };
    return {
      session, authorization, controller, assertCurrent,
      envelope: { contextId: context.contextId, userId: context.userId, domain: context.domain, orgId: context.orgId },
      release: () => { stopWatch(); if (runtime.proactiveController === controller) runtime.proactiveController = null; },
    };
  }
  runtime.socket.on('disconnect', () => { runtime.proactiveContext = null; runtime.cancelProactive(); });
  runtime.socket.on("ambient:noise_level", (data: { rms: number; isSpeaking: boolean; callState: string }) => {
    voiceTransportState.ambientRms = data.rms;
    voiceTransportState.ambientRmsLastUpdate = Date.now();
  });

  /**
   * Night / Focus quiet mode: determine whether Lumi should suppress proactive speech.
   */
  function shouldStayQuiet(userId: string): { quiet: boolean; reason: string } {
    const hour = new Date().getHours();
    const nightHours = hour >= 23 || hour < 7;
    const gate = getGateConfig(userId);
    const withinQuietHours = gate.quietHoursStart === gate.quietHoursEnd
      || (gate.quietHoursStart < gate.quietHoursEnd
        ? hour >= gate.quietHoursStart && hour < gate.quietHoursEnd
        : hour >= gate.quietHoursStart || hour < gate.quietHoursEnd);
    if (gate.quietHoursEnabled && withinQuietHours) return { quiet: true, reason: 'user_quiet_hours' };

    if (nightHours) {
      return { quiet: true, reason: 'night_hours' };
    }

    try {
      const idleState = getIdleState(userId);
      if (idleState.isIdle && idleState.idleSince) {
        const idleMs = Date.now() - new Date(idleState.idleSince).getTime();
        const idleHours = idleMs / (1000 * 60 * 60);
        if (idleHours > 2) {
          return { quiet: true, reason: 'user_flow_state' };
        }
      }
    } catch {}

    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.15) {
      return { quiet: true, reason: 'meeting_detected' };
    }

    return { quiet: false, reason: '' };
  }

  const reportProactiveFailure = (operation: NonNullable<ReturnType<typeof beginProactive>>) => {
    try { operation.assertCurrent(); } catch { return; }
    runtime.socket.emit('audio:proactive_error', { ...operation.envelope, code: 'VOICE_OUTPUT_UNAVAILABLE' });
  };

  runtime.socket.on("proactive:request_speak", async (data: { message: string; interactionId?: string }) => {
    if (typeof data?.message !== 'string' || !data.message.trim() || data.message.length > 4000) return;
    const operation = beginProactive();
    if (!operation) return;
    const reminder = data.interactionId === undefined ? null : claimReminderVoiceDelivery(data.interactionId, {
      userId: operation.session.userId, domain: operation.session.domain, orgId: operation.session.orgId || '',
    });
    try {
    // Supplying an invalid receipt must never fall back to trusted reminder behavior.
    if (data.interactionId !== undefined && !reminder) return;
    const { session, authorization } = operation;
    const userId = session.userId;

    session.isSpeaking = true;
    const resetSpeaking = () => { session.isSpeaking = false; };
    const finalizedProactive = reminder ? { blocked: false, text: reminder.text, reason: '' } : finalizeLumiResponse({
      taskText: 'Proactive spoken notification',
      responseText: data.message,
      toolRecords: [],
      source: 'proactive_voice',
    });
    if (finalizedProactive.blocked) {
      resetSpeaking();
      logger.warn(`[ProactiveVoice] Suppressed unverified execution claim: ${finalizedProactive.reason}`);
      return;
    }
    const proactiveText = finalizedProactive.text;

    // Gate: night/focus/meeting quiet mode
    const quietCheck = shouldStayQuiet(userId);
    if (quietCheck.quiet) {
      resetSpeaking();
      logger.info(`[ProactiveVoice] Suppressed for ${userId}: ${quietCheck.reason}`);
      return;
    }

    // Resolve voiceId: session first, then personality config, then give up
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.getForUser(
        session.personalityId || 'lumi',
        userId,
        session.domain === 'work' ? session.orgId : undefined,
      );
      voiceId = personalityCfg?.ttsVoiceId || null;
    }

    // Gate: check initiative level — Lumi only speaks first when comfortable enough
    const es = loadEmotionalState(getVoiceStateKey(session));
    if (!reminder && es.initiative < 0.4) { resetSpeaking(); return; }

    // Gate: don't interrupt when environment is noisy (user likely in a meeting)
    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.08) { resetSpeaking(); return; }

    const ttsProvider = getTTSProvider();
    if (!ttsProvider) { resetSpeaking(); reportProactiveFailure(operation); return; }
    const proactiveRoute = await resolveSingleVoiceTtsRoute(session, ttsProvider, voiceId);
    if (!proactiveRoute) { resetSpeaking(); reportProactiveFailure(operation); return; }

    let proactiveTtsCounted = false;
    const controller = operation.controller;
    const stopWatch = authorization.watch(controller);
    try {
      operation.assertCurrent();
      reminder?.assertCurrent();
      if (reminder) await reminder.confirmPersisted();
      operation.assertCurrent();
      voiceTransportState.ttsSpeakingCount++;
      proactiveTtsCounted = true;
      addEchoText(proactiveText, voiceEchoScope(session));
      const result = await synthesizeSpeech(proactiveText, {
        provider: proactiveRoute.provider,
        voiceId: proactiveRoute.voiceId,
        model: proactiveRoute.model,
        speechRate: proactiveRoute.speechRate,
        pitch: proactiveRoute.pitch,
        volume: proactiveRoute.volume,
        signal: controller.signal,
        allowFallback: false,
      });
      operation.assertCurrent();
      const proactiveGain = computeVolumeGain();
      const emitSpeech = () => runtime.socket.emit("audio:proactive_speak", {
        ...operation.envelope,
        ...(reminder ? { interactionId: reminder.interactionId } : {}),
        audioBuffer: result.audioBuffer,
        text: proactiveText,
        timestamp: new Date().toISOString(),
        volumeGain: proactiveGain,
      });
      if (reminder) await reminder.dispatch(operation.assertCurrent, emitSpeech);
      else emitSpeech();
      logger.info(`[ProactiveVoice] Audio dispatched for user ${userId}`);
    } catch (err: any) {
      logger.warn(`[ProactiveVoice] TTS failed: ${err.message}`);
      if (err?.name !== 'AbortError') reportProactiveFailure(operation);
    } finally {
      stopWatch();
      if (proactiveTtsCounted) voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1);
      resetSpeaking();
    }
    } finally { reminder?.release(); operation.release(); }
  });

  // LLM-generated greeting — replaces hardcoded templates with personalized, scene-aware greetings
  runtime.socket.on("greeting:generate", async (data: { scene?: string }) => {
    const operation = beginProactive();
    if (!operation) return;
    try {
    const { session, authorization } = operation;
    const userId = session.userId;
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.getForUser(
        session.personalityId || 'lumi',
        userId,
        session.domain === 'work' ? session.orgId : undefined,
      );
      voiceId = personalityCfg?.ttsVoiceId || null;
    }

    const es = loadEmotionalState(getVoiceStateKey(session));
    // This greeting is explicitly enabled by the user. Personality shapes its
    // tone; the default initiative must not silently disable that preference.

    // Build temporal context for scene-aware generation
    let temporalBlock = '';
    try {
      const { generateTemporalContext } = await import('../time/temporal_context');
      temporalBlock = generateTemporalContext(userId);
    } catch {}

    // Fetch a few recent memories for personalization
    let memoryContext = '';
    try {
      const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.5, domain: session.domain, orgId: session.orgId });
      if (recentMemories.length > 0) {
        memoryContext = recentMemories.map(m => `- ${m.content.slice(0, 150)}`).join('\n');
      }
    } catch {}

    // Fetch recent greetings to avoid repetition (greeting dedup)
    let dedupContext = '';
    try {
      const recentGreetings = queryMemories({
        userId,
        query: 'greeting',
        limit: 8,
        minConfidence: 0.5,
        domain: session.domain,
        orgId: session.orgId,
      });
      const greetingTexts = recentGreetings
        .filter(m => m.content.includes('[Greeting]') || m.keywords.includes('greeting'))
        .map(m => m.content.replace(/^\[Greeting\]\s*/, '').slice(0, 80));
      if (greetingTexts.length > 0) {
        dedupContext = `\nRecently used greetings (DO NOT repeat these — be completely fresh):\n${greetingTexts.map(g => `- "${g}"`).join('\n')}`;
      }
    } catch {}

    const scene = data.scene || 'return';
    const intimacy = es.intimacy || 0.3;
    const tone = intimacy > 0.6 ? 'warm and intimate' : intimacy > 0.3 ? 'friendly and natural' : 'polite and gentle';

    const greetingPrompt = [
      `Generate a brief, natural spoken greeting in Chinese (under 60 characters).`,
      `Scene: user just ${scene === 'return' ? 'returned to their computer after being away' : scene === 'morning' ? 'started their day' : scene === 'evening' ? 'is winding down' : ' needs a check-in'}.`,
      `Tone: ${tone}.`,
      temporalBlock ? `\nCurrent context:\n${temporalBlock}` : '',
      memoryContext ? `\nRecent topics:\n${memoryContext}\nReference one naturally if relevant.` : '',
      dedupContext,
      `\nDo NOT sound like a report or template. Sound like a friend who noticed they're back. Vary your phrasing — never repeat the same greeting.`,
    ].filter(Boolean).join('\n');

    const greetingTtsProvider = getTTSProvider();
    const greetingTtsRoute = greetingTtsProvider
      ? await resolveSingleVoiceTtsRoute(session, greetingTtsProvider, voiceId, false)
      : null;
    if (!greetingTtsRoute) { reportProactiveFailure(operation); return; }

    const controller = operation.controller;
    const stopWatch = authorization.watch(controller);
    let greetingSpeechAttempted = false;
    let greetingAudioDispatched = false;
    try {
      operation.assertCurrent();
      const greetingLLM = {
        ...getUserPreferredLLMConfig(session.userId, {
          maxTokens: 120,
          domain: session.domain,
          orgId: session.orgId,
        }),
        inputTokenBudget: VOICE_CHAT_INPUT_BUDGET_TOKENS,
        signal: controller.signal,
      };
      const response = await makeLLMCall(
        [{ role: 'user', content: greetingPrompt }],
        [],
        greetingLLM,
        ...providerGetterArguments(runtime.llmGetters),
      );

      operation.assertCurrent();
      recordTokenUsage(session.userId, greetingLLM.provider, greetingLLM.model, response.usage, `voice_greet_${Date.now()}`, 'voice');

      const greeting = response.text?.trim() || '';
      if (!greeting) throw new Error('Empty LLM response');
      const finalizedGreeting = finalizeLumiResponse({
        taskText: 'Generate a friendly spoken greeting',
        responseText: greeting,
        toolRecords: [],
        source: 'voice_greeting',
      });
      if (finalizedGreeting.blocked) {
        throw new Error(`Unverified greeting execution claim: ${finalizedGreeting.reason}`);
      }
      const spokenGreeting = finalizedGreeting.text;

      greetingSpeechAttempted = true;
      const result = await synthesizeSpeech(spokenGreeting, {
        provider: greetingTtsRoute.provider,
        voiceId: greetingTtsRoute.voiceId,
        model: greetingTtsRoute.model,
        signal: controller.signal,
        allowFallback: false,
      });
      operation.assertCurrent();
      runtime.socket.emit("audio:proactive_speak", {
        ...operation.envelope,
        audioBuffer: result.audioBuffer,
        text: spokenGreeting,
        timestamp: new Date().toISOString(),
        volumeGain: computeVolumeGain(),
      });
      greetingAudioDispatched = true;
      // Store greeting in memory for dedup
      addMemory({
        userId,
        type: 'fact',
        content: `[Greeting] ${spokenGreeting}`,
        keywords: ['greeting', scene, new Date().toISOString().slice(0, 10)],
        confidence: 1.0,
        sourceInteractionId: `greeting_${Date.now()}`,
        agentId: undefined,
      } as any, { tier: 'episodic', perspective: 'shared_memory', importance: 0.2, domain: session.domain, orgId: session.orgId, source: 'voice' });
      logger.info(`[Greeting] LLM-generated for ${userId} (${spokenGreeting.length} chars)`);
    } catch (err: any) {
      if (!authorization.isCurrent() || controller.signal.aborted) return;
      try { operation.assertCurrent(); } catch { return; }
      if (greetingSpeechAttempted) {
        // A failed TTS request must not cause a second request to the same
        // unavailable voice service. A memory save after dispatch must never
        // cause the already-delivered greeting to be spoken a second time.
        logger.warn(`[Greeting] ${greetingAudioDispatched ? 'Memory save after audio dispatch' : 'Speech synthesis'} failed: ${err.message}`);
        if (!greetingAudioDispatched) reportProactiveFailure(operation);
        return;
      }
      logger.warn(`[Greeting] LLM generation failed, using fallback: ${err.message}`);
      const hour = new Date().getHours();
      const fallback = hour < 6 ? '夜深了，还在忙吗？' : hour < 12 ? '早上好，欢迎回来。' : hour < 18 ? '下午好，继续吧。' : '晚上好，欢迎回来。';
      try {
        const result = await synthesizeSpeech(fallback, {
          provider: greetingTtsRoute.provider,
          voiceId: greetingTtsRoute.voiceId,
          model: greetingTtsRoute.model,
          signal: controller.signal,
        allowFallback: false,
        });
        operation.assertCurrent();
        runtime.socket.emit("audio:proactive_speak", { ...operation.envelope, audioBuffer: result.audioBuffer, text: fallback, timestamp: new Date().toISOString(), volumeGain: computeVolumeGain() });
      } catch (error: any) {
        logger.warn(`[Greeting] Fallback speech failed: ${error.message}`);
        if (error?.name !== 'AbortError') reportProactiveFailure(operation);
      }
    } finally { stopWatch(); }
    } finally { operation.release(); }
  });
}

function registerVoiceConnectionCleanup(runtime: VoiceConnectionRuntime) {


  runtime.socket.on("audio:switch-personality", (data: { personalityId: string }) => {
    const session = getAudioSession(runtime.socket);
    if (session.isActive) {
      session.personalityId = data.personalityId;
      logger.info(`[Audio] Personality switched to ${data.personalityId} mid-call`);
    }
  });

  runtime.socket.on("disconnect", async () => {
    if (runtime.pendingStandardStart) runtime.pendingStandardStart.cancelled = true;
    runtime.pendingStandardStart = undefined;
    const pausedSession = getAudioSession(runtime.socket);
    if (pausedSession.userId && pausedSession.meetingId) {
      releasePausedMeetingRecording(getMeetingAudioDir({ userId: pausedSession.userId, domain: pausedSession.domain, orgId: pausedSession.orgId }), pausedSession.meetingId);
    }

    const session = runtime.socket.data.audioSession as AudioSession | undefined;
    if (session) {
      await runtime.stopVoiceCall(session, { source: 'voice_disconnected', publish: false });
    }
    console.log(`[Socket] Client disconnected: ${runtime.socket.id}`);
  });
}

export function registerVoiceHandlers(socket: Socket, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, getUserId: (s: Socket) => string, io: Server) {
  const runtime = createVoiceConnectionRuntime(socket, llmGetters, sensoryFn, getUserId, io);

  registerMemoryAvatarVoiceHandlers(runtime.socket, runtime.llmGetters, runtime.getUserId, runtime.callAdmission);
  runtime.socket.on("audio:start", (data: StandardVoiceStartRequest) => handleStandardVoiceStart(runtime, data));
  registerVoiceCaptureAndControl(runtime);
  registerVoiceProactiveOutput(runtime);
  registerVoiceConnectionCleanup(runtime);
}

export { type VoiceSwitchRequest, type VoiceSwitchSession, clearVoiceSessionTtsSelection, type VoiceStartAsyncFence, resolveVoiceStartAsyncFence, type VoiceSwitchResolution, applyVoiceSwitchRequest, type ProviderVoiceResolution, type LockedVoiceTurnTtsRoute, lockVoiceTurnTtsRoute, canFallbackVoiceTurnTtsRoute, chooseVoiceForProvider } from "./voice/selection";
export { addEchoText, isEchoText, isPureInterruptCommand, isVoiceCallEndCommand, isEchoedImmediateVoiceControl } from "./voice/echo";
export { type VoiceprintUtteranceDecision, isVoiceprintUtteranceAccepted } from "./voice/voiceprint";
export { normalizeVoiceHistory, normalizeVoiceHistoryRecord } from './voice_history';
export type {
  ForegroundRequestIdentity as VoiceForegroundRequestIdentity,
  ForegroundRequestReleaseResult as VoiceForegroundRequestReleaseResult,
} from '../conversation/manager';
export { convergeVoiceForegroundRequestBeforeRelease, isTtsPlaying, quiesceActiveVoiceTransport, reservePriorityVoiceHandoff } from "./voice_transport_runtime";
