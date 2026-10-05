import { Server, Socket } from "socket.io";
import { type AudioSession, getVoiceStateKey, type VoiceInputTiming } from "./voice/session";
import type { LLMGetters as LlmGetters } from '../llm/dispatch';
import { reserveConversationExecution, type ConversationResourceLifetime } from '../cognition/conversation_execution';
import { isVoiceprintGateOpen, blockUnverifiedVoice } from "./voice/voiceprint";
import { captureChatAuthorization } from './chat_authorization';
import { assessVoiceTranscriptForExecution } from '../cognition/voice_transcript_guard';
import { logger } from "../../logger";
import { getConfiguredVoiceModel, getVoicePreference } from '../config/voice_preference';
import { synthesizeSpeech, getActiveProvider as getTTSProvider, getFallbackProvider as getTTSFallbackProvider, isTtsCancellationError, resolveEmotionVoice } from "../tts/adapter";
import { isVoiceCorrectionContinuation, isVoiceCurrentActivityQuestion, isVoiceReferentialFollowup, mergeInterruptedVoiceTurn } from "./voice_turn_state";
import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_FAST_PATH_MESSAGES, CN_VOICE_WORK_MESSAGES } from "../regions/packs/cn/voice_fast_path_messages";
import { getConversationForScope, getOrCreateActiveConversation, getOrCreateConversationForTurn, addMessageIdempotent, getMessages, getMessagesByTokenBudget, extractTopics, trackTopic, getTopicContext, getConversationSummary, getConversationActionStatus, prepareConversationActionExecution, persistConversationExecutionPlan, completeConversationActionFromUserObservation, createDurableForegroundReleaseGate, setConversationActionExecutionStatus, startConversationActionExecutionHeartbeat, updateConversationActionFocus, type ForegroundRequestIdentity as VoiceForegroundRequestIdentity } from "../conversation/manager";
import { buildForegroundWeChatSendArgs } from "../regions/packs/cn/foreground_wechat_intent";
import { ensurePendingConfirmationPersistenceInitialized } from '../tools/pending_confirmation_repository';
import { sanitizeVoiceAgentErrorPayload, voiceDurabilityUnknownText } from './voice_durability';
import { buildRecentActionContinuationBridge, formatConversationActionTaskStatus, isUserObservedTaskCompletion } from "../cognition/action_continuation";
import { randomUUID } from "node:crypto";
import { createVoiceExecutionReceiptCollector } from './voice_execution_receipts';
import { issueVoiceTurnProvenance } from './voice_provenance';
import { createModelTurnState } from '../llm/model_turn_state';
import { beginChatExecutionDurably, recordChatExecutionEvent, recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, type ChatExecutionScope } from './chat_execution_registry';
import { recoverBlockedExecutionOnce, sanitizeExecutionResponseForDelivery, sanitizeExecutionNotificationForDelivery } from "../cognition/execution_guard_recovery";
import { projectCustomerVisibleExecutionEvent } from './public_agent_event_projection';
import { buildSocketToolSecurityContext } from "./scope";
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, consumePendingConfirmationDurably, getPendingConfirmationDurably, formatPendingConfirmationRequest, recordPendingConfirmationDurably } from "../tools/pending_confirmation";
import { buildPendingAssistantOfferContextFromTranscript } from '../cognition/pending_assistant_offer';
import { resolveUserTurn } from '../cognition/turn_resolution';
import { admitAcceptedUserTurnDurably, resolveAcceptedTurnConfirmation, runAfterAcceptedUserTurnAdmission } from './action_turn_durability';
import { flushDBOrThrow } from "../../db_layer";
import { isCapabilityMetaQuestion } from "../cognition/capability_meta";
import { hasClientActionOnlyIntent, hasExplicitToolIntent, isUserCorrectionOrExplanationQuestion } from "../cognition/tool_intent";
import { markVoiceLatencyMilestone, startVoiceLatencyTrace } from "../monitor/voice_latency_store";
import { emitVoiceWorkProgress, startVoiceWorkHeartbeat, stopVoiceWorkHeartbeat } from "./voice/work_progress";
import { detectRequestedOperationMode, isPureOperationModeSwitchRequest, type OperationMode } from "../cognition/operation_modes";
import { collectAnticipatoryContext } from "../context/anticipatory_context";
import { queryMemories } from "../memory/store";
import { CONVERSATIONAL_MEMORY_EVIDENCE } from "../memory/types";
import { retrieveChunks } from "../agents/rag";
import { searchKnowledgeBase } from "../org/kb";
import { personalityRegistry } from "../personality";
import { getStoredOperationMode, saveStoredOperationMode } from "../cognition/operation_mode_store";
import { buildLumiExecutionPipeline } from "../cognition/execution_pipeline";
import { toolRegistry } from "../tools/registry";
import { TASK_TARGET_HISTORY_LIMIT } from '../conversation/task_target_anchor';
import { resolveVoiceModelInputBudget, VOICE_DESKTOP_LEASE_WAIT_MS } from './voice_runtime_policy';
import { buildDesktopExecutionStabilityPolicy } from "../cognition/desktop_execution_stability";
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from "../desktop/execution_runtime";
import { commitChatTerminalBoundary, persistAuthorizedTerminalReceipt } from './chat_terminal_boundary';
import { resolveSingleVoiceTtsRoute, type LockedVoiceTurnTtsRoute, resolveVoiceForProvider, lockVoiceTurnTtsRoute, canFallbackVoiceTurnTtsRoute } from "./voice/selection";
import { emitVoiceTtsFailure, voiceTransportState, computeVolumeGain, resetSilenceTimer, enforceVoiceForegroundConvergenceBeforeRelease } from "./voice_transport_runtime";
import { addEchoText, voiceEchoScope } from "./voice/echo";
import { bindCapabilityExecutionPlanTask } from "../cognition/capability_execution_plan";
import { coalesceToolExecutionRecords, recordsToTaskReceipts, taskReceiptsToRecords, confirmedStepNeedsContinuation, toolRecordSucceeded } from "../cognition/task_execution_ledger";
import { ToolExecutionRecord } from "../tools/types";
import { executionBoundaryPromptOverlay, restrictSystemPromptForExecutionBoundary, restrictVisibleToolNamesForExecutionBoundary } from "../tools/remote_policy";
import { buildInteractionModeOverlay } from "../cognition/turn_flow";
import { buildVisionRoutingOverlay } from "../cognition/vision_routing";
import { formatCompactClientSelfPrompt } from "../client/self_model";
import { buildLumiRuntimeCapabilityContext } from "../cognition/capability_context";
import { buildLumiOperatingKernelPrompt } from "../cognition/operating_kernel";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import { scheduleConversationSummary } from "../conversation/summary_scheduler";
import { isExplicitMemoryRequest, persistTurnMemory, scheduleTurnMemory } from '../memory/turn_memory';
import { createConversationReceiptObserver } from '../conversation/execution_receipt_archive';
import { isDirectDesktopTool, createDesktopRelay } from "./desktop_relay";
import { formatDesktopControlPausePresentation } from '../regions/packs/cn/desktop_control_messages';
import { buildDurableTaskDeterministicToolRecoveryCall } from '../cognition/deterministic_tool_recovery';
import { createTurnConfirmation } from '../tools/turn_confirmation';
import { createPreFinalizationTextGate, shouldDeferModelOutputUntilFinalized, shouldForwardPreFinalizationProgress } from "../cognition/response_delivery";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../personality/state";
import { buildConfirmedStepContinuationMessages, type LLMConfig, type LLMResult } from "../llm/adapter";
import { persistLumiPostTurnLearning } from "../cognition/post_turn_learning";
import { persistWorkTakeoverTurnExecution } from "../work_takeover/execution_writeback";
import type { TTSProvider } from '../tts/types';
import { voiceProfileScope } from '../tts/profile_store';
import { extractFirstCompleteSpeechSentence } from "../tts/speculative_sentence";
import { createVoiceTerminalCompletion } from "./voice/terminal_completion";
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from "../conversation/execution_facts";
import { resolveExactConversationCorrection } from "../conversation/exact_correction";
import { executeToolCall } from "../tools/execution_engine";
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from "../cognition/result_finalizer";
import { runToolSession } from "../llm/tool_session";
import { recordTokenUsage } from "../llm/token_tracker";
import { collectRecentActionToolRecords, describeRecentActionsFromHistory } from "./voice_action_history";
import { formatOperationModeSwitchResponse } from "../i18n/operation_mode_messages";
import { buildForegroundMessagingArguments, executeForegroundMessagingAction } from "../cognition/foreground_messaging_execution";
import { formatCnVoiceWeChatSendError, formatCnVoiceWeChatSendResult } from "../regions/packs/cn/messaging_messages";
import { NormalizedMessage } from "../llm/providers";
import { normalizeVoiceHistory } from './voice_history';
import { runConversationTurn } from "../llm/conversation_turn";
import { shouldBlockForDesktopControlPause } from '../cognition/desktop_control_pause';
import { extractSentiment } from "../cognition/sentiment";
import { himTick } from "../personality/him";
import { shouldAllowVoiceLocalFileWriteForTurn, buildVoiceReplyStyleOverlay } from "./voice_turn_policy";

export async function processVoiceInput(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
  userReceivedAt = new Date().toISOString(),
  voiceAuthorized = false,
  inputTiming: VoiceInputTiming = {},
  resources: ConversationResourceLifetime = {},
): Promise<void> {
  if (!voiceAuthorized && !isVoiceprintGateOpen(session)) {
    blockUnverifiedVoice(socket, session, 'Rejected voice command from unverified speaker');
    return;
  }

  const turnAuthorization = session.authorization || captureChatAuthorization(session.userId, session);
  if (!turnAuthorization.isCurrent()) return;
  let transcriptExecutionGuard = assessVoiceTranscriptForExecution(userText);
  if (transcriptExecutionGuard.action === 'clarify') {
    logger.warn(
      `[Audio] Guarded uncertain final transcript reason=${transcriptExecutionGuard.reason} chars=${userText.length}; no tool route will be admitted`,
    );
  }

  // Snapshot the whole TTS selection before any awaited work. A settings or
  // voice change received while this turn is planning/generating belongs to
  // the next assistant response and cannot split this one across speakers.
  const turnVoicePreference = getVoicePreference();
  const turnTtsSelection = Object.freeze({
    provider: getTTSProvider(),
    requestedVoiceId: session.currentVoiceId,
    switchGeneration: session.voiceSwitchGeneration,
    model: getConfiguredVoiceModel('tts', turnVoicePreference),
  });

  const pendingInterruptedTurn = session.pendingInterruptedTurn;
  const interruptedTurnAge = pendingInterruptedTurn
    ? Date.now() - pendingInterruptedTurn.interruptedAt
    : Number.POSITIVE_INFINITY;
  const interruptedActivityResponse = isVoiceCurrentActivityQuestion(userText)
    ? pendingInterruptedTurn
      && interruptedTurnAge >= 0
      && interruptedTurnAge <= 30_000
      ? CN_VOICE_FAST_PATH_MESSAGES.interruptedActivity(
          pendingInterruptedTurn.text.replace(/\s+/g, ' ').trim().slice(0, 60),
        )
      : CN_VOICE_FAST_PATH_MESSAGES.idleActivity
    : null;
  let interruptedMerge = mergeInterruptedVoiceTurn(pendingInterruptedTurn, userText);
  if (!interruptedMerge.usedInterruptedTurn && isVoiceCorrectionContinuation(userText)) {
    try {
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, session.domain, session.orgId);
      const priorAction = getMessagesByTokenBudget(conv.id)
        .slice(-16)
        .reverse()
        .find((record: any) => {
          if (record?.role !== 'user') return false;
          const priorText = String(record?.message || '').trim();
          return Boolean(priorText && buildForegroundWeChatSendArgs(priorText));
        });
      if (priorAction) {
        interruptedMerge = mergeInterruptedVoiceTurn({
          text: String((priorAction as any).message || ''),
          interruptedAt: new Date((priorAction as any).timestamp || 0).getTime(),
        }, userText, Date.now(), 120_000);
      }
    } catch {}
  }
  const actionIntentText = interruptedMerge.routingText || userText;
  if (interruptedMerge.usedInterruptedTurn) {
    logger.info(`[Audio] Applied correction to interrupted voice request: "${userText.slice(0, 80)}"`);
  }

  const conversationTurn = getOrCreateConversationForTurn(
    session.userId,
    session.agentId,
    session.domain,
    session.orgId,
    { userText: actionIntentText },
  );
  if (transcriptExecutionGuard.action === 'allow') {
    transcriptExecutionGuard = assessVoiceTranscriptForExecution(userText, {
      pendingAction: conversationTurn.conversation.actionContinuationState?.unfinished === true,
    });
  }
  try {
    await ensurePendingConfirmationPersistenceInitialized();
  } catch (error) {
    logger.error('[Audio] Encrypted confirmation store is unavailable:', error);
    socket.emit('agent:response', {
      text: voiceDurabilityUnknownText(),
      agentName: 'Lumi',
      source: 'voice',
      channel: 'voice',
      finalized: true,
      blocked: true,
      reason: 'persistence_unknown',
    });
    return;
  }
  turnAuthorization.assertCurrent();
  const userObservedCompletion = isUserObservedTaskCompletion(
    actionIntentText,
    conversationTurn.conversation.actionContinuationState,
  );
  const userObservedCompletionTask = userObservedCompletion
    ? conversationTurn.conversation.actionContinuationState
    : null;
  if (conversationTurn.rolledOver) {
    logger.info(
      `[Audio] Rolled over oversized conversation ${conversationTurn.previousConversationId} -> ${conversationTurn.conversation.id}`,
    );
  }

  const requestId = `voice_${randomUUID()}`;
  const executionReceipts = createVoiceExecutionReceiptCollector(requestId);
  const voiceTurnProvenance = issueVoiceTurnProvenance(
    session.voiceCaptureProvenance,
    {
      requestId,
      chunkSequence: inputTiming.captureChunkSequence,
      sttProvider: inputTiming.sttProvider,
    },
  );
  session.activeTurnProvenance = voiceTurnProvenance;
  const pipelineAbort = new AbortController();
  const modelTurnState = createModelTurnState();
  let actionLeaseHeartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | null = null;
  const isCurrentTurn = () => turnAuthorization.isCurrent() && session.pipelineAbortController === pipelineAbort && !pipelineAbort.signal.aborted;
  let finalAgentResponseDelivered = false;
  const voiceScope = {
    domain: session.domain,
    orgId: session.orgId,
    orgRole: String(socket.data?.authenticatedOrgRole || '') || undefined,
  };
  const executionScope: ChatExecutionScope = {
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    source: 'voice',
    conversationId: conversationTurn.conversation.id,
  };
  let trustedVoiceConfirmationText: string | undefined;
  const normalizeAgentPayload = (
    event: string,
    payload: Record<string, any> = {},
  ): Record<string, any> => {
    const sanitizedPayload: Record<string, any> = event === 'agent:response'
      ? sanitizeExecutionResponseForDelivery(payload, {
          task: actionIntentText,
          trustedConfirmationRequestText: trustedVoiceConfirmationText,
        })
      : event === 'agent:notification'
        ? sanitizeExecutionNotificationForDelivery(payload, { task: actionIntentText })
      : event === 'agent:error'
        ? sanitizeVoiceAgentErrorPayload()
        : payload;
    const publicPayload = projectCustomerVisibleExecutionEvent(event, sanitizedPayload, {
      taskText: actionIntentText,
    });
    return {
      ...publicPayload,
      source: publicPayload.source || 'voice',
      channel: publicPayload.channel || 'voice',
      requestId,
      conversationId: conversationTurn.conversation.id,
    };
  };
  const publishRecordedAgent = (event: string, payload: Record<string, any>) => {
    if (!turnAuthorization.isCurrent()) {
      if (!finalAgentResponseDelivered && (event === 'agent:error' || (event === 'agent:response' && payload.finalized))) {
        finalAgentResponseDelivered = true;
        socket.emit('agent:response', { text: CN_TASK_EXECUTION_MESSAGES.cancelled, source: 'voice', channel: 'voice', requestId, conversationId: conversationTurn.conversation.id, finalized: true, blocked: true, reason: 'cancelled' });
      }
      return;
    }
    socket.emit(event, payload);
    if (event === 'agent:response' && payload.finalized === true) {
      finalAgentResponseDelivered = true;
    }
  };
  const emitAgent = (event: string, payload: any = {}) => {
    if (!isCurrentTurn() || session.activeTurnRequestId !== requestId) return;
    const normalizedPayload = normalizeAgentPayload(event, payload);
    if (
      event === 'agent:error'
      || (event === 'agent:response' && normalizedPayload.finalized === true)
    ) {
      logger.error('[Audio] Rejected a terminal event outside the strict voice durability boundary');
      return false;
    }
    if (!recordChatExecutionEvent(executionScope, requestId, event, normalizedPayload)) return false;
    publishRecordedAgent(event, normalizedPayload);
    return true;
  };
  const executionUnknownPayload = normalizeAgentPayload('agent:response', {
    text: voiceDurabilityUnknownText(),
    agentName: 'Lumi',
    finalized: true,
    blocked: true,
    reason: 'persistence_unknown',
  });
  const toolSecurityContext = buildSocketToolSecurityContext(socket, voiceScope);
  const confirmationChannelScope = buildTransportNeutralConfirmationScope({
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    conversationId: conversationTurn.conversation.id,
  });
  let confirmationScope = buildTransportNeutralConfirmationScope({
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    conversationId: conversationTurn.conversation.id,
    taskId: conversationTurn.conversation.actionContinuationState?.taskId,
  });
  const voiceStateKey = getVoiceStateKey(session);
  let pendingConfirmation: Awaited<ReturnType<typeof getPendingConfirmationDurably>> = null;
  let pendingConfirmationPrompt = '';
  let recentVoiceHistory: any[] = [];
  let actionContinuationBridge = '';
  try {
    const conversation = conversationTurn.conversation;
    recentVoiceHistory = getMessages(conversation.id, 30);
    actionContinuationBridge = buildRecentActionContinuationBridge(
      actionIntentText,
      recentVoiceHistory,
      conversation.actionContinuationState,
      requestId,
    );
  } catch {}
  const pendingAssistantOfferContext = buildPendingAssistantOfferContextFromTranscript({
    messages: recentVoiceHistory,
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    conversationId: conversationTurn.conversation.id,
    taskId: conversationTurn.conversation.actionContinuationState?.taskId,
  });
  let voiceUserMessagePersisted = false;
  let voiceUserMessageId = '';
  const persistVoiceUserMessage = (cognitiveIntent = 'voice_received') => {
    if (voiceUserMessagePersisted) return voiceUserMessageId;
    voiceUserMessageId = addMessageIdempotent({
      userId: session.userId,
      agentId: session.agentId,
      conversationId: conversationTurn.conversation.id,
      role: 'user',
      content: userText,
      personality: session.personalityId,
      mode: 'voice',
      source: 'voice',
      channel: 'voice',
      cognitiveIntent,
      llmWasCalled: false,
      receivedAt: userReceivedAt,
      timestamp: userReceivedAt,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      requestId,
      ...(voiceTurnProvenance || {}),
      deferActionPreparation: true,
    });
    voiceUserMessagePersisted = true;
    return voiceUserMessageId;
  };
  // Once a verified final transcript is admitted to the execution lane it is
  // durable. Routing, model, tool, TTS, cancellation, or disconnect failures
  // may affect its result, but can no longer erase the user's instruction.
  const acceptedVoiceResolution = resolveUserTurn({requestId,userText,state:conversationTurn.conversation.actionContinuationState,options:{pendingAssistantOfferContext}});
  const voiceAdmission = await admitAcceptedUserTurnDurably({
    persistAcceptedUserTurn: () => persistVoiceUserMessage(),
    flush: flushDBOrThrow,
    onPersistenceUnknown: async error => {
      logger.error('[Audio] Accepted voice turn could not be flushed:', error);
      const unknownPayload = normalizeAgentPayload('agent:response', {
        text: voiceDurabilityUnknownText(),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      try {
        await recordChatExecutionPersistenceUnknownDurably(executionScope, requestId, unknownPayload);
      } catch {}
      publishRecordedAgent('agent:response', unknownPayload);
    },
  });
  if (!voiceAdmission) {
    return;
  }
  voiceUserMessageId = voiceAdmission.persisted;
  resources.admission = reserveConversationExecution({userId:session.userId,domain:voiceScope.domain,orgId:voiceScope.orgId,conversationId:conversationTurn.conversation.id,source:'voice'},requestId,pipelineAbort.signal);
  await resources.admission.waitForTurn();
  turnAuthorization.assertCurrent();
  conversationTurn.conversation = getConversationForScope(conversationTurn.conversation.id,session.userId,voiceScope.domain,voiceScope.orgId) || conversationTurn.conversation;
  if (conversationTurn.rolledOver && conversationTurn.previousConversationId) {
    await runAfterAcceptedUserTurnAdmission(voiceAdmission, () => (
      clearPendingConfirmationDurably(session.userId, buildTransportNeutralConfirmationScope({
        domain: session.domain,
        orgId: session.orgId,
        conversationId: conversationTurn.previousConversationId!,
      }))
    ));
  }
  const confirmationResolution = await resolveAcceptedTurnConfirmation({
    admission: voiceAdmission,
    userId: session.userId,
    userText,
    taskRelation:acceptedVoiceResolution.taskRelation,
    actionState: conversationTurn.conversation.actionContinuationState,
    taskScope: confirmationScope,
    channelScope: confirmationChannelScope,
  });
  pendingConfirmation = confirmationResolution.pending;
  pendingConfirmationPrompt = confirmationResolution.prompt;
  confirmationScope = confirmationResolution.scope;
  const correctionRequiresFreshConfirmation = confirmationResolution.correctionRequiresFreshConfirmation;

  try {
    const superseded = await runAfterAcceptedUserTurnAdmission(
      voiceAdmission,
      () => beginChatExecutionDurably(
        executionScope,
        requestId,
        executionUnknownPayload,
      ),
    );
    if (superseded?.terminalEvent) {
      publishRecordedAgent(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
  } catch (error) {
    logger.error('[Audio] Voice execution reservation could not be durably established:', error);
    publishRecordedAgent('agent:response', executionUnknownPayload);
    if (session.isActive) socket.emit('audio:status', { status: 'listening', requestId });
    return;
  }

  session.pendingInterruptedTurn = null;
  session.isSpeaking = false;
  session.isProcessing = true;
  session.isBackgroundWork = transcriptExecutionGuard.action !== 'clarify'
    && !isCapabilityMetaQuestion(actionIntentText)
    && hasExplicitToolIntent(actionIntentText);
  session.activeWorkStatus = session.isBackgroundWork ? 'planning' : 'idle';
  session.activeWorkStep = '';
  session.activeWorkToolCalls = 0;
  startVoiceLatencyTrace({
    requestId,
    provider: inputTiming.sttProvider,
    domain: session.domain,
    speechEndedAt: inputTiming.speechEndedAt,
    asrFinalAt: inputTiming.asrFinalAt,
    pipelineStartedAt: Date.now(),
  });
  session.pipelineAbortController = pipelineAbort;
  session.activeTurnText = userText;
  session.voiceTurnGeneration += 1;
  session.activeTurnRequestId = requestId;
  session.activeExecutionReceipts = executionReceipts;
  session.activeRoutingText = actionIntentText;
  turnAuthorization.assertCurrent();
  emitAgent("agent:status", { status: "thinking", agentName: "Lumi" });
  socket.emit("audio:status", { status: "thinking", requestId });
  if (session.isBackgroundWork) {
    emitVoiceWorkProgress(socket, session, requestId, 'planning', CN_VOICE_WORK_MESSAGES.workAccepted);
    startVoiceWorkHeartbeat(socket, session, requestId);
  }
  const routedUserText = [actionIntentText, actionContinuationBridge, pendingConfirmationPrompt].filter(Boolean).join('\n\n');
  session.activeRoutingText = actionIntentText;
  const requestedModeHint = detectRequestedOperationMode(userText);
  const skipKnowledgeRetrieval = transcriptExecutionGuard.action === 'clarify'
    || Boolean(requestedModeHint)
    || isCapabilityMetaQuestion(userText)
    || hasClientActionOnlyIntent(userText)
    || isUserCorrectionOrExplanationQuestion(userText);
  const allowLocalFileWrites = shouldAllowVoiceLocalFileWriteForTurn(routedUserText);
  const localWriteIntentReason = allowLocalFileWrites
    ? `Current voice request explicitly asked Lumi to generate/export a local deliverable: "${userText.slice(0, 120)}"`
    : undefined;

  // Cross-session context is read-only and prefetched in parallel. A slow
  // knowledge source must not hold the spoken turn open indefinitely.
  let voiceMemories: any[] = [];
  const voiceRagKnowledge: string[] = [];
  let voiceOrganizationKnowledge = '';
  if (!skipKnowledgeRetrieval) {
    const ragAgentIds = Array.from(new Set([session.agentId, 'lumi'].filter(Boolean)));
    // Memory and knowledge are mutable user data. Read the authoritative
    // stores each turn; a second TTL cache can replay data the user deleted.
    const prefetch = await collectAnticipatoryContext([
      {
        key: 'memory',
        operation: 'read',
        sideEffectClass: 'none',
        run: () => queryMemories({
          userId: session.userId,
          query: routedUserText,
          limit: 5,
          minConfidence: 0.4,
          domain: voiceScope.domain,
          orgId: voiceScope.orgId,
          evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
        }),
      },
      ...ragAgentIds.map(ragAgentId => ({
        key: `rag:${ragAgentId}`,
        operation: 'read' as const,
        sideEffectClass: 'none' as const,
        run: (signal?: AbortSignal) => retrieveChunks(session.userId, ragAgentId, routedUserText, 3, {
          domain: voiceScope.domain,
          orgId: voiceScope.domain === 'work' ? voiceScope.orgId : '',
          signal,
        }),
      })),
      ...(voiceScope.domain === 'work' && voiceScope.orgId ? [{
        key: 'organization',
        operation: 'read' as const,
        sideEffectClass: 'none' as const,
        run: (signal?: AbortSignal) => searchKnowledgeBase(voiceScope.orgId, routedUserText, { limit: 3, userId: session.userId, signal }),
      }] : []),
    ], { deadlineMs: 1_300, signal: pipelineAbort.signal });

    voiceMemories = Array.isArray(prefetch.values.memory) ? prefetch.values.memory : [];
    for (const ragAgentId of ragAgentIds) {
      const chunks = prefetch.values[`rag:${ragAgentId}`];
      if (!Array.isArray(chunks)) continue;
      for (const chunk of chunks) {
        const content = String((chunk as any)?.content || '').trim();
        if (content && !voiceRagKnowledge.includes(content)) voiceRagKnowledge.push(content);
        if (voiceRagKnowledge.length >= 5) break;
      }
      if (voiceRagKnowledge.length >= 5) break;
    }
    const organizationResults = prefetch.values.organization;
    if (Array.isArray(organizationResults)) {
      voiceOrganizationKnowledge = organizationResults
        .map((result: any) => `[${result.title}] ${result.chunk}`)
        .join('\n');
    }
    if (prefetch.failed.length > 0 || prefetch.timedOut.length > 0) {
      logger.warn(`[Audio] Read-only context prefetch partial: failed=${prefetch.failed.map(item => item.key).join(',') || 'none'} timedOut=${prefetch.timedOut.join(',') || 'none'} elapsedMs=${prefetch.elapsedMs}`);
    }
  } else {
    logger.info('[Audio] Skipped memory/RAG retrieval for deterministic or corrective voice turn');
  }

  turnAuthorization.assertCurrent();
  const sensoryAudio = sensoryFn(session.userId);
  const personalityConfig = personalityRegistry.getForUser(
    session.personalityId || 'lumi',
    session.userId,
    voiceScope.orgId,
  ) || personalityRegistry.getDefault();

  // ── Unified personality prompt + voice-specific overlay ──
  // Same core prompt as text chat — one Lumi, one framework.
  const baseVoiceOverlay = [
    '\n## Voice Mode',
    '- You are SPEAKING, not typing. Be conversational and natural, like talking to a friend.',
    '- Keep spoken responses concise; the user is listening, not reading.',
  ].join('\n');

  // Inject older summary/topic continuity only for a genuinely referential
  // utterance. Feeding a long task summary into every ordinary voice question
  // made completed app commands compete with the current sentence.
  let topicContext = '';
  const wantsHistoricalVoiceContext = Boolean(
    actionContinuationBridge
    || isVoiceReferentialFollowup(userText)
    // i18n-allow: history-recall recognition; not user-visible copy.
    || /(?:刚才|刚刚|之前|上次|以前|我们聊过|还记得)|\b(?:earlier|before|previously|last time|we discussed|remember)\b/iu.test(userText),
  );
  try {
    const convForTopic = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    if (wantsHistoricalVoiceContext) {
      const summary = getConversationSummary(convForTopic.id);
      if (summary) topicContext += `\n\n## Conversation Context\n${summary}`;
      const tc = getTopicContext(convForTopic.id);
      if (tc) topicContext += tc;
    }
  } catch {}

  const operationMode = (() => {
    try {
      return getStoredOperationMode(session.userId);
    } catch {}
    return 'assistant';
  })();
  const requestedMode = requestedModeHint;
  const executionPipeline = buildLumiExecutionPipeline({
    requestId, userText, acceptedResolution:acceptedVoiceResolution,
    dispatch: {
      userId: session.userId,
      text: actionIntentText,
      continuationContext: [actionContinuationBridge, pendingConfirmationPrompt]
        .filter(Boolean)
        .join('\n\n'),
      channel: 'voice',
      source: 'voice',
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      surface: 'voice',
      operationMode,
      requestedMode,
      targetIsLumi: true,
    },
    registry: toolRegistry,
    personalityToolPolicy: personalityConfig.toolPolicy,
    executionBoundary: toolSecurityContext.executionBoundary,
    actionTaskState: conversationTurn.conversation.actionContinuationState,
    persistedConversationHistory: getMessages(conversationTurn.conversation.id, TASK_TARGET_HISTORY_LIMIT)
      .filter(record => record.requestId !== requestId),
    pendingAssistantOfferContext,
    traceText: actionIntentText,
    source: 'voice',
  });
  const turnDispatch = executionPipeline.turnIntent;
  const turnFlow = turnDispatch.flow;
  const effectiveOperationMode = turnFlow.effectiveOperationMode;
  const selfRepairTurn = turnFlow.selfRepairTurn;
  const clientActionOnlyTurn = turnFlow.clientActionOnlyTurn;
  const workSurfaceRoute = turnFlow.workSurfaceRoute;
  const visionIntent = turnFlow.visionIntent;
  const executionDecision = executionPipeline.execution;
  const requestedToolSession = transcriptExecutionGuard.action === 'clarify'
    ? false
    : executionPipeline.executionRequested;
  const voiceInputTokenBudget = resolveVoiceModelInputBudget({
    text: actionIntentText,
    allowToolUse: requestedToolSession,
  });
  const { systemPrompt: fullPersonalityPrompt } = personalityRegistry.buildSystemPrompt(
    session.personalityId || 'lumi',
    {
      mode: requestedToolSession ? 'task' : 'chat',
      sensory: sensoryAudio,
      uiContext: 'voice',
    },
    {
      userId: session.userId,
      memories: voiceMemories.length > 0 ? voiceMemories : undefined,
      ragKnowledge: voiceRagKnowledge.length > 0 ? voiceRagKnowledge : undefined,
      userText: routedUserText,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
    },
  );
  session.isBackgroundWork = requestedToolSession;
  session.activeWorkStatus = requestedToolSession ? 'planning' : 'idle';
  if (requestedToolSession && !session.workHeartbeatTimer) {
    emitVoiceWorkProgress(socket, session, requestId, 'planning', CN_VOICE_WORK_MESSAGES.workAccepted);
    startVoiceWorkHeartbeat(socket, session, requestId);
  } else if (!requestedToolSession) {
    stopVoiceWorkHeartbeat(session);
  }
  const intentTrace = executionPipeline.intentTrace;
  const capabilitySelection = executionPipeline.capabilityPlan;
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'voice',
    text: turnFlow.routeText,
    flow: turnFlow,
    capabilitySelection,
    capabilityExecutionPlan: executionPipeline.executionPlan,
  });
  const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);
  const routedToolPolicy = executionPipeline.authorizationPolicy;
  const modelToolProjection = executionPipeline.modelToolProjection;
  const visibleToolRoute = executionDecision.toolRoute;
  const toolSessionActive = requestedToolSession;
  const actionFollowupIntent = executionPipeline.actionFollowupIntent;
  const actionTaskExecution = turnFlow.conceptualCapabilityQuestion
    || transcriptExecutionGuard.action === 'clarify'
    ? { state: null, kind: 'conversation' as const }
    : userObservedCompletion
    ? {
        state: null,
        kind: 'conversation' as const,
      }
    : prepareConversationActionExecution({
        conversationId: conversationTurn.conversation.id,
        userId: session.userId,
        userText: actionIntentText,
        requestId,
        userMessageId: voiceUserMessageId,
        toolPolicy: routedToolPolicy,
        followupIntent: actionFollowupIntent,
        forceTask: toolSessionActive,
        forceResume: Boolean(
          pendingConfirmation
          || interruptedMerge.usedInterruptedTurn
          || executionPipeline.trustedActionContinuation
        ),
      });
  if ('bindingFailure' in actionTaskExecution) {
    const staleText = actionTaskExecution.bindingFailure === 'busy'
      ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
      : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
    stopVoiceWorkHeartbeat(session);
    session.isBackgroundWork = false;
    session.activeWorkStatus = 'idle';
    session.activeWorkStep = '';
    const bindingTerminalPayload = normalizeAgentPayload('agent:response', {
      text: staleText,
      agentName: 'Lumi',
      source: 'voice_turn_binding',
      finalized: true,
      blocked: true,
      reason: actionTaskExecution.diagnosticCode,
    });
    const bindingCommitted = await commitChatTerminalBoundary({
      persistTerminalState: () => undefined,
      persistAssistantMessage: () => addMessageIdempotent({
        userId: session.userId,
        agentId: session.agentId,
        conversationId: conversationTurn.conversation.id,
        role: 'assistant',
        content: staleText,
        personality: session.personalityId,
        mode: 'voice',
        source: 'voice_turn_binding',
        channel: 'voice',
        cognitiveIntent: actionTaskExecution.diagnosticCode,
        llmWasCalled: false,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
        requestId,
        ...(voiceTurnProvenance || {}),
        taskIntent: 'conversation',
        skipActionContinuation: true,
      }),
      flush: flushDBOrThrow,
      persistTerminalReceipt: () => recordChatExecutionTerminalEventDurably(
        executionScope,
        requestId,
        'agent:response',
        bindingTerminalPayload,
        executionUnknownPayload,
      ),
      persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
        executionScope,
        requestId,
        executionUnknownPayload,
      ),
      publishCommitted: () => {
        publishRecordedAgent('agent:response', bindingTerminalPayload);
        socket.emit('chat:conversation_updated', {
          conversationId: conversationTurn.conversation.id,
          agentId: session.agentId,
          source: 'voice_turn_binding',
          requestId,
        });
      },
      publishUnknown: () => publishRecordedAgent('agent:response', executionUnknownPayload),
      persistenceUnknownProjection: {
        text: executionUnknownPayload.text,
        completionFeedback: executionUnknownPayload.completionFeedback,
        reason: 'Terminal persistence outcome is unknown.',
      },
      onPersistenceError: error => {
        logger.error('[Audio] Voice binding terminal persistence failed:', error);
      },
    });
    let bindingSpeechCounted = false;
    try {
      const ttsProvider = getTTSProvider();
      if (bindingCommitted && ttsProvider && session.currentVoiceId && session.isActive) {
        const ttsRoute = await resolveSingleVoiceTtsRoute(session, ttsProvider, session.currentVoiceId);
        if (!ttsRoute) throw new Error(`Provider ${ttsProvider} has no compatible voice`);
        session.isSpeaking = true;
        voiceTransportState.ttsSpeakingCount++;
        bindingSpeechCounted = true;
        const ttsResult = await synthesizeSpeech(staleText, {
          provider: ttsRoute.provider,
          voiceId: ttsRoute.voiceId,
          model: ttsRoute.model,
          speechRate: ttsRoute.speechRate,
          pitch: ttsRoute.pitch,
          volume: ttsRoute.volume,
          signal: pipelineAbort.signal,
          allowFallback: false,
        });
        if (isCurrentTurn()) {
          socket.emit('audio:status', { status: 'speaking', requestId });
          addEchoText(staleText, voiceEchoScope(session));
          socket.emit('audio:response', {
            buffer: ttsResult.audioBuffer,
            format: ttsResult.format,
            volumeGain: computeVolumeGain(),
            lane: 'conversation',
            requestId,
          });
        }
      }
    } catch (bindingSpeechError: any) {
      if (!isTtsCancellationError(bindingSpeechError, pipelineAbort.signal)) {
        logger.warn(`[Audio] Failed to speak stale/busy turn response: ${bindingSpeechError?.message || String(bindingSpeechError)}`);
        emitVoiceTtsFailure(socket, requestId, 'conversation');
      }
    } finally {
      if (bindingSpeechCounted) {
        const decay = () => { voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1); };
        const timer = setTimeout(decay, 3000);
        session.ttsDecayTimers.push(timer);
      }
      if (session.pipelineAbortController === pipelineAbort) {
        session.isSpeaking = false;
        session.isProcessing = false;
        session.activeWorkToolCalls = 0;
        session.activeTurnText = '';
        session.activeRoutingText = '';
        if (session.isActive) {
          resetSilenceTimer(session, socket);
          socket.emit('audio:status', { status: 'listening', requestId });
          emitAgent('agent:status', { status: 'idle' });
        }
        session.pipelineAbortController = null;
        session.activeTurnRequestId = null;
        session.suppressedSpeechRequestIds.delete(requestId);
      }
    }
    return;
  }
  // Every accepted voice turn owns a durable request identity, including
  // conceptual/taskless turns. Without it, an exception in one of those paths
  // could release the voice/desktop lane without a terminal audit record.
  const foregroundRequestIdentity: VoiceForegroundRequestIdentity = Object.freeze({
    conversationId: conversationTurn.conversation.id,
    userId: session.userId,
    requestId,
    ...(actionTaskExecution.state?.taskId
      ? { expectedTaskId: actionTaskExecution.state.taskId }
      : {}),
  });
  session.activeForegroundRequestIdentity = foregroundRequestIdentity;
  executionReceipts.bindTask(foregroundRequestIdentity.expectedTaskId);
  actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({
    conversationId: conversationTurn.conversation.id,
    userId: session.userId,
    requestId,
    abortController: pipelineAbort,
    onPersistenceUnknown: async () => {
      const recorded = await recordChatExecutionPersistenceUnknownDurably(
        executionScope,
        requestId,
        executionUnknownPayload,
      );
      if (recorded) publishRecordedAgent('agent:response', executionUnknownPayload);
    },
  });
  if (actionTaskExecution.state?.taskId) {
    executionPipeline.executionPlan = bindCapabilityExecutionPlanTask(
      executionPipeline.executionPlan,
      actionTaskExecution.state.taskId,
    );
    persistConversationExecutionPlan({
      conversationId: conversationTurn.conversation.id,
      userId: session.userId,
      plan: executionPipeline.executionPlan,
    });
  }
  if (actionTaskExecution.kind === 'new') {
    // A concrete replacement task invalidates an older confirmation boundary
    // on this exact voice channel.
    await clearPendingConfirmationDurably(session.userId, confirmationScope);
  }
  if (
    actionTaskExecution.state?.taskId
    && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
  ) {
    session.activeTaskConversationId = conversationTurn.conversation.id;
    session.activeTaskRequestId = requestId;
    session.activeTaskId = actionTaskExecution.state.taskId;
    try {
      updateConversationActionFocus({
        taskId: actionTaskExecution.state.taskId,
        userId: session.userId,
        domain: session.domain,
        orgId: session.orgId,
        commitment: actionTaskExecution.state.goal,
        nextAction: actionIntentText,
        resumePoint: actionTaskExecution.kind === 'resume'
          ? actionTaskExecution.state.assistantState || actionTaskExecution.state.latestBlocker || ''
          : '',
      });
    } catch {}
  }
  const priorTaskRecords = actionTaskExecution.kind === 'resume'
    ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
    : [];
  const taskAwareRecords = (records: ToolExecutionRecord[]) => (
    coalesceToolExecutionRecords([...priorTaskRecords, ...records])
  );
  if (
    toolSessionActive
    && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(
      conversationTurn.conversation.id,
      session.userId,
      'executing',
      { requestId },
    );
  }
  const remoteRestricted = toolSecurityContext.executionBoundary === 'remote_restricted';
  logger.info(`[Audio] tool gate: ${executionDecision.allowToolUse ? 'authorized' : 'off'} session=${toolSessionActive ? 'active' : 'conversation'} mode=${operationMode} effective=${effectiveOperationMode} surface=${turnFlow.surface} clientActionOnly=${clientActionOnlyTurn} selfRepair=${selfRepairTurn} capabilityLane=${capabilitySelection.lane} trace=${intentTrace.summary} route=${visibleToolRoute ? `${visibleToolRoute.toolNames.length}/${visibleToolRoute.totalAvailable}` : 'none'}`);
  emitAgent('agent:intent_trace', intentTrace);
  if (visibleToolRoute) {
    emitAgent('agent:tool_route', {
      categories: visibleToolRoute.categories,
      reasons: visibleToolRoute.reasons,
      toolNames: visibleToolRoute.toolNames,
      totalAvailable: visibleToolRoute.totalAvailable,
      truncated: visibleToolRoute.truncated,
      source: 'voice',
      trace: intentTrace,
    });
  }
  const visiblePreferredTools = restrictVisibleToolNamesForExecutionBoundary(
    capabilitySelection.preferredTools,
    toolSecurityContext.executionBoundary,
  );
  emitAgent('agent:capability_selection', {
    lane: remoteRestricted
      ? (visiblePreferredTools.length > 0 ? 'web_or_account' : 'conversation')
      : capabilitySelection.lane,
    primary: remoteRestricted
      ? (visiblePreferredTools[0] || 'conversation')
      : capabilitySelection.primary,
    reasons: remoteRestricted
      ? ['remote execution boundary applied']
      : capabilitySelection.reasons,
    preferredTools: visiblePreferredTools,
    source: 'voice',
  });
  if (desktopExecutionPolicy.applies && toolSecurityContext.executionBoundary !== 'remote_restricted') {
    emitAgent('agent:desktop_execution_policy', {
      reason: desktopExecutionPolicy.reason,
      evidenceTools: desktopExecutionPolicy.evidenceTools,
      actuationTools: desktopExecutionPolicy.actuationTools,
      verificationTools: desktopExecutionPolicy.verificationTools,
      source: 'voice',
    });
  }
  const needsExecutionPrompt = toolSessionActive && !remoteRestricted;
  const opModeOverlay = remoteRestricted ? '' : '\n\n' + buildInteractionModeOverlay(turnFlow);
  const workSurfaceOverlay = workSurfaceRoute.promptOverlay && needsExecutionPrompt ? '\n\n' + workSurfaceRoute.promptOverlay : '';
  const visionRoutingOverlay = visionIntent && effectiveOperationMode !== 'meeting' && needsExecutionPrompt ? '\n\n' + buildVisionRoutingOverlay(session.userId, routedUserText) : '';
  const interactionOverlay = remoteRestricted
    ? baseVoiceOverlay
    : toolSessionActive
      ? baseVoiceOverlay + '\n\n## Interaction Mode\nThis turn has an authorized execution plan. Use only the declarations provided for this request, keep spoken progress brief, and do not claim completion without a verified receipt.'
      : baseVoiceOverlay + '\n\n## Interaction Mode\nThis turn is conversational. Do not call tools, operate the desktop, or claim that you are taking actions. Answer naturally unless the user gives an explicit command.';

  const clientSelfPrompt = !remoteRestricted && (needsExecutionPrompt || isCapabilityMetaQuestion(actionIntentText))
    ? '\n\n' + formatCompactClientSelfPrompt(session.userId, voiceScope)
    : '';
  const dispatchOverlay = needsExecutionPrompt ? '\n\n' + turnDispatch.promptOverlay : '';
  const executionOverlay = needsExecutionPrompt || remoteRestricted
    ? '\n\n' + executionBoundaryPromptOverlay(
        executionDecision.promptOverlay,
        toolSecurityContext.executionBoundary,
      )
    : '';
  const capabilitySelectionOverlay = needsExecutionPrompt ? '\n\n' + capabilitySelection.promptOverlay : '';
  const desktopExecutionOverlay = desktopExecutionPolicy.promptOverlay && needsExecutionPrompt ? '\n\n' + desktopExecutionPolicy.promptOverlay : '';
  const turnFlowOverlay = remoteRestricted ? '' : '\n\n' + turnFlow.promptOverlay;
  const runtimeCapabilityOverlay = needsExecutionPrompt
    ? '\n\n' + buildLumiRuntimeCapabilityContext({
        userId: session.userId,
        text: turnFlow.routeText,
        flow: turnFlow,
        toolRegistry,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
      })
    : '';
  const operatingKernelOverlay = needsExecutionPrompt
    ? '\n\n' + buildLumiOperatingKernelPrompt({
        channel: 'voice',
        flow: turnFlow,
      })
    : '';
  const actionContinuationOverlay = actionContinuationBridge ? `\n\n${actionContinuationBridge}` : '';
  const pendingConfirmationOverlay = pendingConfirmationPrompt ? `\n\n${pendingConfirmationPrompt}` : '';
  const organizationKnowledgeOverlay = voiceOrganizationKnowledge
    ? `\n\n## Company Knowledge Base\n${voiceOrganizationKnowledge}\n\nUse this authorized organization knowledge when relevant and cite article titles when referencing it.`
    : '';
  const voiceSystemPrompt = restrictSystemPromptForExecutionBoundary(
    fullPersonalityPrompt,
    toolSecurityContext.executionBoundary,
  ) + interactionOverlay + opModeOverlay + workSurfaceOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + actionContinuationOverlay + pendingConfirmationOverlay + clientSelfPrompt + topicContext + organizationKnowledgeOverlay + dispatchOverlay + turnFlowOverlay + executionOverlay + capabilitySelectionOverlay + desktopExecutionOverlay + runtimeCapabilityOverlay + operatingKernelOverlay;

  const userLLMPrefs = getScopedPreferredLLM(session.userId, voiceScope);
  const provider = userLLMPrefs.provider || 'deepseek';
  const voiceModel = userLLMPrefs.model;
  const reasoningRoutePolicy = {
    selectionMode: userLLMPrefs.selectionMode,
    fallbackCandidates: userLLMPrefs.fallbackCandidates,
    allowCloudFallback: userLLMPrefs.allowCloudFallback,
    conversationId: conversationTurn.conversation.id,
    requestId,
    ...(voiceTurnProvenance || {}),
    interactionId: requestId,
    source: 'voice',
  };
  const scheduleVoiceSummary = (conversationId: string) => {
    if (!turnAuthorization.isCurrent()) return;
    scheduleConversationSummary({
      isAuthorized: turnAuthorization.isCurrent,
      userId: session.userId,
      provider,
      model: voiceModel,
      ...reasoningRoutePolicy,
      conversationId,
      source: 'voice_summary',
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      llmGetters,
      log: {
        info: message => logger.info(message),
        warn: (message, error) => logger.warn(message, error),
      },
    });
  };
  let voiceAssistantMessagePersisted = false;
  let voiceAssistantMessageId = '';
  const persistVoiceAssistantMessage = (
    conversationId: string,
    text: string,
    options: {
      toolCalls?: ToolExecutionRecord[];
      cognitiveIntent?: string;
      llmWasCalled?: boolean;
      source?: string;
      terminalTaskDisposition?: {
        outcome: 'blocked';
        taskId: string;
        requestId: string;
        reason: string;
      };
    } = {},
  ): string => {
    if (voiceAssistantMessagePersisted || !String(text || '').trim()) {
      return voiceAssistantMessageId;
    }
    voiceAssistantMessageId = addMessageIdempotent({
      userId: session.userId,
      agentId: session.agentId,
      conversationId,
      role: 'assistant',
      content: text,
      personality: session.personalityId,
      mode: 'voice',
      source: options.source || 'voice',
      channel: 'voice',
      toolCalls: options.toolCalls?.length ? options.toolCalls : undefined,
      cognitiveIntent: options.cognitiveIntent || 'voice_response',
      llmWasCalled: options.llmWasCalled === true,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      requestId,
      ...(voiceTurnProvenance || {}),
      taskIntent: toolSessionActive ? 'task' : 'conversation',
      terminalTaskDisposition: options.terminalTaskDisposition,
    });
    voiceAssistantMessagePersisted = true;
    return voiceAssistantMessageId;
  };
  const persistSidecarConversation = (conversationId: string) => {
    const history = session.sidecarHistory.splice(0);
    for (const [index, item] of history.entries()) {
      if (!item.persist) continue;
      const sidecarRequestId = `${requestId}:sidecar:${index}`;
      addMessageIdempotent({
        userId: session.userId,
        agentId: session.agentId,
        conversationId,
        role: 'user',
        content: item.userText,
        personality: session.personalityId,
        mode: 'voice',
        source: 'voice_sidecar',
        channel: 'voice',
        cognitiveIntent: item.cognitiveIntent,
        llmWasCalled: false,
        receivedAt: item.userReceivedAt,
        timestamp: item.userReceivedAt,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
        requestId: sidecarRequestId,
        skipActionContinuation: true,
      });
      addMessageIdempotent({
        userId: session.userId,
        agentId: session.agentId,
        conversationId,
        role: 'assistant',
        content: item.responseText,
        personality: session.personalityId,
        mode: 'voice',
        source: 'voice_sidecar',
        channel: 'voice',
        cognitiveIntent: item.cognitiveIntent,
        llmWasCalled: item.llmWasCalled,
        receivedAt: item.responseAt,
        timestamp: item.responseAt,
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
        requestId: sidecarRequestId,
        skipActionContinuation: true,
      });
    }
  };

  const commitVoiceTerminal = async <T = unknown>(input: {
    text: string;
    source: string;
    blocked: boolean;
    reason?: string;
    cognitiveIntent: string;
    llmWasCalled: boolean;
    toolCalls?: ToolExecutionRecord[];
    speechText?: string;
    notification?: Record<string, any>;
    persistTerminalState?: () => T;
    publishAfter?: (terminalState: T | undefined) => void;
  }): Promise<boolean> => {
    // An interrupted/superseded turn no longer owns persistence, publication,
    // or speech. Its cancellation terminal is committed by the transport
    // handler against the captured request identity instead.
    if (!isCurrentTurn()) return false;
    if (actionLeaseHeartbeat?.isLeaseLost()) {
      await actionLeaseHeartbeat.leaseLoss;
      return false;
    }
    const terminalPayload = normalizeAgentPayload('agent:response', {
      text: input.text,
      agentName: 'Lumi',
      source: input.source,
      finalized: true,
      blocked: input.blocked,
      reason: input.reason || '',
    });
    const committed = await commitChatTerminalBoundary<T | undefined>({
      persistTerminalState: () => {
        if (!isCurrentTurn()) throw Object.assign(new Error('Voice turn superseded'), { name: 'AbortError' });
        persistVoiceUserMessage(input.cognitiveIntent);
        persistSidecarConversation(conversationTurn.conversation.id);
        return input.persistTerminalState?.();
      },
      persistAssistantMessage: () => {
        if (!isCurrentTurn()) throw Object.assign(new Error('Voice turn superseded'), { name: 'AbortError' });
        // Keep the request lease alive until the assistant row has consumed
        // the terminal tool receipts. Settling it first clears the pending
        // turn and makes the durable transcript lose the very evidence needed
        // to complete the task.
        const assistantMessageId = persistVoiceAssistantMessage(
          conversationTurn.conversation.id,
          input.text,
          {
            toolCalls: input.toolCalls,
            cognitiveIntent: input.cognitiveIntent,
            llmWasCalled: input.llmWasCalled,
            source: input.source,
            terminalTaskDisposition: input.blocked && foregroundRequestIdentity?.expectedTaskId
              ? {
                  outcome: 'blocked',
                  taskId: foregroundRequestIdentity.expectedTaskId,
                  requestId,
                  reason: input.reason || 'Voice terminal response reported a blocked execution.',
                }
              : undefined,
          },
        );
        return assistantMessageId;
      },
      flush: flushDBOrThrow,
      persistTerminalReceipt: () => persistAuthorizedTerminalReceipt({ scope: executionScope, requestId,
        event: 'agent:response', payload: terminalPayload, unknownPayload: executionUnknownPayload,
        authorization: turnAuthorization, channel: 'voice', flush: flushDBOrThrow }),
      persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
        executionScope,
        requestId,
        executionUnknownPayload,
      ),
      publishCommitted: terminalState => {
        if (!turnAuthorization.isCurrent()) { publishRecordedAgent('agent:response', terminalPayload); return; }
        if (!isCurrentTurn()) return;
        if (input.notification) {
          publishRecordedAgent(
            'agent:notification',
            normalizeAgentPayload('agent:notification', input.notification),
          );
        }
        const executionWriteback = terminalState as any;
        if (executionWriteback?.recorded) {
          publishRecordedAgent(
            'agent:task_execution_writeback',
            normalizeAgentPayload('agent:task_execution_writeback', executionWriteback),
          );
        }
        publishRecordedAgent('agent:response', terminalPayload);
        socket.emit('chat:conversation_updated', {
          conversationId: conversationTurn.conversation.id,
          agentId: session.agentId,
          source: input.source,
          requestId,
        });
        scheduleVoiceSummary(conversationTurn.conversation.id);
        if (String(input.speechText || '').trim()) queueFinalizedSpeech(input.speechText!);
        input.publishAfter?.(terminalState);
      },
      publishUnknown: () => {
        publishRecordedAgent('agent:response', executionUnknownPayload);
      },
      persistenceUnknownProjection: {
        text: executionUnknownPayload.text,
        completionFeedback: executionUnknownPayload.completionFeedback,
        reason: 'Terminal persistence outcome is unknown.',
      },
      onPersistenceError: error => {
        logger.error(`[Audio] ${input.source} terminal persistence failed:`, error);
      },
    });
    if (committed && !terminalPayload.blocked && turnAuthorization.isCurrent()) scheduleTurnMemory({
      userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, userText,
      channel: 'voice', source: 'voice', requestId, conversationId: conversationTurn.conversation.id,
      agentId: session.agentId, authorization: turnAuthorization, llmGetters,
    });
    return committed;
  };

  const maxIterations = toolSessionActive
    ? Math.max(1, routedToolPolicy.maxIterations || 1)
    : 1;
  const toolResultPreviewLimit = 500;
  const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
  const emitToolLifecycle = (payload: {
    correlationId: string;
    name: string;
    arguments: Record<string, any>;
    result?: string;
    error?: string;
  }) => {
    if (session.isBackgroundWork) {
      session.activeWorkStatus = 'executing';
      session.activeWorkStep = payload.error !== undefined
        ? `${payload.name} failed`
        : payload.result !== undefined
          ? `${payload.name} completed`
          : `Running ${payload.name}`;
      if (payload.result !== undefined || payload.error !== undefined) session.activeWorkToolCalls++;
      emitVoiceWorkProgress(
        socket,
        session,
        requestId,
        payload.error !== undefined
          ? 'blocked'
          : payload.result !== undefined
            ? 'step_completed'
            : 'executing',
      );
    }
    const normalized = { ...payload, args: payload.arguments, source: 'voice' };
    emitAgent("agent:tool_call", normalized);
    emitAgent("agent:tool", normalized);
  };

  const receiptObserver = createConversationReceiptObserver({
    userId: session.userId, conversationId: conversationTurn.conversation.id,
    taskId: actionTaskExecution.state?.taskId, requestId, turnRowId: actionTaskExecution.turnRowId, ...voiceScope,
  }, turnAuthorization.isCurrent);
  const desktopRelay = createDesktopRelay({
    io,
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    source: 'voice',
    taskId: actionTaskExecution.state?.taskId,
    requestId,
    requestSocket: socket,
    emitToolLifecycle,
    onLateResult: receiptObserver.onDesktopLateResult,
    formatResultForLifecycle: formatToolResultForUi,
    cancelOnRequestSocketDisconnect: true,
    signal: pipelineAbort.signal,
    leaseTimeoutMs: VOICE_DESKTOP_LEASE_WAIT_MS,
  });
  const desktopPausePresentation = () => formatDesktopControlPausePresentation(routedUserText);

  const runtimeOwnedDeterministicRecoveryCall = buildDurableTaskDeterministicToolRecoveryCall(
    actionTaskExecution.state,
    requestId,
    confirmationResolution.revokedCorrectionBasis,
  );
  let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
  const requestConfirmation = createTurnConfirmation({
    userId: session.userId, source: 'voice', requestId, actionIntent: actionIntentText,
    autoApprovalIntent: routedUserText,
    pending: pendingConfirmation,
    consumeScope: () => confirmationScope,
    proposalScope: () => ({ ...confirmationChannelScope, taskId: actionTaskExecution.state?.taskId }),
    correctionRequiresFreshConfirmation,
    exactWriteCorrection: correctionRequiresFreshConfirmation && confirmationResolution.revokedCorrectionBasis?.toolName === 'write_file',
    recoveryCall: () => runtimeOwnedDeterministicRecoveryCall,
    isCancelled: () => pipelineAbort.signal.aborted,
    onPending: pending => {
      pendingConfirmationCreatedThisTurn = pending;
      trustedVoiceConfirmationText = formatPendingConfirmationRequest(pending);
      setConversationActionExecutionStatus(conversationTurn.conversation.id, session.userId, 'waiting_confirmation', {
        assistantState: trustedVoiceConfirmationText, requestId,
      });
    },
  });

  const toolContext = {
    ...toolSecurityContext,
    currentTurnExecutionRequested: executionPipeline.executionRequested,
    resolutionId: executionPipeline.resolution.id,
    trustedActionContinuation: executionPipeline.trustedActionContinuation,
    acceptedTaskTarget: turnFlow.acceptedTaskTarget,
            currentAppTarget: turnFlow.currentAppEditTarget,
    userId: session.userId,
    taskId: actionTaskExecution.state?.taskId,
    conversationId: conversationTurn.conversation.id,
    turnId: requestId,
    turnRowId: actionTaskExecution.turnRowId,
    requestId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    desktopRelay,
    llmGetters,
    taskRevision: actionTaskExecution.state?.revision,
    source: 'voice',
    supervisedExternalCommits: true,
    allowLocalFileWrites,
    localWriteIntentReason,
    actionIntent: actionIntentText,
    routedTaskText: turnFlow.routeText,
    ...(effectiveOperationMode === 'assistant' || effectiveOperationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? { requestConfirmation } : {}),
    executionSignal: pipelineAbort?.signal,
    isCancelled: () => !isCurrentTurn(),
    onToolStart: executionReceipts.onToolStart,
    onToolRecord: (record: ToolExecutionRecord) => {
      executionReceipts.onToolRecord(record);
      receiptObserver.onToolRecord(record);
    },
    onToolFinished: executionReceipts.onToolFinished,
    onProgress: (step: string) => {
      if (!isCurrentTurn()) return;
      if (session.isBackgroundWork && step.trim()) {
        session.activeWorkStatus = 'executing';
        session.activeWorkStep = step.trim().slice(0, 160);
        emitVoiceWorkProgress(socket, session, requestId, 'executing');
      }
      if (shouldForwardPreFinalizationProgress(step)) {
        emitAgent("agent:progress", { text: step, agentName: "Lumi" });
      }
    },
    toolPolicy: routedToolPolicy,
    modelToolProjection,
    desktopExecutionTracker,
  };
  const turnEmotionState = (() => {
    try { return loadEmotionalState(voiceStateKey); } catch { return undefined; }
  })();
  let responseText = '';
  let completionGuard: LLMResult['completionGuard'];
  let toolResults: ToolExecutionRecord[] = [];
  const persistVoiceLearning = (
    assistantText: string,
    options: {
      channel?: 'voice' | 'workflow';
      toolRecords?: ToolExecutionRecord[];
      sourceInteractionId?: string;
      logLabel?: string;
    } = {},
  ) => {
    if (!turnAuthorization.isCurrent()) return;
    persistLumiPostTurnLearning(
      {
        userId: session.userId,
        userText,
        defaultChannel: 'voice',
        flow: turnFlow,
        getToolNames: () => toolRegistry.getToolDeclarations({
          context: { userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, source: 'voice' },
        }).map(declaration => declaration.function.name),
        domain: voiceScope.domain,
        orgId: voiceScope.orgId,
        defaultSourceInteractionId: `voice_${Date.now()}`,
        agentId: session.agentId,
        log: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
      },
      assistantText,
      options,
    );
  };
  const persistVoiceTakeoverExecution = (
    assistantText: string,
    options: {
      toolRecords?: ToolExecutionRecord[];
      source?: string;
      sourceInteractionId?: string;
      finalizationBlocked?: boolean;
      assistantTextTrusted?: boolean;
      finalizationReason?: string;
    } = {},
  ) => {
    const currentToolRecords = options.toolRecords || [];
    // History explanations may carry old tool receipts for finalization, but
    // only a ledger produced by this turn is eligible for task writeback.
    if (currentToolRecords.length === 0) return null;
    const executionWriteback = persistWorkTakeoverTurnExecution({
      userId: session.userId,
      userText: actionIntentText,
      assistantText,
      source: options.source || 'voice',
      interactionId: options.sourceInteractionId || `voice_${Date.now()}`,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      flow: turnFlow,
      capabilitySelection,
      toolRecords: currentToolRecords,
      finalizationBlocked: options.finalizationBlocked === true,
      assistantTextTrusted: options.assistantTextTrusted
        ?? options.finalizationBlocked !== true,
      finalizationReason: options.finalizationReason,
    });
    return executionWriteback;
  };
  let sentenceIdx = 0;
  const ttsPromises: Promise<void>[] = [];
  const deferCompletionSpeech = shouldDeferModelOutputUntilFinalized({
    taskText: actionIntentText,
    allowToolUse: toolSessionActive,
    flow: turnFlow,
  });
  const modelTextGate = createPreFinalizationTextGate();

  // ── Generation gating: only latest command gets TTS output ──
  session.bgGeneration++;
  let turnSpeechGeneration = -1;
  let turnSpeechAbort: AbortController | null = null;
  let ttsQueue: Promise<void> = Promise.resolve();
  type SynthesizedSpeech = Awaited<ReturnType<typeof synthesizeSpeech>> & { ttsRequestedAt: number; ttsReadyAt: number };
  let lockedTurnTtsRoute: LockedVoiceTurnTtsRoute | null | undefined;
  let lockedTurnTtsRoutePromise: Promise<LockedVoiceTurnTtsRoute | null> | null = null;
  let turnTtsEmittedSegments = 0;
  let turnTtsFallbackAttempted = false;
  let turnTtsUnavailable = false;

  const resolveLockedRoute = async (
    provider: TTSProvider,
    requestedVoiceId: string | null,
  ): Promise<LockedVoiceTurnTtsRoute | null> => {
    const voiceResolution = await resolveVoiceForProvider(
      voiceProfileScope(session.userId, session.domain, session.orgId),
      provider,
      requestedVoiceId,
    );
    if (!voiceResolution.voiceId) return null;
    const emotionVoice = resolveEmotionVoice(voiceResolution.voiceId, turnEmotionState);
    return lockVoiceTurnTtsRoute({
      provider,
      voiceId: emotionVoice.voiceId,
      ...(provider === 'relay' && turnTtsSelection.model ? { model: turnTtsSelection.model } : {}),
      ...(emotionVoice.speechRate !== undefined ? { speechRate: emotionVoice.speechRate } : {}),
      ...(emotionVoice.pitch !== undefined ? { pitch: emotionVoice.pitch } : {}),
      ...(emotionVoice.volume !== undefined ? { volume: emotionVoice.volume } : {}),
    });
  };

  const getLockedTurnTtsRoute = (): Promise<LockedVoiceTurnTtsRoute | null> => {
    if (lockedTurnTtsRoute !== undefined) return Promise.resolve(lockedTurnTtsRoute);
    if (lockedTurnTtsRoutePromise) return lockedTurnTtsRoutePromise;
    lockedTurnTtsRoutePromise = (async () => {
      if (!turnTtsSelection.provider || !turnTtsSelection.requestedVoiceId) return null;
      const route = await resolveLockedRoute(
        turnTtsSelection.provider,
        turnTtsSelection.requestedVoiceId,
      );
      // Reconcile the server selection for future turns, but never overwrite a
      // newer explicit switch that arrived while this route was resolving.
      if (
        route
        && route.voiceId !== turnTtsSelection.requestedVoiceId
        && session.voiceSwitchGeneration === turnTtsSelection.switchGeneration
        && session.currentVoiceId === turnTtsSelection.requestedVoiceId
      ) {
        const previousVoiceId = session.currentVoiceId;
        session.currentVoiceId = route.voiceId;
        session.voiceSwitchGeneration += 1;
        socket.emit('audio:voice_changed', {
          voiceId: route.voiceId,
          previousVoiceId,
          sessionId: session.sessionId,
          provider: route.provider,
          fallback: true,
          reason: 'provider_compatibility',
        });
      }
      return route;
    })().then(route => {
      lockedTurnTtsRoute = route;
      lockedTurnTtsRoutePromise = null;
      return route;
    }, error => {
      lockedTurnTtsRoutePromise = null;
      throw error;
    });
    return lockedTurnTtsRoutePromise;
  };

  const tryLockTurnTtsFallback = async (
    failedRoute: LockedVoiceTurnTtsRoute,
    error: unknown,
    signal: AbortSignal,
  ): Promise<LockedVoiceTurnTtsRoute | null> => {
    if (!canFallbackVoiceTurnTtsRoute({
      emittedSegments: turnTtsEmittedSegments,
      fallbackAttempted: turnTtsFallbackAttempted,
      error,
      signal,
    })) return null;
    turnTtsFallbackAttempted = true;
    const fallbackProvider = getTTSFallbackProvider(failedRoute.provider, { requireWarmLocal: true });
    if (!fallbackProvider || fallbackProvider === failedRoute.provider) return null;
    const fallbackRoute = await resolveLockedRoute(
      fallbackProvider,
      turnTtsSelection.requestedVoiceId,
    );
    if (!fallbackRoute) return null;
    lockedTurnTtsRoute = fallbackRoute;
    logger.warn(
      `[Audio TTS] Primary route failed before playback; locked request=${requestId} fallback=${fallbackRoute.provider} voice=${fallbackRoute.voiceId}`,
    );
    return fallbackRoute;
  };

  const synthesizeOnRoute = async (
    text: string,
    route: LockedVoiceTurnTtsRoute,
    signal: AbortSignal,
  ) => {
    turnAuthorization.assertCurrent();
    const ttsRequestedAt = Date.now();
    const result = await synthesizeSpeech(text, {
      provider: route.provider,
      voiceId: route.voiceId,
      model: route.model,
      speechRate: route.speechRate,
      pitch: route.pitch,
      volume: route.volume,
      signal,
      allowFallback: false,
    });
    return { ...result, ttsRequestedAt, ttsReadyAt: Date.now() };
  };

  let speculativeSpeech: {
    text: string;
    requestedAt: number;
    controller: AbortController;
    promise: Promise<{ result?: SynthesizedSpeech; route?: LockedVoiceTurnTtsRoute; error?: unknown }>;
  } | null = null;

  const ensureTurnSpeechController = () => {
    if (
      !turnSpeechAbort
      || turnSpeechAbort.signal.aborted
      || turnSpeechGeneration !== session.bgGeneration
    ) {
      if (session.ttsAbortController && session.ttsAbortController !== turnSpeechAbort) {
        session.ttsAbortController.abort();
      }
      turnSpeechAbort = new AbortController();
      turnSpeechGeneration = session.bgGeneration;
      session.ttsAbortController = turnSpeechAbort;
    }
    return { controller: turnSpeechAbort, generation: turnSpeechGeneration };
  };

  const estimatePlaybackMs = (audioBuffer: Buffer, text: string): number => {
    const fallback = Math.min(18000, Math.max(2200, text.length * 185 + 700));
    try {
      if (
        Buffer.isBuffer(audioBuffer) &&
        audioBuffer.length > 44 &&
        audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
        audioBuffer.toString('ascii', 8, 12) === 'WAVE'
      ) {
        const byteRate = audioBuffer.readUInt32LE(28);
        let offset = 12;
        while (offset + 8 <= audioBuffer.length) {
          const chunkId = audioBuffer.toString('ascii', offset, offset + 4);
          const chunkSize = audioBuffer.readUInt32LE(offset + 4);
          if (chunkId === 'data' && byteRate > 0) {
            return Math.min(30000, Math.max(1000, Math.round(chunkSize / byteRate * 1000) + 450));
          }
          offset += 8 + chunkSize + (chunkSize % 2);
        }
      }
    } catch {}
    return fallback;
  };

  const maybeStartSpeculativeSpeech = () => {
    if (
      speculativeSpeech
      || toolSessionActive
      || deferCompletionSpeech
      || !turnTtsSelection.provider
      || !turnTtsSelection.requestedVoiceId
      || pipelineAbort?.signal.aborted
    ) return;
    const firstSentence = extractFirstCompleteSpeechSentence(responseText);
    if (!firstSentence) return;
    const controller = new AbortController();
    pipelineAbort?.signal.addEventListener('abort', () => controller.abort(), { once: true });
    const promise = getLockedTurnTtsRoute()
      .then(async route => {
        if (!route) return { error: new Error('No compatible TTS route is available') };
        const result = await synthesizeOnRoute(firstSentence, route, controller.signal);
        return { result, route };
      })
      .catch(error => ({ error }));
    speculativeSpeech = {
      text: firstSentence,
      requestedAt: Date.now(),
      controller,
      promise,
    };
  };

  const synthesizeWithLockedTurnRoute = async (
    text: string,
    signal: AbortSignal,
    preparedFailure?: { route?: LockedVoiceTurnTtsRoute; error: unknown; requestedAt?: number },
  ): Promise<{ result: SynthesizedSpeech; route: LockedVoiceTurnTtsRoute }> => {
    const ttsRequestedAt = preparedFailure?.requestedAt ?? Date.now();
    let route = preparedFailure?.route || await getLockedTurnTtsRoute();
    if (!route) throw preparedFailure?.error || new Error('No compatible TTS route is available');

    if (preparedFailure) {
      const fallback = await tryLockTurnTtsFallback(route, preparedFailure.error, signal);
      if (!fallback) throw preparedFailure.error;
      route = fallback;
    }

    try {
      return { result: { ...await synthesizeOnRoute(text, route, signal), ttsRequestedAt }, route };
    } catch (error) {
      const fallback = await tryLockTurnTtsFallback(route, error, signal);
      if (!fallback) throw error;
      return { result: { ...await synthesizeOnRoute(text, fallback, signal), ttsRequestedAt }, route: fallback };
    }
  };

  const flushSentence = (sentence: string): Promise<number> => {
    const txt = sentence.trim();
    if (!txt || txt.length <= 1 || turnTtsUnavailable || !session.isActive || session.suppressedSpeechRequestIds.has(requestId)) return Promise.resolve(0);
    if (!/[a-zA-Z一-鿿㐀-䶿\d]/.test(txt)) return Promise.resolve(0);
    const speech = ensureTurnSpeechController();
    if (!isCurrentTurn() || speech.controller.signal.aborted) return Promise.resolve(0);
    sentenceIdx++;
    let resolvePlayback: (value: number) => void = () => {};
    const playbackDone = new Promise<number>(resolve => { resolvePlayback = resolve; });
    // Serialize TTS to avoid 429 rate limits
    ttsQueue = ttsQueue.then(async () => {
      if (!isCurrentTurn() || speech.controller.signal.aborted) {
        resolvePlayback(0);
        return;
      }
      if (session.bgGeneration !== speech.generation) {
        resolvePlayback(0);
        return;
      }
      if (turnTtsUnavailable) {
        resolvePlayback(0);
        return;
      }
      session.isSpeaking = true;
      voiceTransportState.ttsSpeakingCount++;
      try {
        const initialRoute = await getLockedTurnTtsRoute();
        if (!initialRoute) {
          turnTtsUnavailable = true;
          logger.warn('[Audio TTS] No configured healthy provider; delivering text and reporting the unavailable audio lane');
          emitVoiceTtsFailure(socket, requestId, 'conversation');
          resolvePlayback(0);
          return;
        }
        let synthesized: { result: SynthesizedSpeech; route: LockedVoiceTurnTtsRoute };
        if (speculativeSpeech?.text === txt) {
          const prepared = await speculativeSpeech.promise;
          if (prepared.result && prepared.route === initialRoute) {
            synthesized = { result: prepared.result, route: prepared.route };
          } else {
            synthesized = await synthesizeWithLockedTurnRoute(
              txt,
              speech.controller.signal,
              { route: prepared.route || initialRoute, error: prepared.error || new Error('Speculative TTS route changed'), requestedAt: speculativeSpeech.requestedAt },
            );
          }
          speculativeSpeech = null;
        } else {
          if (speculativeSpeech) {
            speculativeSpeech.controller.abort();
            speculativeSpeech = null;
          }
          synthesized = await synthesizeWithLockedTurnRoute(txt, speech.controller.signal);
        }
        if (isCurrentTurn() && !speech.controller.signal.aborted && session.bgGeneration === speech.generation) {
          // Only the audio segment actually accepted for playback owns these
          // timestamps. Discarded speculative speech is not a delivery metric.
          markVoiceLatencyMilestone(requestId, 'firstTtsRequestedAt', synthesized.result.ttsRequestedAt);
          markVoiceLatencyMilestone(requestId, 'firstTtsReadyAt', synthesized.result.ttsReadyAt);
          socket.emit("audio:status", { status: "speaking", requestId });
          addEchoText(txt, voiceEchoScope(session));
          const volumeGain = computeVolumeGain();
          socket.emit("audio:response", {
            buffer: synthesized.result.audioBuffer,
            format: synthesized.result.format,
            volumeGain,
            requestId,
            lane: 'conversation',
          });
          turnTtsEmittedSegments += 1;
          logger.info(
            `[Audio TTS] Emitted request=${requestId} provider=${synthesized.route.provider} voice=${synthesized.route.voiceId} bytes=${synthesized.result.audioBuffer.length}`,
          );
          const playbackMs = estimatePlaybackMs(synthesized.result.audioBuffer, txt);
          setTimeout(() => resolvePlayback(0), playbackMs);
        } else {
          resolvePlayback(0);
        }
      } catch (e: any) {
        if (isTtsCancellationError(e, speech.controller.signal)) {
          resolvePlayback(0);
          return;
        }
        logger.warn(`[Audio TTS] ${e.message?.slice(0, 80)}`);
        turnTtsUnavailable = true;
        emitVoiceTtsFailure(socket, requestId, 'conversation');
        resolvePlayback(0);
      } finally {
        if (session.bgGeneration === speech.generation) session.isSpeaking = false;
        // Keep voiceTransportState.ttsSpeakingCount elevated for 3s after synthesis — client playback continues
        const decay = () => { voiceTransportState.ttsSpeakingCount = Math.max(0, voiceTransportState.ttsSpeakingCount - 1); };
        const t = setTimeout(decay, 3000);
        session.ttsDecayTimers.push(t);
      }
    });
    ttsPromises.push(ttsQueue);
    return playbackDone;
  };

  const queueFinalizedSpeech = (text: string) => {
    if (!isCurrentTurn()) return;
    if (session.isBackgroundWork) {
      session.activeWorkStatus = pendingConfirmationCreatedThisTurn
        ? 'waiting_confirmation'
        : 'completed';
    }
    if (session.suppressedSpeechRequestIds.has(requestId)) return;
    session.bgGeneration++;
    const sentences = String(text || '').split(/(?<=[。！？.!?\n])/u);
    const firstFinalSentence = String(sentences[0] || '').trim();
    if (speculativeSpeech && speculativeSpeech.text !== firstFinalSentence) {
      speculativeSpeech.controller.abort();
      speculativeSpeech = null;
    }
    for (const sentence of sentences) {
      if (pipelineAbort?.signal.aborted) break;
      flushSentence(sentence);
    }
  };

  const releaseVoiceTransportResources = (): void => {
    resources.admission?.release();
    actionLeaseHeartbeat?.stop();
    speculativeSpeech?.controller.abort();
    speculativeSpeech = null;
    desktopRelay.releaseControlLease('voice_turn_complete');

    // An older aborted pipeline must never clear state/controllers that already
    // belong to a newer barge-in turn.
    if (session.pipelineAbortController !== pipelineAbort) return;
    if (
      session.activeTaskConversationId
      && session.activeTaskRequestId === requestId
    ) {
      session.activeTaskConversationId = null;
      session.activeTaskRequestId = null;
      session.activeTaskId = null;
    }
    if (session.activeForegroundRequestIdentity?.requestId === requestId) {
      session.activeForegroundRequestIdentity = null;
    }
    session.sidecarAbortController?.abort();
    session.sidecarAbortController = null;
    session.sidecarGeneration++;
    session.sidecarHistory = [];
    session.isSpeaking = false;
    session.isProcessing = false;
    session.isBackgroundWork = false;
    session.activeWorkStatus = 'idle';
    session.activeWorkStep = '';
    session.activeWorkToolCalls = 0;
    stopVoiceWorkHeartbeat(session);
    if (session.ttsAbortController === turnSpeechAbort) session.ttsAbortController = null;
    session.pipelineAbortController = null;
    session.activeTurnText = '';
    session.activeRoutingText = '';

    if (session.isActive) {
      resetSilenceTimer(session, socket);
      socket.emit('audio:status', { status: 'listening', requestId });
      emitAgent('agent:status', { status: 'idle' });
    }
    session.activeTurnRequestId = null;
    session.activeTurnProvenance = null;
    session.suppressedSpeechRequestIds.delete(requestId);
  };
  const voiceReleaseGate = createDurableForegroundReleaseGate({
    converge: async reason => {
      // The cancellation owner must consume completed/in-flight tool receipts
      // before this old pipeline can settle its task or release the lease.
      if (executionReceipts.cancellation) await executionReceipts.cancellation;
      // Durable ownership always converges before any heartbeat, desktop lease,
      // or mutable voice work lane is released. This remains safe for an older
      // aborted pipeline because the immutable identity is local to this turn.
      const releaseResult = await enforceVoiceForegroundConvergenceBeforeRelease({
        identity: foregroundRequestIdentity,
        aborted: pipelineAbort.signal.aborted,
        reason,
        assistantState: finalAgentResponseDelivered ? responseText : undefined,
      });
      return Boolean(releaseResult?.converged);
    },
    releaseResources: releaseVoiceTransportResources,
    onRecoveryTakeover: ({ attempts }) => logger.error('[Audio] voice_foreground_release_recovery_takeover', {
      code: 'VOICE_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
      identity: foregroundRequestIdentity,
      attempts,
    }),
  });
  resources.ownedByDurableRelease = true;
  const releaseVoiceTurnResources = (
    reason = 'Voice turn reached its release boundary.',
  ): Promise<boolean> => {
    const cancel = !turnAuthorization.isCurrent() && !finalAgentResponseDelivered
      ? session.cancelAuthorizationTurn?.(requestId)
      : undefined;
    return Promise.resolve(cancel).then(() => voiceReleaseGate.release(reason));
  };

  const finishVoiceTerminal = createVoiceTerminalCompletion({
    commit: commitVoiceTerminal,
    drainSpeech: () => Promise.allSettled(ttsPromises),
    isCurrent: isCurrentTurn,
    release: releaseVoiceTurnResources,
  });

  if (transcriptExecutionGuard.action === 'clarify') {
    // Resolve uncertain STT before confirmation, meeting control, or tools.
    responseText = transcriptExecutionGuard.responseText;
    await commitVoiceTerminal({
      text: responseText,
      source: 'voice_transcript_guard',
      blocked: false,
      reason: transcriptExecutionGuard.reason,
      cognitiveIntent: 'voice_transcript_clarification',
      llmWasCalled: false,
      speechText: responseText,
    });
    await Promise.allSettled(ttsPromises);
    await releaseVoiceTurnResources('Voice transcript clarification completed without tool admission.');
    return;
  }

  if (!session.agentId?.startsWith('memory_avatar_') && isExplicitMemoryRequest(userText)) {
    try {
      const receipt = await persistTurnMemory({ userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId,
        userText, channel: 'voice', source: 'voice', requestId, conversationId: conversationTurn.conversation.id,
        agentId: session.agentId, authorization: turnAuthorization, signal: pipelineAbort.signal, llmGetters });
      responseText = receipt.text;
      await commitVoiceTerminal({ text: receipt.text, speechText: receipt.text, source: 'voice_memory',
        blocked: receipt.status === 'failed', reason: receipt.status === 'saved' ? 'memory_saved' : 'memory_not_saved',
        cognitiveIntent: 'memory', llmWasCalled: true, toolCalls: [] });
      await Promise.allSettled(ttsPromises);
    } finally { await releaseVoiceTurnResources('Explicit voice memory turn completed.'); }
    return;
  }

  const deterministicConversationResponse = (() => {
    if (userObservedCompletion) return null;
    if (isConversationExecutionFactQuestion(actionIntentText)) {
      return {
        text: formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId: conversationTurn.conversation.id,
          userId: session.userId,
          domain: voiceScope.domain,
          orgId: voiceScope.orgId,
          currentRequestId: requestId,
          taskId: actionTaskExecution.state?.taskId
            || conversationTurn.conversation.actionContinuationState?.taskId
            || undefined,
        }), actionIntentText),
        intent: 'execution_facts',
        source: 'voice_conversation_execution_facts',
      };
    }
    const corrected = resolveExactConversationCorrection(actionIntentText, recentVoiceHistory);
    return corrected
      ? { text: corrected, intent: 'exact_correction', source: 'voice_exact_correction' }
      : null;
  })();
  if (deterministicConversationResponse) {
    responseText = deterministicConversationResponse.text;
    await commitVoiceTerminal({
      text: responseText,
      source: deterministicConversationResponse.source,
      blocked: false,
      reason: deterministicConversationResponse.intent,
      cognitiveIntent: deterministicConversationResponse.intent,
      llmWasCalled: false,
      speechText: responseText,
    });
    await Promise.allSettled(ttsPromises);
    await releaseVoiceTurnResources('Deterministic voice response completed.');
    return;
  }

  if (userObservedCompletion) {
    const conversation = conversationTurn.conversation;
    const observedTask = userObservedCompletionTask!;
    await clearPendingConfirmationDurably(session.userId, buildTransportNeutralConfirmationScope({
      domain: voiceScope.domain, orgId: voiceScope.orgId,
      conversationId: conversation.id, taskId: observedTask.taskId,
    }));
    pendingConfirmation = null;
    pendingConfirmationPrompt = '';
    responseText = formatConversationActionTaskStatus({
      ...observedTask, status: 'completed', unfinished: false,
      latestBlocker: '', completionSource: 'user_observation',
    });
    await commitVoiceTerminal({
      text: responseText,
      source: 'voice_task_user_observation',
      blocked: false,
      reason: '',
      cognitiveIntent: 'task_user_observation',
      llmWasCalled: false,
      speechText: responseText,
      persistTerminalState: () => {
        const completed = completeConversationActionFromUserObservation(
          conversation.id, session.userId, userText,
          { taskId: observedTask.taskId!, requestId, userMessageId: voiceUserMessageId },
        );
        if (!completed) throw new Error('User observation no longer owns the pending task');
        return completed;
      },
    });
    await Promise.allSettled(ttsPromises);
    await releaseVoiceTurnResources('Voice task observation response completed.');
    return;
  }

  if (actionFollowupIntent === 'status') {
    responseText = getConversationActionStatus(
      conversationTurn.conversation.id,
      session.userId,
      actionIntentText,
      conversationTurn.conversation.actionContinuationState,
    );
    await commitVoiceTerminal({
      text: responseText,
      source: 'voice_task_status',
      blocked: false,
      reason: '',
      cognitiveIntent: 'task_status',
      llmWasCalled: false,
      speechText: responseText,
    });
    await Promise.allSettled(ttsPromises);
    await releaseVoiceTurnResources('Voice task status response completed.');
    return;
  }

  // A short confirmation utterance is a continuation of the exact pending
  // action, not a fresh chat turn. Execute the stored tool/arguments directly
  // so the model cannot forget, rewrite, or merely print the tool protocol.
  if (pendingConfirmation) {
    const confirmedTask = pendingConfirmation.actionIntent || actionIntentText;
    const confirmedArgs = pendingConfirmation.exactArgs || {};
    const confirmationConsumed = await consumePendingConfirmationDurably(
      session.userId,
      pendingConfirmation.id,
      pendingConfirmation.toolName,
      confirmedArgs,
      confirmationScope,
    );
    const confirmationRecordId =
      `voice-confirmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.isBackgroundWork = true;
    session.activeWorkStatus = 'executing';
    session.activeWorkStep = `Running ${pendingConfirmation.toolName}`;
    if (!isDirectDesktopTool(pendingConfirmation.toolName)) {
      emitToolLifecycle({
        correlationId: confirmationRecordId,
        name: pendingConfirmation.toolName,
        arguments: confirmedArgs,
      });
    }
    const confirmationRecord = await executeToolCall({
      registry: toolRegistry,
      id: confirmationRecordId,
      name: pendingConfirmation.toolName,
      arguments: confirmedArgs,
      context: {
        ...toolContext,
        toolPolicy: routedToolPolicy,
        userConfirmed: true,
        requestConfirmation: undefined,
        actionIntent: confirmedTask,
        routedTaskText: confirmedTask,
      },
      preflight: () => confirmationConsumed
        ? { allowed: true, arguments: confirmedArgs }
        : {
            allowed: false,
            arguments: confirmedArgs,
            reason: 'The one-time confirmation expired before execution.',
          },
    });
    if (!isCurrentTurn()) {
      await releaseVoiceTurnResources('Voice confirmation execution was interrupted.');
      return;
    }
    if (!isDirectDesktopTool(confirmationRecord.name)) {
      if (confirmationRecord.error) {
        emitToolLifecycle({
          correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
          name: confirmationRecord.name,
          arguments: confirmedArgs,
          error: confirmationRecord.error,
        });
      } else {
        emitToolLifecycle({
          correlationId: confirmationRecord.id || `voice-confirmed-${Date.now()}`,
          name: confirmationRecord.name,
          arguments: confirmedArgs,
          result: formatToolResultForUi(confirmationRecord.result),
        });
      }
    }
    const confirmationSucceeded = toolRecordSucceeded(confirmationRecord);
    confirmationRecord.executionOrigin = 'confirmed_action_resume';
    let confirmationRecords: ToolExecutionRecord[] = [confirmationRecord];
    let confirmationLlmWasCalled = false;
    const completedConfirmedAction = tryFinalizeVerifiedBoundedAction({
      taskText: confirmedTask,
      responseText: '',
      toolRecords: taskAwareRecords([confirmationRecord]),
      source: 'voice_confirmation',
      flow: { ...turnFlow, routeText: confirmedTask },
      taskId: actionTaskExecution.state?.taskId,
      requestId,
    });
    let confirmationCandidate = completedConfirmedAction?.text || (confirmationSucceeded
      ? CN_VOICE_FAST_PATH_MESSAGES.confirmationExecuted
      : CN_VOICE_FAST_PATH_MESSAGES.confirmationFailed(
          recordsToTaskReceipts([confirmationRecord])[0]?.error
            || confirmationRecord.error
            || confirmationRecord.result,
        ));

    if (!completedConfirmedAction && confirmedStepNeedsContinuation(confirmedTask, taskAwareRecords([confirmationRecord])) && isCurrentTurn()) {
      // Confirmation is a boundary inside the same task, not the end of the
      // task. Continue the remaining plan immediately with the exact confirmed
      // receipt in context; a later hard boundary will stop once again.
      turnAuthorization.assertCurrent();
      const continuation = await runToolSession({
        messages: [
          { role: 'system', content: voiceSystemPrompt },
          ...buildConfirmedStepContinuationMessages(confirmedTask, confirmationRecord, {
            messageId: voiceUserMessageId,
            text: userText,
          }),
        ],
        registry: toolRegistry,
        config: {
          provider,
          model: voiceModel,
          modelTurnState,
          userId: session.userId,
          domain: voiceScope.domain,
          orgId: voiceScope.orgId,
          signal: pipelineAbort.signal,
          inputTokenBudget: voiceInputTokenBudget,
          ...reasoningRoutePolicy,
        },
        onToolCall: record => {
          if (!record?.name) return;
          if (!isDirectDesktopTool(record.name)) {
            emitToolLifecycle({
              correlationId: record.id || `voice-confirmation-resume-${Date.now()}`,
              name: record.name,
              arguments: record.arguments || {},
              result: record.error ? undefined : formatToolResultForUi(record.result),
              error: record.error,
            });
          }
        },
        maxIterations: Math.max(1, routedToolPolicy.maxIterations || 5),
        context: {
          ...toolContext,
          actionIntent: confirmedTask,
          routedTaskText: confirmedTask,
          toolPolicy: routedToolPolicy,
          priorToolRecords: taskAwareRecords([confirmationRecord]),
        },
        getters: llmGetters,
      });
      if (!isCurrentTurn()) {
        await releaseVoiceTurnResources('Voice confirmation continuation was interrupted.');
        return;
      }
      confirmationRecords = coalesceToolExecutionRecords([confirmationRecord, ...(continuation.toolCalls || [])]);
      confirmationLlmWasCalled = continuation.usageRecords.length > 0;
      for (const usage of continuation.usageRecords) {
        recordTokenUsage(session.userId, usage.provider, usage.model, {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        }, requestId, 'voice');
      }
      completionGuard = continuation.completionGuard;
      confirmationCandidate = pendingConfirmationCreatedThisTurn
        ? trustedVoiceConfirmationText!
        : continuation.text || confirmationCandidate;
    }
    confirmationRecords = withDesktopExecutionReceipt(confirmationRecords, desktopExecutionTracker);
    const confirmedFinal = pendingConfirmationCreatedThisTurn
      ? {
          text: trustedVoiceConfirmationText!,
          blocked: false,
          reason: 'waiting_confirmation',
          notification: undefined,
        }
      : finalizeLumiResponse({
          taskText: confirmedTask,
          responseText: confirmationCandidate,
          completionGuard,
          toolRecords: taskAwareRecords(confirmationRecords),
          source: 'voice_confirmation',
          flow: { ...turnFlow, routeText: confirmedTask },
          taskId: actionTaskExecution.state?.taskId,
          requestId,
        });
    confirmationRecord.executionOrigin = 'confirmed_action_resume';
    responseText = confirmedFinal.text;
    await finishVoiceTerminal({
      text: responseText,
      source: 'voice_confirmation',
      blocked: confirmedFinal.blocked,
      reason: confirmedFinal.reason || '',
      cognitiveIntent: confirmedFinal.blocked ? 'work_product_guard' : 'confirmation',
      llmWasCalled: confirmationLlmWasCalled,
      toolCalls: confirmationRecords,
      speechText: responseText,
      notification: confirmedFinal.notification,
    }, {
      completedReason: 'Voice confirmation fast path completed.',
      interruptedReason: 'Voice confirmation terminal delivery was interrupted.',
      onCommitted: () => {
        persistVoiceLearning(responseText, {
          toolRecords: confirmationRecords,
          sourceInteractionId: `voice_confirmation_${Date.now()}`,
          logLabel: 'voice confirmation',
        });
      },
    });
    return;
  }

  let recentActionExplanation: string | null = interruptedActivityResponse;
  let recentActionEvidence: ToolExecutionRecord[] = [];
  try {
    const conversation = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    const recentActionHistory = recentVoiceHistory.length > 0
      ? recentVoiceHistory
      : getMessages(conversation.id, 30);
    recentActionEvidence = collectRecentActionToolRecords(recentActionHistory);
    if (!recentActionExplanation) {
      recentActionExplanation = describeRecentActionsFromHistory(userText, recentActionHistory);
    }
  } catch {}
  if (recentActionExplanation) {
    const finalizedRecentAction = finalizeLumiResponse({
      taskText: actionIntentText,
      responseText: recentActionExplanation,
      toolRecords: recentActionEvidence,
      source: 'voice_action_history',
      flow: turnFlow,
    });
    responseText = finalizedRecentAction.text;
    await finishVoiceTerminal({
      text: responseText,
      source: 'voice_action_history',
      blocked: finalizedRecentAction.blocked,
      reason: finalizedRecentAction.reason || '',
      cognitiveIntent: finalizedRecentAction.blocked ? 'work_product_guard' : 'action_history',
      llmWasCalled: false,
      speechText: responseText,
      notification: finalizedRecentAction.notification,
    }, {
      completedReason: 'Voice action-history fast path completed.',
      interruptedReason: 'Voice action-history response was interrupted.',
      onCommitted: () => {
        persistVoiceLearning(responseText, {
          sourceInteractionId: `voice_action_history_${Date.now()}`,
          logLabel: 'voice action history explanation',
        });
      },
    });
    return;
  }

  // Explicit meeting control keeps its immediate client acknowledgement.
  const directlyAppliedMode: OperationMode | null = requestedMode === 'meeting' ? 'meeting' : null;
  if (directlyAppliedMode) {
    let modeSynced = true;
    const modeToolRecord: ToolExecutionRecord = {
      id: `voice-mode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'client_action',
      arguments: {
        action: 'start_meeting_mode',
        mode: directlyAppliedMode,
        confirmed: true,
      },
      result: '',
    };
    try {
      modeToolRecord.result = await desktopRelay('client_action', modeToolRecord.arguments)
        || JSON.stringify({ ok: true, mode: directlyAppliedMode });
    } catch (err: any) {
      modeSynced = false;
      modeToolRecord.error = err?.message || String(err);
      emitAgent('agent:notification', {
        type: 'client_action',
        level: 'warning',
        message: `Mode switch did not reach the client: ${err?.message || err}`,
      });
    }
    if (!isCurrentTurn()) {
      await releaseVoiceTurnResources('Voice mode switch was interrupted before terminal delivery.');
      return;
    }
    if (modeSynced) {
      saveStoredOperationMode(session.userId, directlyAppliedMode);
    }

    if (isPureOperationModeSwitchRequest(userText, requestedMode)) {
      responseText = formatOperationModeSwitchResponse(directlyAppliedMode, modeSynced, userText);
      const finalizedMode = finalizeLumiResponse({
        taskText: actionIntentText,
        responseText,
        toolRecords: [modeToolRecord],
        source: 'voice',
        flow: turnFlow,
        taskId: actionTaskExecution.state?.taskId,
        requestId,
      });
      responseText = finalizedMode.text;
      await finishVoiceTerminal({
        text: responseText,
        source: "voice_mode",
        blocked: finalizedMode.blocked,
        reason: finalizedMode.reason || '',
        cognitiveIntent: finalizedMode.blocked ? 'work_product_guard' : 'operation_mode',
        llmWasCalled: false,
        toolCalls: [modeToolRecord],
        speechText: responseText,
        notification: finalizedMode.notification,
        persistTerminalState: () => persistVoiceTakeoverExecution(responseText, {
          toolRecords: [modeToolRecord],
          source: 'voice_mode',
          sourceInteractionId: `voice_mode_${Date.now()}`,
          finalizationBlocked: finalizedMode.blocked,
          assistantTextTrusted: !finalizedMode.blocked,
          finalizationReason: finalizedMode.reason,
        }),
      }, {
        completedReason: 'Voice mode-switch fast path completed.',
        interruptedReason: 'Voice mode switch terminal delivery was interrupted.',
        onCommitted: () => {
          persistVoiceLearning(responseText, {
            toolRecords: [modeToolRecord],
            sourceInteractionId: `voice_mode_${Date.now()}`,
            logLabel: 'voice mode switch',
          });
        },
      });
      return;
    }
  }

  const foregroundWeChatReadArgs = buildForegroundMessagingArguments('read', executionPipeline.normalizedIntent);
  const foregroundWeChatSendArgs = buildForegroundMessagingArguments('send', executionPipeline.normalizedIntent);
  // Read intent retains precedence: incoming messages must never enter a send capability.
  const foregroundMessagingAction = foregroundWeChatReadArgs ? 'read' : 'send';
  const foregroundMessagingArgs = foregroundWeChatReadArgs || foregroundWeChatSendArgs;
  if (foregroundMessagingArgs && toolSessionActive && !clientActionOnlyTurn && !selfRepairTurn) {
    const reading = foregroundMessagingAction === 'read';
    const source = reading ? 'voice_foreground_messaging_read' : 'voice_foreground_messaging';
    const correlationId = `voice-wechat-${foregroundMessagingAction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let toolRecord: ToolExecutionRecord = { id: correlationId,
      name: reading ? 'wechat_read_recent_chat' : 'wechat_send_message', arguments: foregroundMessagingArgs, result: '' };
    try {
      const foregroundExecution = await executeForegroundMessagingAction({
        action: foregroundMessagingAction, normalizedIntent: executionPipeline.normalizedIntent,
        executionPlan: executionPipeline.executionPlan, registry: toolRegistry, correlationId,
        arguments: foregroundMessagingArgs, context: toolContext,
        onLifecycle: event => emitToolLifecycle({ correlationId: event.correlationId,
          name: event.name, arguments: event.arguments,
          ...(event.phase === 'finish' && event.result ? { result: formatToolResultForUi(event.result) } : {}),
          ...(event.error ? { error: event.error } : {}),
        }),
      });
      toolRecord = foregroundExecution.record;
      if (toolRecord.error) throw new Error(toolRecord.error);
      if (!isCurrentTurn()) {
        await releaseVoiceTurnResources(`Voice foreground messaging ${foregroundMessagingAction} was interrupted.`);
        return;
      }
      const parsed = foregroundExecution.parsed;
      const contact = String(foregroundMessagingArgs.contact || '').trim();
      if (reading) {
        const summary = String(parsed.contentSummary || '').trim();
        const evidence = String(parsed.uiSnapshotPreview || '').slice(0, 1200);
        responseText = parsed.read && summary
          ? contact
            ? `我已经定位到你和${contact}的微信聊天。可见最近内容如下：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
            : `我已经读到当前微信聊天的可见最近内容：\n\n${summary}` // i18n-allow: reviewed Chinese verified messaging-read receipt.
          : parsed.read
            ? contact
              ? `我已经定位到你和${contact}的微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
              : `我已经定位到当前微信聊天，但视觉摘要不可用。当前可验证的窗口证据：\n\n${evidence}` // i18n-allow: reviewed Chinese partial messaging-read receipt.
            : `这次还没完成。卡住的位置：微信前台聊天读取。${String(parsed.visionError || parsed.note || '没有拿到可读的聊天内容证据。')}`; // i18n-allow: reviewed Chinese messaging-read blocker.
      } else {
        responseText = formatCnVoiceWeChatSendResult(contact, String(foregroundMessagingArgs.message || '').trim(),
          parsed.sent === true && parsed.verificationStatus === 'verified');
      }
    } catch (error: any) {
      toolRecord.error = error?.message || String(error);
      if (!isCurrentTurn()) {
        await releaseVoiceTurnResources(`Voice foreground messaging ${foregroundMessagingAction} failed after interruption.`);
        return;
      }
      responseText = reading
        ? `这次还没完成。卡住的位置：微信前台聊天读取：${toolRecord.error}。我不会把只打开或聚焦微信说成已读到聊天内容。` // i18n-allow: reviewed Chinese messaging-read failure receipt.
        : formatCnVoiceWeChatSendError(toolRecord.error);
    }
    const directFinal = finalizeLumiResponse({ taskText: actionIntentText, responseText, toolRecords: [toolRecord],
      source: 'voice', flow: turnFlow, taskId: actionTaskExecution.state?.taskId, requestId });
    responseText = directFinal.text;
    const interactionId = () => `voice_wechat_${foregroundMessagingAction}_${Date.now()}`;
    await finishVoiceTerminal({ text: responseText, source, blocked: directFinal.blocked,
      reason: directFinal.reason || '', cognitiveIntent: directFinal.blocked ? 'work_product_guard' : reading ? 'messaging_read' : 'messaging',
      llmWasCalled: false, toolCalls: [toolRecord], speechText: responseText, notification: directFinal.notification,
      persistTerminalState: () => persistVoiceTakeoverExecution(responseText, { toolRecords: [toolRecord], source,
        sourceInteractionId: interactionId(), finalizationBlocked: directFinal.blocked,
        assistantTextTrusted: !directFinal.blocked, finalizationReason: directFinal.reason }),
    }, {
      completedReason: `Voice foreground messaging-${foregroundMessagingAction} fast path completed.`,
      interruptedReason: reading ? 'Voice foreground messaging read was interrupted.' : 'Voice foreground messaging terminal delivery was interrupted.',
      onCommitted: () => persistVoiceLearning(responseText, { toolRecords: [toolRecord], sourceInteractionId: interactionId(),
        logLabel: reading ? 'voice foreground messaging read' : 'voice foreground messaging' }),
    });
    return;
  }

  try {
    if (!isCurrentTurn()) return;

    // Reuse the configured model and the shared execution decision.
    const effectiveModel = voiceModel;
    logger.info(`[Audio] Intent: ${executionPipeline.normalizedIntent.kind}, model: ${effectiveModel}`);

    // The shared loop and any bounded recovery receive the same persisted
    // conversation, including both user and assistant messages with their roles.
    const recentMsgs = getMessagesByTokenBudget(conversationTurn.conversation.id, 6_000, 6, requestId).filter(message => !(
      message.role === 'user' && message.externalMessageId === requestId
    ));
    const voiceHistory: NormalizedMessage[] = normalizeVoiceHistory(recentMsgs);
    const historyChars = voiceHistory.reduce((total, message) => (
      total + (typeof message.content === 'string' ? message.content.length : 0)
    ), 0);
    logger.info(`[Audio] Prompt budget request=${requestId} systemChars=${voiceSystemPrompt.length} historyMessages=${voiceHistory.length} historyChars=${historyChars}`);

    const messages: NormalizedMessage[] = [
      { role: 'system', content: voiceSystemPrompt },
      ...voiceHistory,
      { role: 'user', content: userText, sourceMessageId: voiceUserMessageId },
    ];
    const recoveryConversationMessages = messages;

    const modelConfig: LLMConfig = {
      modelTurnState,
      provider,
      model: effectiveModel,
      userId: session.userId,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
      conversationId: conversationTurn.conversation.id,
      requestId,
      source: 'voice',
      signal: pipelineAbort.signal,
      inputTokenBudget: voiceInputTokenBudget,
      ...reasoningRoutePolicy,
    };
    const onChunk = (chunk: string) => {
      if (!isCurrentTurn()) return;
      if (chunk) markVoiceLatencyMilestone(requestId, 'firstModelTokenAt');
      responseText += chunk;
      maybeStartSpeculativeSpeech();
      if (!deferCompletionSpeech) {
        const safeText = modelTextGate.push(chunk);
        if (safeText) emitAgent('agent:chunk', { text: safeText, agentName: 'Lumi' });
      }
    };
    turnAuthorization.assertCurrent();
    // Both transports use the same execution loop and conversational recovery.
    // Voice owns recognition, speech and presentation; it cannot independently
    // decide to repeat a tool, end an unfinished task or discard a receipt.
    markVoiceLatencyMilestone(requestId, 'firstModelRequestAt');
    const result = toolSessionActive
      ? await runToolSession({
        messages: messages,
        registry: toolRegistry,
        config: modelConfig,
        onToolCall: record => {
            toolResults.push(record);
            if (!isCurrentTurn() || isDirectDesktopTool(record.name)) return;
            emitToolLifecycle({
              correlationId: record.id || 'voice-tool-' + Date.now(),
              name: record.name,
              arguments: record.arguments || {},
              result: record.error ? undefined : formatToolResultForUi(record.result),
              error: record.error,
            });
          },
        maxIterations: maxIterations,
        onStreamChunk: onChunk,
        context: {
            ...toolContext,
            ...(runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall } : {}),
            priorToolRecords: taskAwareRecords(toolResults),
            onToolStart: call => {
              toolContext.onToolStart(call);
              if (!isCurrentTurn() || isDirectDesktopTool(call.name)) return;
              emitToolLifecycle({
                correlationId: call.id || 'voice-tool-' + Date.now(),
                name: call.name,
                arguments: call.arguments || {},
              });
            },
          },
        getters: llmGetters,
      })
      : await runConversationTurn({
          messages,
          config: modelConfig,
          onChunk,
          getters: llmGetters,
          isCancelled: () => !isCurrentTurn(),
          assertCurrent: () => turnAuthorization.assertCurrent(),
          taskText: userText,
        });
    if (!isCurrentTurn()) return;
    responseText = result.text || '';
    completionGuard = result.completionGuard;
    for (const usage of result.usageRecords) {
      recordTokenUsage(session.userId, usage.provider, usage.model, {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      }, requestId, 'voice');
    }

    if (!isCurrentTurn()) return;

    if (pendingConfirmationCreatedThisTurn) {
      responseText = trustedVoiceConfirmationText!;
    }

    modelTextGate.finish();
    const finalizedDesktopRecords = withDesktopExecutionReceipt(toolResults, desktopExecutionTracker);
    if (finalizedDesktopRecords.length > toolResults.length) {
      toolResults.push(...finalizedDesktopRecords.slice(toolResults.length));
    }
    let finalResponse: ReturnType<typeof finalizeLumiResponse> = pendingConfirmationCreatedThisTurn
      ? {
          text: trustedVoiceConfirmationText!,
          blocked: false,
          reason: 'waiting_confirmation',
        }
      : finalizeLumiResponse({
          taskText: actionIntentText,
          responseText,
          completionGuard,
          toolRecords: taskAwareRecords(toolResults),
          source: 'voice',
          flow: turnFlow,
          taskId: actionTaskExecution.state?.taskId,
          requestId,
        });
    const desktopPauseBlocksCurrentTask = (
      records = taskAwareRecords(toolResults),
    ) => {
      return shouldBlockForDesktopControlPause({
        pauseReason: desktopRelay.getControlPauseReason(),
        waitingForConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
        taskText: actionIntentText,
        toolRecords: records,
      });
    };
    if (desktopPauseBlocksCurrentTask()) {
      const pausePresentation = desktopPausePresentation();
      finalResponse = {
        ...finalResponse,
        text: pausePresentation.text,
        blocked: true,
        reason: pausePresentation.reason,
      };
    }
    const guardRecovery = await recoverBlockedExecutionOnce({
      task: routedUserText,
      responseText,
      finalization: finalResponse,
      allowToolUse: toolSessionActive,
      pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
      requiresFreshConfirmation: correctionRequiresFreshConfirmation,
      aborted: !isCurrentTurn() || desktopPauseBlocksCurrentTask(),
      // Losing the current voice turn is cancellation. A desktop pause is a
      // resumable customer-visible state and must not become AbortError.
      isAborted: () => !isCurrentTurn(),
      isPendingConfirmation: () => Boolean(pendingConfirmationCreatedThisTurn),
      toolRecords: taskAwareRecords(toolResults),
      attempt: async ({ instruction, priorToolRecords, recordTool }) => {
        logger.warn('[Audio] Recovering blocked execution internally.');
          turnAuthorization.assertCurrent();
      const recovery = await runToolSession({
        messages: [
              ...recoveryConversationMessages,
              { role: 'assistant', content: responseText },
              { role: 'user', content: instruction },
          ],
        registry: toolRegistry,
        config: {
            provider,
            model: effectiveModel,
            modelTurnState,
            userId: session.userId,
            domain: voiceScope.domain,
            orgId: voiceScope.orgId,
            signal: pipelineAbort.signal,
            inputTokenBudget: voiceInputTokenBudget,
            ...reasoningRoutePolicy,
          },
        onToolCall: record => {
            recordTool(record);
            if (isDirectDesktopTool(record.name)) return;
            emitToolLifecycle({
              correlationId: record.id || `voice-guard-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: record.name,
              arguments: record.arguments,
              result: record.error ? undefined : formatToolResultForUi(record.result),
              error: record.error,
            });
          },
        maxIterations: Math.max(2, Math.min(12, routedToolPolicy.maxIterations || maxIterations || 8)),
        context: {
            ...toolContext,
            ...(runtimeOwnedDeterministicRecoveryCall ? { runtimeOwnedDeterministicRecoveryCall } : {}),
            source: 'voice_guard_recovery',
            priorToolRecords,
            isCancelled: () => !isCurrentTurn(),
            onToolStart: call => {
              if (isDirectDesktopTool(call.name)) return;
              emitToolLifecycle({
                correlationId: call.id || `voice-guard-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: call.name,
                arguments: call.arguments,
              });
            },
          },
        getters: llmGetters,
      });
        for (const usage of recovery.usageRecords) {
          recordTokenUsage(
            session.userId,
            usage.provider,
            usage.model,
            {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            },
            `voice_guard_recovery_${Date.now()}`,
            'voice',
          );
        }
        return {
          text: recovery.text,
          completionGuard: recovery.completionGuard,
          toolRecords: withDesktopExecutionReceipt(recovery.toolCalls, desktopExecutionTracker),
        };
      },
      finalize: (candidateText, records, recoveryCompletionGuard) => {
        const recoveredRecords = taskAwareRecords(records);
        const candidate = pendingConfirmationCreatedThisTurn
          ? {
              text: trustedVoiceConfirmationText!,
              blocked: false,
              reason: 'waiting_confirmation',
            }
          : finalizeLumiResponse({
              taskText: actionIntentText,
              responseText: candidateText,
              completionGuard: recoveryCompletionGuard,
              toolRecords: recoveredRecords,
              source: 'voice_guard_recovery',
              flow: turnFlow,
              taskId: actionTaskExecution.state?.taskId,
              requestId,
            });
        if (!desktopPauseBlocksCurrentTask(recoveredRecords)) return candidate;
        const pausePresentation = desktopPausePresentation();
        return {
          ...candidate,
          text: pausePresentation.text,
          blocked: true,
          reason: pausePresentation.reason,
        };
      },
    });
    if (!isCurrentTurn()) return;
    finalResponse = guardRecovery.finalization;
    toolResults = withDesktopExecutionReceipt(guardRecovery.toolRecords, desktopExecutionTracker);
    responseText = finalResponse.text;
    if (finalResponse.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${finalResponse.reason}`);
    }

    let mainTerminalCommitted = false;
    if (responseText) {
      logger.info(`[Audio] Response: "${responseText.slice(0, 80)}" (${toolResults.length} tool calls)`);
      mainTerminalCommitted = await commitVoiceTerminal({
        text: responseText,
        source: "voice",
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
        cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : executionPipeline.normalizedIntent.kind,
        llmWasCalled: true,
        toolCalls: toolResults,
        speechText: responseText,
        notification: finalResponse.notification,
        persistTerminalState: () => {
          // commitVoiceTerminal consumes the receipts and blocks the task in
          // the same assistant write. Releasing the lease here would classify
          // these current receipts as stale and lose cross-channel progress.
          return persistVoiceTakeoverExecution(responseText, {
            toolRecords: toolResults,
            source: 'voice',
            sourceInteractionId: `voice_main_${Date.now()}`,
            finalizationBlocked: finalResponse.blocked,
            assistantTextTrusted: !finalResponse.blocked,
            finalizationReason: finalResponse.reason,
          });
        },
      });
    }

    // Candidate model text is never spoken before the strict
    // database and terminal-receipt fences have both committed.
    await Promise.allSettled(ttsPromises);
    if (!isCurrentTurn()) return;

    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    // The user, assistant, task writeback, and terminal receipt committed
    // before TTS. Playback or
    // disconnect failures must never make a completed/blocked task disappear.
    // Topic tracking — extract and record topics for cross-session continuity
    if (!finalResponse.blocked) {
      try {
        const topics = extractTopics(userText + ' ' + responseText);
        for (const topic of topics) {
          trackTopic(conv.id, topic);
        }
      } catch {}
    }
    // Text sentiment analysis on user input (matching chat.ts behavior)
    const textSentiment = extractSentiment(userText);
    if (textSentiment.valence !== 0 || textSentiment.urgency > 0 || textSentiment.frustration > 0) {
      try {
        const es = loadEmotionalState(voiceStateKey);
        const updated = updateEmotionalState(es, {
          type: 'sentiment_analysis',
          timestamp: new Date().toISOString(),
          userId: session.userId,
          sentiment: {
            valence: textSentiment.valence,
            frustration: textSentiment.frustration,
            urgency: textSentiment.urgency,
          },
        });
        saveEmotionalState(voiceStateKey, updated);
        try { const hm = loadHIMState(voiceStateKey); const { him: nh } = himTick(updated, hm); saveHIMState(voiceStateKey, nh); } catch {}
      } catch { /* best-effort */ }
    }
    if (mainTerminalCommitted && !finalResponse.blocked) {
      persistVoiceLearning(responseText, { toolRecords: toolResults, logLabel: 'voice' });
    }

  } catch (err: any) {
    if (isTtsCancellationError(err, pipelineAbort.signal)) {
      logger.info('[Audio] Pipeline aborted (barge-in or stop)');
    } else {
      logger.error("[Audio Error]:", err);
      if (finalAgentResponseDelivered) {
        logger.warn('[Audio] Post-response persistence failed; suppressing a contradictory UI error');
      } else {
        const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
        await commitVoiceTerminal({
          text: failureText,
          source: 'voice_error',
          blocked: true,
          reason: 'voice_processing_failed',
          cognitiveIntent: 'voice_processing_failed',
          llmWasCalled: false,
          toolCalls: toolResults,
          speechText: failureText,
        });
        await Promise.allSettled(ttsPromises);
      }
    }
  } finally {
    await releaseVoiceTurnResources('Voice model/tool pipeline reached its finally boundary.');
  }
}
export { respondAlongsideActiveVoiceWork } from "./voice_side_response";
